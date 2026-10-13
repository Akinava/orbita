"""ICE servers for voice chat, with short-lived TURN credentials for our coturn (docker/turn).

coturn runs with `use-auth-secret` (the TURN REST API scheme): a login is "<expiry unix time>:<label>"
and its password is base64(HMAC-SHA1(shared secret, login)), so nothing long-lived reaches the page.
Settings come from the environment or, failing that, from shadow/turn.env:
TURN_SECRET (shared with coturn) and TURN_HOST (the host browsers connect to).
"""

import base64
import hashlib
import hmac
import os
import time
from pathlib import Path

ENV_FILE = Path(__file__).parent.parent / "shadow" / "turn.env"
CREDENTIAL_TTL = 6 * 3600  # seconds
PUBLIC_STUN = {"urls": "stun:stun.l.google.com:19302"}


def _settings():
    values = {}
    try:
        for line in ENV_FILE.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                values[key.strip()] = value.strip()
    except OSError:
        pass
    values.update({k: v for k, v in os.environ.items() if k.startswith("TURN_")})
    return values.get("TURN_SECRET"), values.get("TURN_HOST")


def ice_servers(label: str = "pilot"):
    """RTCPeerConnection iceServers; only public STUN when TURN is not configured."""
    secret, host = _settings()
    if not secret or not host:
        return [PUBLIC_STUN]
    username = f"{int(time.time()) + CREDENTIAL_TTL}:{label}"
    password = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
    return [
        {"urls": f"stun:{host}:3478"},
        {
            "urls": [
                f"turn:{host}:3478?transport=udp",
                f"turn:{host}:3478?transport=tcp",
                f"turns:{host}:5349?transport=tcp",
            ],
            "username": username,
            "credential": password,
        },
    ]
