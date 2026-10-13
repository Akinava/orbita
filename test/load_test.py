"""Load test for the multiplayer server: connects bots that fly and shoot like real players.

The test creates its maps first (POST /api/maps, --create; or joins existing ones, --maps), then
each bot joins a map over /ws, reports its ship 15 times a second (as static/js/net.js does) and,
if it is a shooter, fires every 0.14 s. The bots are added in stages (--bots 10,30,60); after each
stage the test prints what the bots received and, with --pid, the server processes' CPU and output.

Signs of overload: snapshots per bot drop below 20/s, tick intervals (normally 50 ms) grow, server
CPU nears 100 % (one core: each server process, a shard of maps in Docker, is a single asyncio loop).
Example, see README:

    bin/python test/load_test.py --url ws://localhost:8000/ws --bots 10,30,60,100 --pid 12345
"""

import argparse
import asyncio
import json
import math
import multiprocessing
import os
import random
import ssl
import statistics
import time
import urllib.request
from collections import Counter

from websockets.asyncio.client import connect

STATE_INTERVAL = 1 / 15  # as in static/js/net.js
SHOT_INTERVAL = 0.14  # the client's fire rate
SNAP_PREFIX = '{"type": "snap"'  # json.dumps output of Room.step
CLK_TCK = os.sysconf("SC_CLK_TCK")


class Stats:
    def __init__(self):
        self.connected = 0
        self.errors = Counter()
        self.reset()

    def reset(self):
        self.msgs = 0
        self.bytes = 0
        self.snaps = 0
        self.intervals = []  # seconds between successive snapshots, per bot


def proc_sample(pids):
    """[(CPU seconds, bytes written)] of processes `pids`; the bytes include socket sends."""
    out = []
    for pid in pids:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        with open(f"/proc/{pid}/io") as f:
            io = dict(line.split(": ") for line in f.read().splitlines())
        out.append(((int(fields[11]) + int(fields[12])) / CLK_TCK, int(io["wchar"])))  # utime + stime
    return out


def client_cpu():
    t = os.times()
    return t.user + t.system


async def sender(ws, index, shooter, spread):
    """Flies a circle around a random point within `spread` of the station and reports it; shooters fire."""
    rnd = random.Random(index)
    center = (rnd.uniform(-spread, spread), rnd.uniform(-spread, spread) / 6, rnd.uniform(-spread, spread) - 3000)
    radius = rnd.uniform(300, 1500)
    omega = rnd.uniform(150, 300) / radius  # 150-300 m/s along the circle
    start = time.monotonic()

    def ship():
        a = (time.monotonic() - start) * omega
        pos = [center[0] + radius * math.cos(a), center[1], center[2] + radius * math.sin(a)]
        fwd = [-math.sin(a), 0.0, math.cos(a)]
        half = math.atan2(-fwd[0], -fwd[2]) / 2  # yaw that turns local -Z to fwd
        return pos, fwd, [0.0, round(math.sin(half), 4), 0.0, round(math.cos(half), 4)]

    async def report():
        while True:
            pos, _, quat = ship()
            await ws.send(json.dumps({
                "type": "state", "p": [round(x, 2) for x in pos], "q": quat,
                "a": True, "v": False, "t": False,
            }))
            await asyncio.sleep(STATE_INTERVAL)

    async def shoot():
        while True:
            pos, fwd, _ = ship()
            await ws.send(json.dumps({
                "type": "shot", "from": pos, "to": [p + 4000 * f for p, f in zip(pos, fwd)],
            }))
            await asyncio.sleep(SHOT_INTERVAL)

    await asyncio.sleep(rnd.random() * STATE_INTERVAL)  # spread the bots' reports in time
    await asyncio.gather(report(), *([shoot()] if shooter else []))


async def receiver(ws, stats):
    last = None
    async for msg in ws:
        stats.msgs += 1
        stats.bytes += len(msg)
        if msg.startswith(SNAP_PREFIX):
            now = time.monotonic()
            stats.snaps += 1
            if last is not None:
                stats.intervals.append(now - last)
            last = now


async def bot(index, args, stats, ssl_ctx):
    map_id = args.maps[index % len(args.maps)]
    shooter = random.Random(f"fire-{index}").random() < args.fire
    extra = {"ssl": ssl_ctx} if ssl_ctx else {}
    joined = False
    try:
        async with connect(f"{args.url}?map={map_id}", max_size=None, open_timeout=15, **extra) as ws:
            joined = True
            stats.connected += 1
            await ws.send(json.dumps({"type": "hello", "name": f"Bot-{index}"}))
            await asyncio.gather(sender(ws, index, shooter, args.spread), receiver(ws, stats))
    except asyncio.CancelledError:
        raise
    except Exception as e:
        stats.errors[type(e).__name__] += 1
    finally:
        if joined:
            stats.connected -= 1


def percentile(values, q):
    return statistics.quantiles(values, n=100)[q - 1] if len(values) >= 2 else math.nan


