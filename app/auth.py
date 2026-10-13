"""Pilot accounts: sign-up and sign-in by e-mail (captcha, confirmation letter) or through a provider.

The page is static/login.html. A signed-in browser holds a random token in the HttpOnly cookie
orbita_session; the sessions table keeps its SHA-256. Errors come back as {"detail": "<code>"}, which
the page turns into text (auth.err.<code> in static/js/i18n).

E-mail sign-up: the pilot is created unconfirmed and gets a letter with a link to /auth/verify; signing
in with the password works once the address is confirmed. Signing up again with an address that is
not yet confirmed replaces the password and sends a new letter, since nobody has proved owning it yet.
Forgotten password: /auth/forgot mails a link to login.html?reset=<token>, where the page sends the new
password to /auth/reset; that also confirms the address and signs out every other browser.
Providers (app/oauth.py): a provider account is linked to the pilot with the same confirmed e-mail, or
to the pilot signed in at the moment, otherwise a new pilot is created.

Pilot names: an account's display_name is its name in multiplayer, unique regardless of case
(migration 0002). The game server (app/main.py) gives a signed-in pilot that name.
Only signed-in pilots play once accounts are set up (DATABASE_URL); guests only without accounts (a
local server without a database) or with ALLOW_GUESTS=1 (load tests). Guests keep off names that belong
to accounts; "Pilot-<n>" is left for them.
"""

import asyncio
import hashlib
import hmac
import logging
import re
import secrets
from datetime import timedelta

import asyncpg
import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app import db, mail, oauth, settings

log = logging.getLogger("orbita.auth")
router = APIRouter(prefix="/auth")

COOKIE = "orbita_session"
SESSION_TTL = timedelta(days=30)
VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(hours=1)
OAUTH_TTL = timedelta(minutes=10)
RESEND_INTERVAL = timedelta(minutes=1)  # at most one letter of each kind a minute per pilot
NAME_MAX = 16  # same as the pilot name in the game
PASSWORD_MIN, PASSWORD_MAX = 8, 128
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
GUEST_NAME_RE = re.compile(r"^pilot-\d+$", re.IGNORECASE)  # the game's names for guests
STALE_SIGNUP = timedelta(days=2)  # unconfirmed e-mail sign-ups older than this give up their names
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}
TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


# --- Helpers ----------------------------------------------------------------------------------------

def fail(status: int, code: str):
    raise HTTPException(status, code)


def pool():
    if db.pool is None:
        fail(503, "unavailable")
    return db.pool


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=64 * 1024 * 1024, dklen=32)


