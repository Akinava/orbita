"""Sign-in through Google, Apple, Discord and Meta (Facebook Login): OAuth 2.0 authorization code flow.

The browser goes to the provider with a one-time `state` (and a PKCE challenge where supported); the
provider sends it back to /auth/<provider>/callback with a code, which the server exchanges for the
pilot's id, e-mail and name. Each provider is offered only when its keys are set (shadow/auth.env);
redirect URLs to register with the providers: <PUBLIC_URL>/auth/<provider>/callback.
"""

import base64
import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode

import httpx
import jwt

from app import settings

APPLE_ISSUER = "https://appleid.apple.com"
PROJECT_DIR = Path(__file__).parent.parent


@dataclass
class Profile:
    subject: str  # the provider's user id
    email: str | None
    email_verified: bool  # the provider vouches that the pilot owns this e-mail
    name: str | None


PROVIDERS = {
    "google": {
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "scope": "openid email profile",
        "pkce": True,
        "keys": ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
    },
    "apple": {
        "authorize": "https://appleid.apple.com/auth/authorize",
        "token": "https://appleid.apple.com/auth/token",
        "scope": "name email",
        "pkce": False,
        "keys": ("APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_FILE"),
        # Apple posts the result back (needed for the name and email scopes)
        "extra": {"response_mode": "form_post"},
    },
    "discord": {
        "authorize": "https://discord.com/oauth2/authorize",
        "token": "https://discord.com/api/oauth2/token",
        "scope": "identify email",
        "pkce": True,
        "keys": ("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"),
        "extra": {"prompt": "none"},
    },
    "meta": {
        "authorize": "https://www.facebook.com/v21.0/dialog/oauth",
        "token": "https://graph.facebook.com/v21.0/oauth/access_token",
        "scope": "email public_profile",
        "pkce": True,
        "keys": ("META_CLIENT_ID", "META_CLIENT_SECRET"),
    },
}


def configured(name: str) -> bool:
    p = PROVIDERS.get(name)
    return bool(p) and all(settings.get(k) for k in p["keys"])


def enabled() -> list[str]:
    return [n for n in PROVIDERS if configured(n)]


def redirect_uri(name: str) -> str:
    return f"{settings.public_url()}/auth/{name}/callback"


def client_id(name: str) -> str:
    return settings.get(f"{name.upper()}_CLIENT_ID")


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def authorize_url(name: str, state: str, verifier: str, nonce: str) -> str:
    p = PROVIDERS[name]
    params = {
        "client_id": client_id(name),
        "redirect_uri": redirect_uri(name),
        "response_type": "code",
        "scope": p["scope"],
        "state": state,
        **p.get("extra", {}),
    }
    if p["pkce"]:
        params |= {"code_challenge": pkce_challenge(verifier), "code_challenge_method": "S256"}
    if name in ("google", "apple"):
        params["nonce"] = nonce
    return f"{p['authorize']}?{urlencode(params)}"


def apple_client_secret() -> str:
    """Apple wants a short-lived JWT signed with the developer key instead of a fixed secret."""
    key = (PROJECT_DIR / settings.get("APPLE_PRIVATE_KEY_FILE")).read_text()  # relative: to the project
    now = int(time.time())
    return jwt.encode(
        {"iss": settings.get("APPLE_TEAM_ID"), "iat": now, "exp": now + 300, "aud": APPLE_ISSUER,
         "sub": client_id("apple")},
        key, algorithm="ES256", headers={"kid": settings.get("APPLE_KEY_ID")},
    )


def client_secret(name: str) -> str:
    return apple_client_secret() if name == "apple" else settings.get(f"{name.upper()}_CLIENT_SECRET")


async def fetch_profile(name: str, code: str, verifier: str, nonce: str, apple_user: str | None = None) -> Profile:
    """Exchange the callback's code for the pilot's profile; raises on any failure."""
    p = PROVIDERS[name]
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(name),
        "client_id": client_id(name),
        "client_secret": client_secret(name),
    }
    if p["pkce"]:
        form["code_verifier"] = verifier
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(p["token"], data=form, headers={"Accept": "application/json"})
        r.raise_for_status()
        tokens = r.json()
        access = tokens.get("access_token")
        auth = {"Authorization": f"Bearer {access}"}

        if name == "google":
            r = await client.get("https://openidconnect.googleapis.com/v1/userinfo", headers=auth)
            r.raise_for_status()
            u = r.json()
            return Profile(u["sub"], u.get("email"), bool(u.get("email_verified")), u.get("name"))

        if name == "discord":
            r = await client.get("https://discord.com/api/users/@me", headers=auth)
            r.raise_for_status()
            u = r.json()
            return Profile(u["id"], u.get("email"), bool(u.get("verified")), u.get("global_name") or u.get("username"))

        if name == "meta":
            r = await client.get("https://graph.facebook.com/v21.0/me",
                                 params={"fields": "id,name,email", "access_token": access})
            r.raise_for_status()
            u = r.json()
            # Facebook only hands out e-mail addresses its users have confirmed
            return Profile(u["id"], u.get("email"), bool(u.get("email")), u.get("name"))

        if name == "apple":
            jwks = (await client.get(f"{APPLE_ISSUER}/auth/keys")).json()
            claims = verify_apple_id_token(tokens["id_token"], jwks)
            if claims.get("nonce") != nonce:
                raise ValueError("apple: nonce mismatch")
            display = None
            if apple_user:  # sent on the first sign-in only
                try:
                    n = json.loads(apple_user).get("name") or {}
                    display = " ".join(x for x in (n.get("firstName"), n.get("lastName")) if x) or None
                except (ValueError, AttributeError):
                    pass
            verified = claims.get("email_verified") in (True, "true")
            return Profile(claims["sub"], claims.get("email"), verified, display)

    raise ValueError(f"unknown provider {name}")


def verify_apple_id_token(token: str, jwks: dict) -> dict:
    kid = jwt.get_unverified_header(token).get("kid")
    key = next(k for k in jwks["keys"] if k["kid"] == kid)
    return jwt.decode(token, jwt.PyJWK(key).key, algorithms=["RS256"], audience=client_id("apple"), issuer=APPLE_ISSUER)