async def run_share(args, share, barrier, results):
    """Runs bots number share, share + procs, ... of each stage and reports every stage's measurements.

    The stage windows of all the test processes and of the parent are lined up by `barrier`.
    """
    ssl_ctx = None
    if args.url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if args.insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    stats = Stats()
    tasks = []
    created = share  # global index of this share's next bot
    try:
        for target in args.bots:
            while created < target:
                tasks.append(asyncio.create_task(bot(created, args, stats, ssl_ctx)))
                created += args.procs
                await asyncio.sleep(0.01 * args.procs)
            await asyncio.sleep(args.warmup)
            await asyncio.to_thread(barrier.wait)

            stats.reset()
            t0, cpu0 = time.monotonic(), client_cpu()
            await asyncio.sleep(args.duration)
            await asyncio.to_thread(barrier.wait)
            results.put({
                "dt": time.monotonic() - t0, "cpu": client_cpu() - cpu0, "connected": stats.connected,
                "snaps": stats.snaps, "msgs": stats.msgs, "bytes": stats.bytes,
                "intervals": stats.intervals, "errors": dict(stats.errors),
            })
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def share_process(args, share, barrier, results):
    try:
        asyncio.run(run_share(args, share, barrier, results))
    except KeyboardInterrupt:
        pass


def create_maps(args, ssl_ctx):
    """Make --create maps of --type through the server's /api/maps (open to guests only when the server
    allows them, see README) and return their ids."""
    base = args.url.replace("ws", "http", 1).rsplit("/ws", 1)[0]
    ids = []
    for _ in range(args.create):
        req = urllib.request.Request(
            f"{base}/api/maps", data=json.dumps({"type": args.type, "name": "load test"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, context=ssl_ctx) as r:
            ids.append(json.load(r)["id"])
    return ids


def main(args):
    if not args.maps:
        ssl_ctx = None
        if args.url.startswith("wss") and args.insecure:
            ssl_ctx = ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
        args.maps = create_maps(args, ssl_ctx)
    ctx = multiprocessing.get_context("spawn")
    barrier = ctx.Barrier(args.procs + 1)
    results = ctx.Queue()
    procs = [ctx.Process(target=share_process, args=(args, i, barrier, results)) for i in range(args.procs)]
    for proc in procs:
        proc.start()

    print(
        f"maps {','.join(args.maps)}, shooters {args.fire:.0%}, spread {args.spread:g} m, "
        f"{args.duration:g} s per stage, {args.procs} test process(es)"
    )
    print(
        f"{'bots':>5} {'conn':>5} {'snap/s':>7} {'tick p50':>9} {'p95':>6} {'max':>6} "
        f"{'recv Mbit/s':>12} {'msg/s':>8} {'srv CPU':>8} {'srv out Mbit/s':>15} {'test CPU':>9}  errors"
    )
    try:
        for target in args.bots:
            barrier.wait()
            t0, srv0 = time.monotonic(), proc_sample(args.pid)
            barrier.wait()
            dt, srv1 = time.monotonic() - t0, proc_sample(args.pid)
            shares = [results.get() for _ in procs]

            connected = sum(r["connected"] for r in shares)
            ms = [x * 1000 for r in shares for x in r["intervals"]]
            snap_rate = sum(r["snaps"] for r in shares) / dt / connected if connected else 0
            if srv0:  # CPU of the busiest process (each is limited to one core), output of them all
                cpu = max(b[0] - a[0] for a, b in zip(srv0, srv1)) / dt
                out = sum(b[1] - a[1] for a, b in zip(srv0, srv1)) * 8 / dt / 1e6
                srv = f"{cpu:8.0%} {out:15.1f}"
            else:
                srv = f"{'-':>8} {'-':>15}"
            errors = Counter()
            for r in shares:
                errors.update(r["errors"])
            print(
                f"{target:>5} {connected:>5} {snap_rate:>7.1f} {percentile(ms, 50):>9.0f} "
                f"{percentile(ms, 95):>6.0f} {max(ms, default=math.nan):>6.0f} "
                f"{sum(r['bytes'] for r in shares) * 8 / dt / 1e6:>12.1f} "
                f"{sum(r['msgs'] for r in shares) / dt:>8.0f} {srv} "
                f"{max(r['cpu'] / r['dt'] for r in shares):>9.0%}  "  # the busiest test process
                + (", ".join(f"{k}: {v}" for k, v in errors.items()) or "-"),
                flush=True,
            )
    finally:
        for proc in procs:
            proc.terminate()
            proc.join()


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="ws://localhost:8000/ws", help="WebSocket endpoint (ws:// or wss://)")
    p.add_argument("--bots", default="10,30,60", help="bot counts of successive stages, e.g. 10,30,60,100")
    p.add_argument("--maps", default="", help="ids of existing maps the bots are spread over, round robin")
    p.add_argument("--create", type=int, default=3, help="without --maps: maps to create for the test")
    p.add_argument("--type", default="farm", help="type of the maps created (app/modes.py)")
    p.add_argument("--fire", type=float, default=0.3, help="share of bots that keep shooting, 0..1")
    p.add_argument("--spread", type=float, default=3000, help="bots fly within this many metres of the station")
    p.add_argument("--duration", type=float, default=15, help="seconds measured per stage")
    p.add_argument("--warmup", type=float, default=3, help="seconds after adding bots before measuring")
    p.add_argument(
        "--procs", type=int, default=1,
        help="test processes the bots are divided between; add more when test CPU nears 100 %%",
    )
    p.add_argument(
        "--pid", default="",
        help="server process ids, comma-separated (Linux, same machine): report the CPU of the busiest one "
        "and the output of them all",
    )
    p.add_argument("--insecure", action="store_true", help="wss: do not verify the certificate")
    args = p.parse_args()
    args.bots = sorted(int(x) for x in args.bots.split(","))
    args.maps = [m for m in args.maps.split(",") if m]
    args.pid = [int(x) for x in args.pid.split(",") if x]
    return args


if __name__ == "__main__":
    try:
        main(parse_args())
    except KeyboardInterrupt:
        pass
