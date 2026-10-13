"""Account settings: the environment, or failing that shadow/auth.env (git-ignored, see README).

Accounts are switched on by DATABASE_URL; without it (the map containers in Docker) the server only
runs the game.
"""

import os
from functools import cache
from pathlib import Path

ENV_FILE = Path(__file__).parent.parent / "shadow" / "auth.env"


@cache
def settings() -> dict[str, str]:
    values = {}
    try:
        for line in ENV_FILE.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                values[key.strip()] = value.strip()
    except OSError:
        pass
    values.update(os.environ)
    return {k: v for k, v in values.items() if v}


def get(key: str, default: str | None = None) -> str | None:
    return settings().get(key, default)


def public_url() -> str:
    return get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