async def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = await asyncio.to_thread(_scrypt, password, salt, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


async def check_password(password: str, stored: str | None) -> bool:
    if not stored:
        # Spend the same time as a real check, so the answer does not tell which addresses exist
        await hash_password(password)
        return False
    _, n, r, p, salt, digest = stored.split("$")
    got = await asyncio.to_thread(_scrypt, password, bytes.fromhex(salt), int(n), int(r), int(p))
    return hmac.compare_digest(got, bytes.fromhex(digest))


def client_ip(request: Request) -> str | None:
    # Behind nginx the real address is the last hop it adds
    forwarded = request.headers.get("x-forwarded-for")
    return forwarded.split(",")[-1].strip() if forwarded else (request.client.host if request.client else None)


async def check_captcha(token: str, request: Request):
    secret = settings.get("TURNSTILE_SECRET")
    if not secret:
        log.error("TURNSTILE_SECRET is not set; e-mail sign-up and sign-in are refused")
        fail(503, "captcha")
    if not token:
        fail(400, "captcha")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(TURNSTILE_VERIFY, data={
                "secret": secret, "response": token, "remoteip": client_ip(request) or "",
            })
            ok = r.json().get("success") is True
    except Exception:
        log.exception("captcha check failed")
        ok = False
    if not ok:
        fail(400, "captcha")


def safe_next(url: str | None) -> str:
    """Only paths on this site, so the sign-in cannot be used to send pilots elsewhere."""
    if not url or not url.startswith("/") or url.startswith("//") or "\\" in url:
        return "/"
    return url


def clean_name(name: str | None, fallback: str = "Pilot") -> str:
    name = " ".join((name or "").split())[:NAME_MAX]
    return name or fallback


def valid_name(name: str | None) -> str:
    name = clean_name(name, "")
    if not name or GUEST_NAME_RE.match(name):
        fail(400, "name")
    return name


async def name_owner(conn, name: str) -> int | None:
    return await conn.fetchval("SELECT id FROM users WHERE lower(display_name) = lower($1)", name)


async def free_name(conn, wanted: str | None) -> str:
    """`wanted` if no account has it, otherwise it with the lowest free number appended."""
    base = clean_name(wanted)
    if GUEST_NAME_RE.match(base):
        base = "Pilot"
    if not await name_owner(conn, base):
        return base
    for n in range(2, 1000):
        suffix = str(n)
        name = base[:NAME_MAX - len(suffix)] + suffix
        if not await name_owner(conn, name):
            return name
    return f"Pilot{secrets.randbelow(10 ** 9)}"


# --- For the game server --------------------------------------------------------------------------

def guests_allowed() -> bool:
    """Whether pilots without an account may play."""
    return not db.database_url() or settings.get("ALLOW_GUESTS") == "1"


async def name_reserved(name: str) -> bool:
    """Whether an account owns this name (a guest may not fly under it)."""
    if db.pool is None:
        return False
    return await name_owner(db.pool, name) is not None

# --- Sessions -------------------------------------------------------------------------------------

async def start_session(conn, user_id: int, request: Request, response: Response):
    token = secrets.token_urlsafe(32)
    await conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)"
        " VALUES ($1, $2, now() + $3::interval, $4, $5)",
        token_hash(token), user_id, SESSION_TTL, (request.headers.get("user-agent") or "")[:300], client_ip(request),
    )
    await conn.execute("UPDATE users SET last_login_at = now() WHERE id = $1", user_id)
    await conn.execute("DELETE FROM sessions WHERE expires_at < now()")
    response.set_cookie(
        COOKIE, token, max_age=int(SESSION_TTL.total_seconds()), httponly=True, samesite="lax",
        secure=settings.public_url().startswith("https://"), path="/",
    )


async def current_user(request: Request):
    """The signed-in pilot's users row, or None."""
    token = request.cookies.get(COOKIE)
    if not token or db.pool is None:
        return None
    return await db.pool.fetchrow(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.token_hash = $1 AND s.expires_at > now()",
        token_hash(token),
    )


# --- E-mail confirmation ------------------------------------------------------------------------------

async def send_token(conn, user, purpose: str, lang: str):
    """Mail the pilot a one-time link: 'verify' confirms the address, 'reset' sets a new password."""
    recent = await conn.fetchval(
        "SELECT 1 FROM email_tokens WHERE user_id = $1 AND purpose = $2 AND created_at > now() - $3::interval",
        user["id"], purpose, RESEND_INTERVAL,
    )
    if recent:
        return
    token = secrets.token_urlsafe(32)
    await conn.execute(
        "INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)",
        token_hash(token), user["id"], purpose, VERIFY_TTL if purpose == "verify" else RESET_TTL,
    )
    base = settings.public_url()
    link = f"{base}/auth/verify?token={token}" if purpose == "verify" else f"{base}/login.html?reset={token}"
    try:
        await mail.send_link(purpose, user["email"], user["display_name"], link, lang)
    except Exception:
        log.exception("could not send the %s letter to %s", purpose, user["email"])
        fail(502, "mail")


# --- API --------------------------------------------------------------------------------------------

class RegisterForm(BaseModel):
    email: str
    password: str
    name: str = ""
    captcha: str = ""
    lang: str = "en"


class LoginForm(BaseModel):
    email: str
    password: str
    captcha: str = ""


class ResendForm(BaseModel):  # also the forgotten password form
    email: str
    captcha: str = ""
    lang: str = "en"


class ResetForm(BaseModel):
    token: str
    password: str


class NameForm(BaseModel):
    name: str


def valid_email(email: str) -> str:
    email = email.strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        fail(400, "email")
    return email


@router.get("/config")
async def config():
    """What the sign-in page offers: the captcha site key and the configured providers."""
    return {
        "enabled": db.pool is not None,
        "guests": guests_allowed(),
        "captchaSiteKey": settings.get("TURNSTILE_SITE_KEY"),
        "providers": oauth.enabled(),
    }


@router.get("/me")
async def me(request: Request):
    user = await current_user(request)
    if not user:
        fail(401, "signed_out")
    providers = await db.pool.fetch("SELECT provider FROM identities WHERE user_id = $1 ORDER BY id", user["id"])
    return {
        "id": str(user["public_id"]), "name": user["display_name"], "email": user["email"],
        "providers": [r["provider"] for r in providers], "password": user["password_hash"] is not None,
    }


