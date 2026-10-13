"""Pilot statistics, counted by the game server from what it sees happen on the map.

Only signed-in pilots are counted. Each process collects the changes in memory and adds them to the
player_stats table every FLUSH_INTERVAL seconds and at shutdown; while the database is unreachable
they wait for the next flush.
"""

import asyncio
import logging
from collections import defaultdict

from app import db

FLUSH_INTERVAL = 30  # seconds
XP = {"pvp_kills": 250, "pirate_kills": 100, "asteroid_kills": 10}  # experience per kill, as the client scores
FIELDS = ("xp", "flight_seconds", "pvp_kills", "pirate_kills", "asteroid_kills", "deaths")
log = logging.getLogger("orbita.stats")

pending: dict[int, dict[str, float]] = defaultdict(lambda: dict.fromkeys(FIELDS, 0))


def add(account: int | None, field: str, amount: float = 1):
    """Count `amount` of `field` for a pilot (kills also bring their experience)."""
    if account is None:
        return
    row = pending[account]
    row[field] += amount
    row["xp"] += XP.get(field, 0) * amount


async def totals(account: int) -> tuple[int, int]:
    """A pilot's all-time (experience, victories), what is still waiting to be saved included."""
    row = await db.pool.fetchrow(
        "SELECT xp, pvp_kills + pirate_kills AS wins FROM player_stats WHERE user_id = $1", account
    ) if db.pool is not None else None
    extra = pending.get(account, {})
    xp = (row["xp"] if row else 0) + extra.get("xp", 0)
    wins = (row["wins"] if row else 0) + extra.get("pvp_kills", 0) + extra.get("pirate_kills", 0)
    return round(xp), round(wins)


async def flush():
    if not pending or db.pool is None:
        return
    batch = dict(pending)
    pending.clear()
    ids = list(batch)
    columns = [[batch[i][f] for i in ids] for f in FIELDS]
    try:
        # Pilots deleted meanwhile are skipped by the join
        await db.pool.execute(
            "INSERT INTO player_stats (user_id, xp, flight_seconds, pvp_kills, pirate_kills, asteroid_kills, deaths)"
            " SELECT d.* FROM unnest($1::bigint[], $2::bigint[], $3::float8[], $4::int[], $5::int[], $6::int[], $7::int[])"
            "   AS d(user_id, xp, flight_seconds, pvp_kills, pirate_kills, asteroid_kills, deaths)"
            " JOIN users u ON u.id = d.user_id"
            " ON CONFLICT (user_id) DO UPDATE SET"
            "   xp = player_stats.xp + EXCLUDED.xp,"
            "   flight_seconds = player_stats.flight_seconds + EXCLUDED.flight_seconds,"
            "   pvp_kills = player_stats.pvp_kills + EXCLUDED.pvp_kills,"
            "   pirate_kills = player_stats.pirate_kills + EXCLUDED.pirate_kills,"
            "   asteroid_kills = player_stats.asteroid_kills + EXCLUDED.asteroid_kills,"
            "   deaths = player_stats.deaths + EXCLUDED.deaths,"
            "   updated_at = now()",
            ids, *[[round(v) for v in c] if f != "flight_seconds" else c for f, c in zip(FIELDS, columns)],
        )
    except Exception:
        log.exception("could not save statistics; keeping them for the next try")
        for account, row in batch.items():
            for f, v in row.items():
                pending[account][f] += v


async def run():
    """Flush every FLUSH_INTERVAL seconds, and once more when cancelled (shutdown)."""
    try:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            await flush()
    except asyncio.CancelledError:
        await flush()
        raise
