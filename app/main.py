import asyncio
import itertools
import json
import logging
import os
import random
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnected

from app import auth, db, metrics, profile, stats
from app.modes import MODES
from app.room import Player, Room
from app.turn import ice_servers

STATIC_DIR = Path(__file__).parent / "static"
MUSIC_DIR = STATIC_DIR / "music"  # one folder of tracks per mood: login, profile, farming, battle (js/music.js)
MUSIC_TYPES = {".mp3", ".ogg", ".m4a", ".opus", ".wav"}

# Multiplayer: the server hosts maps that players create on the fly, of the types in app/modes.py; each
# map is a Room (app/room.py) with its own pilots and world. A map nobody has been on for EMPTY_TTL
# seconds is closed; empty and full maps are not listed.
# Shards: in Docker the maps run in several processes ("shards", one CPU core each, see
# docker/game/docker-compose.yml). ORBITA_SHARD names this process's shard, ORBITA_SHARDS lists them all
# for the process that serves the game files and the map list ("web", ORBITA_SHARD=""), and
# ORBITA_MAP_URL ("http://map-{shard}:8000") tells it how to reach them (/internal/maps). A map's id
# starts with its shard ("alpha-3f9c..."), so nginx routes /ws?map=<id> to the right process. Without
# these variables one process does everything (shard "local").
SHARD = os.environ.get("ORBITA_SHARD", "local")
SHARDS = tuple(s for s in os.environ.get("ORBITA_SHARDS", SHARD).split(",") if s)
MAP_URL = os.environ.get("ORBITA_MAP_URL")
TICK = 0.05  # seconds per simulation step and snapshot
EMPTY_TTL = 60  # seconds an empty map waits for its pilots (a reconnect, the creator) before it closes
MAX_ROOMS = 300  # maps per shard
LIST_SIZE = 10  # maps of a type in the menu, the most populated first
MAP_NAME_MAX = 16
# Pilot names: a pilot signed in (session cookie, app/auth.py) always flies under their account's name;
# a guest picks a name, but one that belongs to an account turns into "Pilot-<id>".
# One account, one ship: when a pilot joins with an account that is already in the game (another tab,
# device or map), the older connection is closed with KICK_CODE, on whichever process it is; the
# processes tell each other through the database (db.notify), and the client does not reconnect.
log = logging.getLogger("orbita.game")
PROCESS = secrets.token_hex(4)  # with the player id, tells connections of different processes apart
KICK_CHANNEL = "orbita_kick"
KICK_CODE = 4001
# Without an account there is no game (unless auth.guests_allowed()): the connection is closed with
# SIGN_IN_CODE and the client sends the pilot to the sign-in page. While the database is unreachable
# nobody can be checked: ACCOUNTS_DOWN_CODE, and the client tries again like after any lost connection.
SIGN_IN_CODE = 4401
ACCOUNTS_DOWN_CODE = 4503
NO_MAP_CODE = 4404  # the map was closed (or never was): back to the menu
FULL_CODE = 4409


rooms: dict[str, Room] = {}
player_ids = itertools.count(1)
closing: set[asyncio.Task] = set()  # kicks and saves in progress (keeps the tasks referenced)


async def close_kicked(ws: WebSocket):
    try:
        await ws.close(code=KICK_CODE, reason="signed in elsewhere")
    except Exception:
        pass  # already gone


def kick_others(account: int, keep: str):
    """Close this process's connections of `account`, except the one with the key `keep`."""
    for room in rooms.values():
        for p in room.players.values():
            if p.account == account and p.key != keep:
                task = asyncio.create_task(close_kicked(p.ws))
                closing.add(task)
                task.add_done_callback(closing.discard)


def on_kick(payload: str):
    try:
        msg = json.loads(payload)
        kick_others(int(msg["account"]), str(msg["keep"]))
    except (ValueError, KeyError, TypeError):
        log.warning("bad kick message %r", payload)


db.on_notify(KICK_CHANNEL, on_kick)


