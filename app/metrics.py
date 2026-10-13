"""Server metrics for Prometheus: GET /metrics with the token METRICS_TOKEN (shadow/auth.env or the
environment) as "Authorization: Bearer <token>"; without the setting the endpoint does not exist.

Every process measures its own simulation loop (app/main.py simulate) and WebSocket traffic
(app/room.py) and sums them up once a WINDOW: step time (mean, p95, max against the TICK budget), how
often the loop fell behind, bytes sent per second. The process that answers /metrics ("web" in Docker)
collects these reports from the shards (/internal/metrics) together with their maps and pilots, reads
the CPU and memory of every container, and renders the text once a WINDOW as well; Prometheus gets that
cached text however often it scrapes.

Containers: each service of docker/game/docker-compose.yml runs in a systemd slice of its own
(cgroup_parent "orbita-<service>.slice"), and the host's cgroup tree is mounted at CGROUP_ROOT, so the
usage of a service is read from its slice, restarts included. Without that tree (no Docker) there are
no container metrics.
"""

import asyncio
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import HTTPException, Request
from fastapi.responses import PlainTextResponse

from app import settings

WINDOW = 60  # seconds between reports
CGROUP_ROOT = Path(os.environ.get("ORBITA_CGROUP_ROOT", "/host/cgroup"))
SLICE = "orbita"  # services' slices: orbita.slice/.../orbita-<service>.slice
log = logging.getLogger("orbita.metrics")


# --- this process: loop and traffic -----------------------------------------------------------------
class Window:
    def __init__(self):
        self.started = time.monotonic()
        self.steps: list[float] = []
        self.behind = 0
        self.sent = 0


current = Window()
last: dict | None = None  # the latest finished window
behind_total = 0
sent_total = 0


def step(seconds: float, behind: bool):
    """One pass of the simulation loop over all maps took `seconds`; `behind`: it had fallen behind."""
    global behind_total
    current.steps.append(seconds)
    if behind:
        current.behind += 1
        behind_total += 1


def sent(nbytes: int):
    global sent_total
    current.sent += nbytes
    sent_total += nbytes


def roll():
    global current, last
    w, current = current, Window()
    elapsed = current.started - w.started
    steps = sorted(w.steps)
    last = {
        "steps": len(steps),
        "step_mean": sum(steps) / len(steps) if steps else 0.0,
        "step_p95": steps[min(len(steps) - 1, int(len(steps) * 0.95))] if steps else 0.0,
        "step_max": steps[-1] if steps else 0.0,
        "behind": w.behind,
        "sent_per_second": w.sent / elapsed if elapsed > 0 else 0.0,
    }


def report(maps: int, players: int) -> dict:
    """This process's numbers for the collector (/internal/metrics)."""
    return {"maps": maps, "players": players, "window": last, "behind_total": behind_total, "sent_total": sent_total}


# --- containers -------------------------------------------------------------------------------------
cpu_seen: dict[str, tuple[float, float]] = {}  # container -> (monotonic time, CPU seconds) at the last read


def containers() -> dict[str, dict]:
    """CPU seconds, CPU cores used since the last read, memory and its limit of each service's slice."""
    top = CGROUP_ROOT / f"{SLICE}.slice"
    out = {}
    if not top.is_dir():
        return out
    now = time.monotonic()
    for path in top.rglob(f"{SLICE}-*.slice"):
        if not any(path.glob("docker-*.scope")):
            continue  # an intermediate slice (orbita-map.slice holds the shards)
        name = path.name.removeprefix(f"{SLICE}-").removesuffix(".slice")
        try:
            stat = dict(line.split() for line in (path / "cpu.stat").read_text().splitlines())
            cpu = int(stat["usage_usec"]) / 1e6
            memory = int((path / "memory.current").read_text())
            limit = (path / "memory.max").read_text().strip()
        except (OSError, KeyError, ValueError):
            log.exception("could not read the cgroup of %s", name)
            continue
        cores = None
        if (prev := cpu_seen.get(name)) and now > prev[0] and cpu >= prev[1]:
            cores = (cpu - prev[1]) / (now - prev[0])
        cpu_seen[name] = (now, cpu)
        out[name] = {"cpu": cpu, "cores": cores, "memory": memory, "limit": None if limit == "max" else int(limit)}
    return out