@router.post("/register")
async def register(form: RegisterForm, request: Request):
    email = valid_email(form.email)
    if not PASSWORD_MIN <= len(form.password) <= PASSWORD_MAX:
        fail(400, "password")
    name = valid_name(form.name)
    await check_captcha(form.captcha, request)
    password_hash = await hash_password(form.password)
    try:
        async with pool().acquire() as conn, conn.transaction():
            # Sign-ups nobody confirmed should not hold on to their names
            await conn.execute(
                "DELETE FROM users u WHERE email_verified_at IS NULL AND password_hash IS NOT NULL"
                " AND created_at < now() - $1::interval"
                " AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id)",
                STALE_SIGNUP,
            )
            user = await conn.fetchrow("SELECT * FROM users WHERE email = $1 FOR UPDATE", email)
            if user and user["email_verified_at"] is not None:
                # Already a pilot: same answer as for a new one, so the form does not reveal who is registered
                return {"ok": True}
            if (owner := await name_owner(conn, name)) and owner != (user and user["id"]):
                fail(409, "name_taken")
            if user is None:
                user = await conn.fetchrow(
                    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *",
                    email, password_hash, name,
                )
            else:
                user = await conn.fetchrow(
                    "UPDATE users SET password_hash = $2, display_name = $3 WHERE id = $1 RETURNING *",
                    user["id"], password_hash, name,
                )
            await send_token(conn, user, "verify", form.lang)
    except asyncpg.UniqueViolationError:
        fail(409, "name_taken")  # someone took the name a moment ago
    return {"ok": True}


@router.post("/name")
async def rename(form: NameForm, request: Request):
    """Change the signed-in pilot's name; the game uses it from the next connection."""
    user = await current_user(request)
    if not user:
        fail(401, "signed_out")
    name = valid_name(form.name)
    try:
        async with pool().acquire() as conn:
            if (owner := await name_owner(conn, name)) and owner != user["id"]:
                fail(409, "name_taken")
            await conn.execute("UPDATE users SET display_name = $2 WHERE id = $1", user["id"], name)
    except asyncpg.UniqueViolationError:
        fail(409, "name_taken")
    return {"ok": True, "name": name}


@router.post("/resend")
async def resend(form: ResendForm, request: Request):
    email = valid_email(form.email)
    await check_captcha(form.captcha, request)
    async with pool().acquire() as conn, conn.transaction():
        user = await conn.fetchrow("SELECT * FROM users WHERE email = $1", email)
        if user and user["email_verified_at"] is None and user["password_hash"]:
            await send_token(conn, user, "verify", form.lang)
    return {"ok": True}


@router.post("/forgot")
async def forgot(form: ResendForm, request: Request):
    """Mail a link for setting a new password; the same answer whether or not the address is known."""
    email = valid_email(form.email)
    await check_captcha(form.captcha, request)
    async with pool().acquire() as conn, conn.transaction():
        user = await conn.fetchrow("SELECT * FROM users WHERE email = $1", email)
        if user:
            await send_token(conn, user, "reset", form.lang)
    return {"ok": True}


@router.post("/reset")
async def reset(form: ResetForm, request: Request, response: Response):
    """Set the new password from the letter's link; every other browser of the pilot is signed out."""
    if not PASSWORD_MIN <= len(form.password) <= PASSWORD_MAX:
        fail(400, "password")
    password_hash = await hash_password(form.password)
    async with pool().acquire() as conn, conn.transaction():
        user_id = await conn.fetchval(
            "DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = 'reset' RETURNING"
            " CASE WHEN expires_at > now() THEN user_id END",
            token_hash(form.token),
        )
        if not user_id:
            fail(400, "token")
        # The letter reached the pilot, so the address is theirs too
        name = await conn.fetchval(
            "UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now())"
            " WHERE id = $1 RETURNING display_name",
            user_id, password_hash,
        )
        await conn.execute("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset'", user_id)
        await conn.execute("DELETE FROM sessions WHERE user_id = $1", user_id)
        await start_session(conn, user_id, request, response)
    return {"ok": True, "name": name}