async def simulate():
    """Simulation and snapshot loop for all maps, on a fixed TICK schedule however long a step takes."""
    last = deadline = time.monotonic()
    while True:
        deadline += TICK
        await asyncio.sleep(max(0.0, deadline - time.monotonic()))
        now = time.monotonic()
        behind = now - deadline > TICK
        if behind:
            deadline = now  # fell behind: carry on from now rather than send a burst of catch-up ticks
        dt, last = min(now - last, 0.2), now
        for room in list(rooms.values()):
            if not room.players and now - room.empty_since > EMPTY_TTL:
                del rooms[room.id]
                continue
            await room.step(dt)
        metrics.step(time.monotonic() - now, behind)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.start()  # accounts: only with DATABASE_URL; the game runs on without the database
    tasks = [asyncio.create_task(t) for t in (simulate(), stats.run(), metrics.run())]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)  # stats.run saves what is left
    await db.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(auth.router)
app.include_router(profile.router)


# --- Maps ------------------------------------------------------------------------------------------
class NewMap(BaseModel):
    type: str
    private: bool = False
    name: str = ""


def create_room(form: NewMap) -> Room:
    """A new map on this process's shard."""
    if not SHARD or form.type not in MODES:
        raise HTTPException(404, "unknown")
    if len(rooms) >= MAX_ROOMS:
        raise HTTPException(503, "busy")
    while (map_id := f"{SHARD}-{secrets.token_hex(6)}") in rooms:
        pass
    room = Room(map_id, MODES[form.type], " ".join(form.name.split())[:MAP_NAME_MAX], form.private)
    rooms[map_id] = room
    return room


@app.get("/internal/maps")
async def internal_maps():
    """All maps of this process, private ones included (for web; nginx keeps /internal/ to itself)."""
    return [r.info() for r in rooms.values()]


@app.post("/internal/maps")
async def internal_create(form: NewMap):
    return create_room(form).info()


def own_metrics() -> dict:
    return metrics.report(len(rooms), sum(len(r.players) for r in rooms.values()))


@app.get("/internal/metrics")
async def internal_metrics():
    """This process's loop, traffic and load for /metrics of web."""
    return own_metrics()


async def shard_maps(client: httpx.AsyncClient, shard: str) -> list[dict] | None:
    """The maps of `shard`, or None when it does not answer."""
    if shard == SHARD:
        return [r.info() for r in rooms.values()]
    if not MAP_URL:
        return None
    try:
        r = await client.get(MAP_URL.format(shard=shard) + "/internal/maps")
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


@app.get("/api/maps")
async def list_maps(type: str):
    """Up to LIST_SIZE public maps of a type that have pilots and room for more, the busiest first."""
    if type not in MODES:
        raise HTTPException(404, "unknown")
    async with httpx.AsyncClient(timeout=1) as client:
        found = await asyncio.gather(*(shard_maps(client, s) for s in SHARDS))
    maps = [
        m for shard in found for m in shard or []
        if m["type"] == type and not m["private"] and 0 < m["players"] < m["max"]
    ]
    maps.sort(key=lambda m: -m["players"])
    return maps[:LIST_SIZE]


@app.get("/api/maps/{map_id}")
async def map_info(map_id: str):
    """One map by its id, private ones included (a shared link)."""
    shard = map_id.split("-", 1)[0]
    if shard not in SHARDS:
        raise HTTPException(404, "not_found")
    async with httpx.AsyncClient(timeout=1) as client:
        found = await shard_maps(client, shard)
    if found is None:
        raise HTTPException(503, "unavailable")
    if not (m := next((m for m in found if m["id"] == map_id), None)):
        raise HTTPException(404, "not_found")
    return m


@app.post("/api/maps")
async def new_map(form: NewMap, request: Request):
    """Create a map on the least busy shard; the creator then joins it over /ws."""
    if form.type not in MODES:
        raise HTTPException(404, "unknown")
    try:
        user = await auth.current_user(request)
    except Exception:
        raise HTTPException(503, "unavailable") from None
    if not user and not auth.guests_allowed():
        raise HTTPException(401, "signed_out")
    form.name = user["display_name"] if user else form.name
    async with httpx.AsyncClient(timeout=2) as client:
        found = await asyncio.gather(*(shard_maps(client, s) for s in SHARDS))
        loads = sorted(
            (sum(m["players"] for m in maps) + len(maps), random.random(), shard)
            for shard, maps in zip(SHARDS, found) if maps is not None
        )
        if not loads:
            raise HTTPException(503, "unavailable")
        shard = loads[0][2]
        if shard == SHARD:
            return create_room(form).info()
        try:
            r = await client.post(MAP_URL.format(shard=shard) + "/internal/maps", json=form.model_dump())
        except Exception:
            raise HTTPException(503, "unavailable") from None
        if r.status_code != 200:
            raise HTTPException(r.status_code, r.json().get("detail", "unavailable"))
        return r.json()