# --- exposition -------------------------------------------------------------------------------------
METRICS = {  # name: (type, help)
    "orbita_up": ("gauge", "1 when the shard answered the last collection"),
    "orbita_step_budget_seconds": ("gauge", "Time budget of one simulation step (TICK)"),
    "orbita_step_seconds_mean": ("gauge", "Mean duration of a simulation step over the last minute"),
    "orbita_step_seconds_p95": ("gauge", "95th percentile of the simulation step duration over the last minute"),
    "orbita_step_seconds_max": ("gauge", "Longest simulation step over the last minute"),
    "orbita_steps": ("gauge", "Simulation steps in the last minute"),
    "orbita_fell_behind": ("gauge", "Times the simulation loop fell behind schedule in the last minute"),
    "orbita_fell_behind_total": ("counter", "Times the simulation loop fell behind schedule since the start"),
    "orbita_maps": ("gauge", "Maps open on the shard"),
    "orbita_players": ("gauge", "Pilots connected to the shard"),
    "orbita_ws_sent_bytes_per_second": ("gauge", "WebSocket bytes sent per second over the last minute"),
    "orbita_ws_sent_bytes_total": ("counter", "WebSocket bytes sent since the start"),
    "orbita_container_cpu_seconds_total": ("counter", "CPU time used by the container's service"),
    "orbita_container_cpu_cores": ("gauge", "CPU cores used by the container's service over the last minute"),
    "orbita_container_memory_bytes": ("gauge", "Memory used by the container's service"),
    "orbita_container_memory_limit_bytes": ("gauge", "Memory limit of the container's service"),
    "orbita_metrics_updated_timestamp_seconds": ("gauge", "Unix time of the last collection"),
}


def render(budget: float, shards: dict[str, dict | None], boxes: dict[str, dict]) -> str:
    samples: dict[str, list[str]] = {name: [] for name in METRICS}

    def put(name, value, **labels):
        if value is not None:
            tags = ",".join(f'{k}="{v}"' for k, v in labels.items())
            value = repr(round(value, 6) if isinstance(value, float) else value)
            samples[name].append(f"{name}{{{tags}}} {value}" if tags else f"{name} {value}")

    put("orbita_step_budget_seconds", budget)
    for shard, r in shards.items():
        put("orbita_up", 1 if r else 0, shard=shard)
        if not r:
            continue
        put("orbita_maps", r["maps"], shard=shard)
        put("orbita_players", r["players"], shard=shard)
        put("orbita_fell_behind_total", r["behind_total"], shard=shard)
        put("orbita_ws_sent_bytes_total", r["sent_total"], shard=shard)
        if w := r["window"]:
            put("orbita_step_seconds_mean", w["step_mean"], shard=shard)
            put("orbita_step_seconds_p95", w["step_p95"], shard=shard)
            put("orbita_step_seconds_max", w["step_max"], shard=shard)
            put("orbita_steps", w["steps"], shard=shard)
            put("orbita_fell_behind", w["behind"], shard=shard)
            put("orbita_ws_sent_bytes_per_second", w["sent_per_second"], shard=shard)
    for name, c in sorted(boxes.items()):
        put("orbita_container_cpu_seconds_total", c["cpu"], container=name)
        put("orbita_container_cpu_cores", c["cores"], container=name)
        put("orbita_container_memory_bytes", c["memory"], container=name)
        put("orbita_container_memory_limit_bytes", c["limit"], container=name)
    put("orbita_metrics_updated_timestamp_seconds", time.time())
    lines = []
    for name, (kind, text) in METRICS.items():
        if samples[name]:
            lines += [f"# HELP {name} {text}", f"# TYPE {name} {kind}", *samples[name]]
    return "\n".join(lines) + "\n"


# --- the endpoint -----------------------------------------------------------------------------------
Collect = Callable[[], Awaitable[dict[str, dict | None]]]
text: str | None = None
collector: asyncio.Task | None = None
ready = asyncio.Event()  # the first text is there


async def collect_every_window(budget: float, collect: Collect):
    global text
    while True:
        try:
            text = render(budget, await collect(), containers())
        except Exception:
            log.exception("could not collect the metrics")
        ready.set()
        await asyncio.sleep(WINDOW)


async def run():
    """This process's windows, one every WINDOW seconds."""
    while True:
        await asyncio.sleep(WINDOW)
        roll()


async def exposition(request: Request, budget: float, collect: Collect) -> PlainTextResponse:
    """The /metrics answer. The collection starts with the first authorized request, so only the
    process that receives them (web) collects."""
    global collector
    token = settings.get("METRICS_TOKEN")
    if not token:
        raise HTTPException(404, "Not Found")
    scheme, _, given = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(given.encode(), token.encode()):
        raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
    if collector is None:
        collector = asyncio.create_task(collect_every_window(budget, collect))
    await ready.wait()
    return PlainTextResponse(text or "", media_type="text/plain; version=0.0.4")