@router.post("/login")
async def login(form: LoginForm, request: Request, response: Response):
    email = valid_email(form.email)
    await check_captcha(form.captcha, request)
    async with pool().acquire() as conn:
        user = await conn.fetchrow("SELECT * FROM users WHERE email = $1", email)
        if not await check_password(form.password, user["password_hash"] if user else None):
            fail(401, "credentials")
        if user["email_verified_at"] is None:
            fail(403, "unverified")
        await start_session(conn, user["id"], request, response)
    return {"ok": True, "name": user["display_name"]}


@router.post("/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token and db.pool is not None:
        await db.pool.execute("DELETE FROM sessions WHERE token_hash = $1", token_hash(token))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/verify")
async def verify(token: str, request: Request):
    async with pool().acquire() as conn, conn.transaction():
        user_id = await conn.fetchval(
            "DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = 'verify' RETURNING"
            " CASE WHEN expires_at > now() THEN user_id END",
            token_hash(token),
        )
        if not user_id:
            return RedirectResponse("/login.html?error=token", 303)
        await conn.execute("UPDATE users SET email_verified_at = now() WHERE id = $1", user_id)
        await conn.execute("DELETE FROM email_tokens WHERE user_id = $1", user_id)
        response = RedirectResponse("/login.html?verified=1", 303)
        await start_session(conn, user_id, request, response)
    return response


# --- Providers --------------------------------------------------------------------------------------

@router.get("/{provider}/start")
async def oauth_start(provider: str, next: str = "/"):
    if not oauth.configured(provider):
        return RedirectResponse("/login.html?error=provider", 303)
    state, verifier, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(48), secrets.token_urlsafe(16)
    async with pool().acquire() as conn:
        await conn.execute("DELETE FROM oauth_states WHERE expires_at < now()")
        await conn.execute(
            "INSERT INTO oauth_states (state, provider, verifier, nonce, next_url, expires_at)"
            " VALUES ($1, $2, $3, $4, $5, now() + $6::interval)",
            state, provider, verifier, nonce, safe_next(next), OAUTH_TTL,
        )
    return RedirectResponse(oauth.authorize_url(provider, state, verifier, nonce), 303)


async def link_profile(conn, provider: str, profile: oauth.Profile, signed_in) -> int:
    """The pilot this provider account belongs to, linking or creating one as needed."""
    user_id = await conn.fetchval(
        "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2", provider, profile.subject,
    )
    if user_id:
        return user_id
    email = profile.email.strip().lower() if profile.email and profile.email_verified else None
    if signed_in:
        user_id = signed_in["id"]
    elif email and (user := await conn.fetchrow("SELECT * FROM users WHERE email = $1 FOR UPDATE", email)):
        user_id = user["id"]
        if user["email_verified_at"] is None:
            # Whoever set the password never proved owning the address: drop it, the provider just did
            await conn.execute(
                "UPDATE users SET email_verified_at = now(), password_hash = NULL WHERE id = $1", user_id,
            )
    else:
        user_id = await conn.fetchval(
            "INSERT INTO users (email, email_verified_at, display_name)"
            " VALUES ($1, CASE WHEN $1::text IS NULL THEN NULL ELSE now() END, $2) RETURNING id",
            email, await free_name(conn, profile.name),
        )
    await conn.execute(
        "INSERT INTO identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)",
        user_id, provider, profile.subject, profile.email,
    )
    return user_id


@router.api_route("/{provider}/callback", methods=["GET", "POST"])
async def oauth_callback(provider: str, request: Request):
    # Apple posts the result as a form; the others come back with a query string
    params = dict(request.query_params)
    if request.method == "POST":
        params |= {k: v for k, v in (await request.form()).items() if isinstance(v, str)}
    if not oauth.configured(provider) or "code" not in params or "state" not in params:
        return RedirectResponse("/login.html?error=oauth", 303)
    async with pool().acquire() as conn:
        saved = await conn.fetchrow(
            "DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND expires_at > now() RETURNING *",
            params["state"], provider,
        )
    if not saved:
        return RedirectResponse("/login.html?error=oauth", 303)
    try:
        profile = await oauth.fetch_profile(provider, params["code"], saved["verifier"], saved["nonce"], params.get("user"))
    except Exception:
        log.exception("%s sign-in failed", provider)
        return RedirectResponse("/login.html?error=oauth", 303)
    signed_in = await current_user(request)
    response = RedirectResponse(saved["next_url"], 303)
    async with pool().acquire() as conn, conn.transaction():
        user_id = await link_profile(conn, provider, profile, signed_in)
        await start_session(conn, user_id, request, response)
    return response
