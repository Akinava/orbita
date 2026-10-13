"""PostgreSQL: the connection pool and schema migrations.

Migrations are the SQL files in app/migrations, applied in name order, each once and in a transaction of
its own; applied ones are listed in schema_migrations. The server applies new ones at start-up, or by hand:

    bin/python -m app.db            # create the database if needed and apply new migrations

It also carries messages between server processes (in Docker, the map containers): notify() sends one
on a channel, on_notify() handlers registered before start() receive it in every process, the sender
included (PostgreSQL LISTEN/NOTIFY).
"""

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg

from app import settings

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
MIGRATION_LOCK = 0x0B17A  # advisory lock key: one process migrates at a time
RETRY_DELAY = 10  # seconds between attempts while the database is unreachable
LISTEN_PING = 30  # seconds between checks that the listening connection is still alive
log = logging.getLogger("orbita.db")

pool: asyncpg.Pool | None = None  # None until connected: accounts are off, the game plays on
_connecting: asyncio.Task | None = None
_listening: asyncio.Task | None = None
_handlers: dict[str, Callable[[str], None]] = {}  # channel -> handler(payload)


def on_notify(channel: str, handler: Callable[[str], None]):
    _handlers[channel] = handler


async def notify(channel: str, payload: str):
    await pool.execute("SELECT pg_notify($1, $2)", channel, payload)


async def _listen(url: str):
    """Keep a connection LISTENing on the handlers' channels, reconnecting when it drops."""
    while True:
        conn = None
        try:
            conn = await asyncpg.connect(url)
            for channel, handler in _handlers.items():
                await conn.add_listener(channel, lambda _c, _pid, _ch, payload, h=handler: h(payload))
            while True:
                await asyncio.sleep(LISTEN_PING)
                await asyncio.wait_for(conn.fetchval("SELECT 1"), LISTEN_PING)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error("lost the notification connection (%s); retrying in %d s", e, RETRY_DELAY)
        finally:
            if conn is not None:
                conn.terminate()
        await asyncio.sleep(RETRY_DELAY)


def database_url() -> str | None:
    """DATABASE_URL, with its host replaced by DATABASE_HOST when set (Docker: the host machine)."""
    url = settings.get("DATABASE_URL")
    host = settings.get("DATABASE_HOST")
    if url and host:
        parts = urlsplit(url)
        netloc = parts.netloc.rpartition("@")
        port = f":{parts.port}" if parts.port else ""
        url = urlunsplit(parts._replace(netloc=f"{netloc[0]}{netloc[1]}{host}{port}"))
    return url


async def create_database(url: str):
    """Create the database named in `url` if it does not exist (connecting to "postgres" to do so)."""
    parts = urlsplit(url)
    name = parts.path.lstrip("/")
    try:
        conn = await asyncpg.connect(url)
        await conn.close()
        return
    except asyncpg.InvalidCatalogNameError:
        pass
    conn = await asyncpg.connect(urlunsplit(parts._replace(path="/postgres")))
    try:
        await conn.execute(f'CREATE DATABASE "{name}"')
        log.warning("created database %s", name)
    except asyncpg.DuplicateDatabaseError:
        pass
    finally:
        await conn.close()


async def migrate(url: str):
    await create_database(url)
    conn = await asyncpg.connect(url)
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK)
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = {r["version"] for r in await conn.fetch("SELECT version FROM schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.stem in done:
                continue
            async with conn.transaction():
                await conn.execute(path.read_text())
                await conn.execute("INSERT INTO schema_migrations (version) VALUES ($1)", path.stem)
            log.warning("applied migration %s", path.stem)
    finally:
        await conn.close()


async def _connect(url: str):
    global pool, _listening
    while True:
        try:
            await migrate(url)
            pool = await asyncpg.create_pool(url, min_size=1, max_size=10)
            if _handlers:
                _listening = asyncio.create_task(_listen(url))
            return
        except Exception as e:
            log.error("database unavailable (%s); accounts are off, retrying in %d s", e, RETRY_DELAY)
            await asyncio.sleep(RETRY_DELAY)


async def start():
    """Migrate and open the pool once the database answers. Without DATABASE_URL accounts stay off.

    Waits a few seconds for the first attempt, then carries on connecting in the background, so the
    game never waits for the database.
    """
    global _connecting
    url = database_url()
    if not url:
        return
    _connecting = asyncio.create_task(_connect(url))
    await asyncio.wait([_connecting], timeout=5)


async def stop():
    for task in (_connecting, _listening):
        if task:
            task.cancel()
    if pool:
        await pool.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if not database_url():
        raise SystemExit("DATABASE_URL is not set (environment or shadow/auth.env)")
    asyncio.run(migrate(database_url()))
    print("migrations up to date")