async def shard_metrics() -> dict[str, dict | None]:
    """The metrics report of each shard, None for one that does not answer."""

    async def one(client, shard):
        if shard == SHARD:
            return own_metrics()
        try:
            r = await client.get(MAP_URL.format(shard=shard) + "/internal/metrics")
            r.raise_for_status()
            return r.json()
        except Exception:
            return None

    async with httpx.AsyncClient(timeout=2) as client:
        return dict(zip(SHARDS, await asyncio.gather(*(one(client, s) for s in SHARDS))))


@app.get("/metrics")
async def prometheus(request: Request):
    """Prometheus metrics, refreshed once a minute (app/metrics.py); needs METRICS_TOKEN."""
    return await metrics.exposition(request, TICK, shard_metrics)


@app.get("/api/music")
async def music():
    """Track URLs by folder of static/music, read on each request so new files need no restart."""
    out = {}
    for folder in sorted(p for p in MUSIC_DIR.iterdir() if p.is_dir()) if MUSIC_DIR.is_dir() else []:
        tracks = sorted(f.name for f in folder.iterdir() if f.suffix.lower() in MUSIC_TYPES)
        out[folder.name] = [f"/music/{quote(folder.name)}/{quote(name)}" for name in tracks]
    return out


@app.get("/ice")
async def ice():
    """ICE servers for voice chat, with fresh TURN credentials when coturn is configured."""
    return {"iceServers": ice_servers()}


@app.websocket("/ws")
async def multiplayer(ws: WebSocket, map_id: str = Query("", alias="map")):
    await ws.accept()  # before closing, or the browser sees a failed handshake instead of the code
    room = rooms.get(map_id)
    if room is None:
        await ws.close(code=NO_MAP_CODE, reason="no such map")
        return
    pid = next(player_ids)
    player = Player(pid, ws, f"{PROCESS}:{pid}")
    checked = db.pool is not None
    try:
        if user := await auth.current_user(ws):
            player.account, player.account_name = user["id"], user["display_name"]
    except Exception:
        log.exception("session check failed")
        checked = False
    if not player.account and not auth.guests_allowed():
        if checked:
            await ws.close(code=SIGN_IN_CODE, reason="sign in to play")
        else:
            await ws.close(code=ACCOUNTS_DOWN_CODE, reason="accounts unavailable")
        return
    if room.full or rooms.get(map_id) is not room:  # filled up or closed while we checked the session
        await ws.close(code=FULL_CODE if room.full else NO_MAP_CODE, reason="map unavailable")
        return
    if player.account:
        kick_others(player.account, player.key)  # here at once, the other processes through the database
        try:
            await db.notify(KICK_CHANNEL, json.dumps({"account": player.account, "keep": player.key}))
        except Exception:
            log.exception("could not tell the other processes about %s", player.key)
        if room.mode.id == "farm":
            # The info panel of farming maps shows the pilot's all-time score and victories
            try:
                player.score, player.wins = await stats.totals(player.account)
            except Exception:
                log.exception("could not read the statistics of %s", player.account)
    room.join(player)
    await room.send(player, room.welcome(player))
    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(msg, dict):
                await room.handle(player, msg)
    except (WebSocketDisconnect, WebSocketDisconnected):  # the latter when a failed send noticed it first
        pass
    finally:
        room.leave(player)
        await room.broadcast({"type": "leave", "id": player.id, "name": player.name})
        if player.account:
            # Save now, so the next map (maybe on another shard) shows the pilot's totals up to date
            task = asyncio.create_task(stats.flush())
            closing.add(task)
            task.add_done_callback(closing.discard)


class GameFiles(StaticFiles):
    """Static files that the browser revalidates on every load (a cheap 304 by ETag when unchanged), so an
    update reaches players without clearing the cache. Music never changes under the same name: cached for
    a month."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        music = Path(full_path).is_relative_to(MUSIC_DIR)
        response.headers["Cache-Control"] = "public, max-age=2592000" if music else "no-cache"
        return response


# The WebVR game is a static site; mount it last so API routes declared above take precedence.
app.mount("/", GameFiles(directory=STATIC_DIR, html=True), name="static")
