"""Pilot profiles: public, so anyone can look at a pilot's name, avatar and statistics (static/profile.html),
and the leaderboards by experience, flight time and victories (static/leaders.html).

Pilots are shown by users.public_id (a random UUID, migration 0007), never by users.id, so they cannot be
listed by counting ids.

The signed-in owner of a profile changes the name there (POST /auth/name, app/auth.py) and the avatar
(here). The page crops and scales the picture to AVATAR_SIZE; the server only accepts PNG, JPEG or WebP
files (checked by their content) up to AVATAR_MAX_BYTES and keeps them in the avatars table.
"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response

from app import auth, db

router = APIRouter()

LEADERS = 100  # pilots on a leaderboard
# Leaderboard -> what it ranks by, as an SQL expression over player_stats aliased {t}; the expressions
# match the indexes of migrations 0004-0006.
BOARDS = {"xp": "{t}.xp", "flight": "{t}.flight_seconds", "wins": "({t}.pvp_kills + {t}.pirate_kills)"}
AVATAR_SIZE = 256  # px, done by the page
AVATAR_MAX_BYTES = 256 * 1024
SIGNATURES = (  # file start -> type; WebP is RIFF....WEBP
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def image_type(data: bytes) -> str | None:
    for magic, kind in SIGNATURES:
        if data.startswith(magic):
            return kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def pool():
    if db.pool is None:
        raise HTTPException(503, "unavailable")
    return db.pool


@router.get("/api/profile")
async def get_profile(request: Request, id: str | None = None, name: str | None = None):
    """A pilot by public id or name; without either, the signed-in pilot's own profile."""
    me = await auth.current_user(request)
    if id is not None:
        try:
            id = UUID(id)
        except ValueError:
            raise HTTPException(404, "not_found") from None
    elif not name:
        if not me:
            raise HTTPException(401, "signed_out")
        id = me["public_id"]
    row = await pool().fetchrow(
        "SELECT u.id, u.public_id, u.display_name, u.created_at, a.updated_at AS avatar_at, s.xp, s.flight_seconds,"
        "  s.pvp_kills, s.pirate_kills, s.asteroid_kills, s.deaths"
        " FROM users u LEFT JOIN avatars a ON a.user_id = u.id LEFT JOIN player_stats s ON s.user_id = u.id"
        " WHERE " + ("u.public_id = $1" if id is not None else "lower(u.display_name) = lower($1)"),
        id if id is not None else name,
    )
    if not row:
        raise HTTPException(404, "not_found")
    pvp, pirates, deaths = row["pvp_kills"] or 0, row["pirate_kills"] or 0, row["deaths"] or 0
    return {
        "id": str(row["public_id"]),
        "name": row["display_name"],
        "since": row["created_at"].isoformat(),
        "avatar": avatar_url(row["public_id"], row["avatar_at"]),
        "me": bool(me) and me["id"] == row["id"],
        "stats": {
            "xp": row["xp"] or 0,
            "flightSeconds": round(row["flight_seconds"] or 0),
            "wins": pvp + pirates,  # ships shot down, pilots and pirates together
            "losses": deaths,
            "asteroidKills": row["asteroid_kills"] or 0,
        },
    }


def avatar_url(public_id: UUID, at) -> str | None:
    return f"/avatar/{public_id}?v={int(at.timestamp())}" if at else None


def leader(row) -> dict:
    return {
        "rank": row["rank"], "id": str(row["public_id"]), "name": row["display_name"],
        "avatar": avatar_url(row["public_id"], row["avatar_at"]),
        "xp": row["xp"], "flightSeconds": round(row["flight_seconds"]),
        "wins": row["pvp_kills"] + row["pirate_kills"], "losses": row["deaths"],
    }


LEADER_COLUMNS = (
    "s.user_id, u.public_id, u.display_name, a.updated_at AS avatar_at, s.xp, s.flight_seconds, s.pvp_kills, s.pirate_kills, s.deaths"
)


@router.get("/api/leaders")
async def leaders(request: Request, by: Literal["xp", "flight", "wins"] = "xp"):
    """The top LEADERS pilots by experience, flight time or victories (ties: who registered first), and
    the signed-in pilot's place on that board. Only pilots with some of it take part.
    """
    # One of a fixed set, so safe to put into the query
    col, other = BOARDS[by].format(t="s"), BOARDS[by].format(t="o")
    rows = await pool().fetch(
        f"SELECT row_number() OVER (ORDER BY {col} DESC, s.user_id) AS rank, {LEADER_COLUMNS}"
        " FROM player_stats s JOIN users u ON u.id = s.user_id LEFT JOIN avatars a ON a.user_id = s.user_id"
        f" WHERE {col} > 0 ORDER BY {col} DESC, s.user_id LIMIT $1",
        LEADERS,
    )
    top = [leader(r) for r in rows]
    me = await auth.current_user(request)
    mine = None
    if me:
        mine = next((p for p in top if p["id"] == str(me["public_id"])), None)
        if mine is None:
            row = await pool().fetchrow(
                f"SELECT (SELECT count(*) + 1 FROM player_stats o"
                f"   WHERE {other} > {col} OR ({other} = {col} AND o.user_id < s.user_id)) AS rank, {LEADER_COLUMNS}"
                " FROM player_stats s JOIN users u ON u.id = s.user_id LEFT JOIN avatars a ON a.user_id = s.user_id"
                f" WHERE s.user_id = $1 AND {col} > 0",
                me["id"],
            )
            mine = leader(row) if row else None
    return {"by": by, "leaders": top, "me": mine, "signedIn": bool(me)}


@router.get("/avatar/{public_id}")
async def get_avatar(public_id: UUID):
    row = await pool().fetchrow(
        "SELECT a.content_type, a.data FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.public_id = $1",
        public_id,
    )
    if not row:
        raise HTTPException(404, "not_found")
    # The URL carries ?v=<time of the upload>, so a long cache is safe
    return Response(row["data"], media_type=row["content_type"], headers={
        "Cache-Control": "public, max-age=604800",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })


@router.post("/api/avatar")
async def set_avatar(request: Request):
    """The new avatar as the request body (an image file, already cropped by the page)."""
    me = await auth.current_user(request)
    if not me:
        raise HTTPException(401, "signed_out")
    if int(request.headers.get("content-length") or 0) > AVATAR_MAX_BYTES:
        raise HTTPException(413, "too_big")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > AVATAR_MAX_BYTES:
            raise HTTPException(413, "too_big")
    kind = image_type(bytes(data))
    if not kind:
        raise HTTPException(415, "not_image")
    at = await pool().fetchval(
        "INSERT INTO avatars (user_id, content_type, data) VALUES ($1, $2, $3)"
        " ON CONFLICT (user_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,"
        "   updated_at = now()"
        " RETURNING updated_at",
        me["id"], kind, bytes(data),
    )
    return {"avatar": avatar_url(me["public_id"], at)}


@router.delete("/api/avatar")
async def delete_avatar(request: Request):
    me = await auth.current_user(request)
    if not me:
        raise HTTPException(401, "signed_out")
    await pool().execute("DELETE FROM avatars WHERE user_id = $1", me["id"])
    return {"avatar": None}
