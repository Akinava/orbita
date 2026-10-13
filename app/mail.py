"""Outgoing letters over SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM).

Without SMTP_HOST, for development, the letter is written to the server log instead of being sent.
Port 465 means TLS from the start, any other port STARTTLS when the server offers it.
"""

import asyncio
import logging
import smtplib
from email.message import EmailMessage

from app import settings

log = logging.getLogger("orbita.mail")

# Letters by purpose ("verify": confirm the address, "reset": set a new password) and language
TEXTS = {
    "verify": {
        "en": {
            "subject": "Orbita: confirm your e-mail",
            "body": "Hello, {name}!\n\nTo finish signing up for Orbita, open this link within 24 hours:\n\n{link}\n\n"
                    "If you did not sign up, just ignore this letter.\n",
        },
        "ru": {
            "subject": "Орбита: подтвердите e-mail",
            "body": "Здравствуйте, {name}!\n\nЧтобы закончить регистрацию в «Орбите», откройте ссылку в течение 24 часов:\n\n"
                    "{link}\n\nЕсли вы не регистрировались, просто не отвечайте на это письмо.\n",
        },
    },
    "reset": {
        "en": {
            "subject": "Orbita: new password",
            "body": "Hello, {name}!\n\nTo set a new password for Orbita, open this link within an hour:\n\n{link}\n\n"
                    "If you did not ask for it, just ignore this letter: your password stays the same.\n",
        },
        "ru": {
            "subject": "Орбита: новый пароль",
            "body": "Здравствуйте, {name}!\n\nЧтобы задать новый пароль в «Орбите», откройте ссылку в течение часа:\n\n"
                    "{link}\n\nЕсли вы не просили сменить пароль, просто не отвечайте на это письмо: пароль останется прежним.\n",
        },
    },
}


def _send(msg: EmailMessage):
    host = settings.get("SMTP_HOST")
    port = int(settings.get("SMTP_PORT", "587"))
    user, password = settings.get("SMTP_USER"), settings.get("SMTP_PASSWORD")
    if port == 465:
        smtp = smtplib.SMTP_SSL(host, port, timeout=20)
    else:
        smtp = smtplib.SMTP(host, port, timeout=20)
        smtp.ehlo()
        if smtp.has_extn("starttls"):
            smtp.starttls()
            smtp.ehlo()
    with smtp:
        if user:
            smtp.login(user, password or "")
        smtp.send_message(msg)


async def send_link(purpose: str, to: str, name: str, link: str, lang: str = "en"):
    texts = TEXTS[purpose]
    text = texts.get(lang, texts["en"])
    msg = EmailMessage()
    msg["From"] = settings.get("SMTP_FROM", "Orbita <no-reply@localhost>")
    msg["To"] = to
    msg["Subject"] = text["subject"]
    msg.set_content(text["body"].format(name=name, link=link))
    if not settings.get("SMTP_HOST"):
        log.warning("SMTP_HOST is not set; %s link for %s: %s", purpose, to, link)
        return
    await asyncio.to_thread(_send, msg)
