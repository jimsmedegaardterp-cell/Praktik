"""Udskiftelig SMS-adapter.

FakeSmsProvider sender aldrig noget ud af huset. En rigtig gateway (fx
GatewayAPI) tilføjes som ny klasse med samme metoder – SKAL VERIFICERES:
tovejs-nummer, webhook-format og signaturmetode hos den valgte udbyder.
"""
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from typing import Protocol

from django.conf import settings

from .base import require_live_permission


@dataclass
class InboundSms:
    provider_message_id: str
    phone: str
    body: str


class SmsProvider(Protocol):
    name: str
    def send(self, phone: str, body: str, idempotency_key: str) -> str: ...
    def verify_webhook(self, raw_body: bytes, headers) -> bool: ...
    def parse_inbound(self, raw_body: bytes) -> list[InboundSms]: ...


class FakeSmsProvider:
    name = "fake"

    def send(self, phone, body, idempotency_key) -> str:
        # Ingen netværk. Returnerer et stabilt "udbyder-ID" pr. nøgle.
        return "fake-" + uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key).hex[:16]

    def verify_webhook(self, raw_body, headers) -> bool:
        secret = settings.SMS_WEBHOOK_SECRET
        if not secret:
            return False
        expected = sign(raw_body, secret)
        return hmac.compare_digest(expected, headers.get("X-Signature", ""))

    def parse_inbound(self, raw_body):
        data = json.loads(raw_body)
        items = data if isinstance(data, list) else [data]
        return [InboundSms(str(i["id"]), str(i["msisdn"]), str(i["message"])) for i in items]


def sign(raw_body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()


class LiveSmsProvider:
    name = "live"

    def __init__(self):
        require_live_permission("SMS")
        raise NotImplementedError("SKAL VERIFICERES: valg af SMS-gateway og tovejs-nummer")


def get_sms_provider() -> SmsProvider:
    if settings.SMS_ADAPTER == "live":
        return LiveSmsProvider()
    return FakeSmsProvider()


# --- Længde/pris: Æ, Ø og Å findes i GSM-7, så danske tekster er normalt 160 tegn/SMS.
GSM7 = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
GSM7_EXT = set("^{}\\[~]|€")


def segments(body: str) -> int:
    if all(c in GSM7 or c in GSM7_EXT for c in body):
        units = sum(2 if c in GSM7_EXT else 1 for c in body)
        return 1 if units <= 160 else -(-units // 153)
    units = sum(2 if ord(c) > 0xFFFF else 1 for c in body)  # UCS-2/UTF-16
    return 1 if units <= 70 else -(-units // 67)
