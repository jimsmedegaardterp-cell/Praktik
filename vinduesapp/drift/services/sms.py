from django.db import IntegrityError, transaction

from ..integrations.sms import InboundSms, SmsProvider
from ..models import Customer, Employee, SmsMessage
from . import audit


def normalize_phone(raw: str) -> str:
    digits = "".join(c for c in raw if c.isdigit() or c == "+")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if len(digits) == 8 and digits.isdigit():
        digits = "+45" + digits
    if digits.isdigit():
        digits = "+" + digits
    return digits


def find_customer(phone: str) -> Customer | None:
    matches = list(Customer.objects.filter(phone=normalize_phone(phone))[:2])
    # Flere kunder med samme nummer → ikke gæt; manuel tilknytning.
    return matches[0] if len(matches) == 1 else None


def send(customer: Customer, body: str, idempotency_key: str, provider: SmsProvider,
         actor: Employee | None) -> SmsMessage:
    """Send én SMS højst én gang pr. idempotency_key."""
    existing = SmsMessage.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
    msg = SmsMessage.objects.create(
        customer=customer, direction=SmsMessage.Direction.OUT, phone=customer.phone, body=body,
        status=SmsMessage.Status.PREPARED, provider=provider.name, idempotency_key=idempotency_key,
        is_handled=True,
    )
    msg.provider_message_id = provider.send(customer.phone, body, idempotency_key)
    msg.status = SmsMessage.Status.SENT
    msg.save()
    audit.log(actor, "sms_sendt", msg, kunde=customer.pk, udbyder=provider.name)
    return msg


def receive(provider: SmsProvider, items: list[InboundSms]) -> int:
    """Gem indgående SMS. Samme udbyder-ID gemmes kun én gang."""
    stored = 0
    for item in items:
        try:
            with transaction.atomic():
                msg = SmsMessage.objects.create(
                    customer=find_customer(item.phone), direction=SmsMessage.Direction.IN,
                    phone=normalize_phone(item.phone), body=item.body, status=SmsMessage.Status.RECEIVED,
                    provider=provider.name, provider_message_id=item.provider_message_id,
                )
        except IntegrityError:
            continue  # dublet fra udbyderens genforsøg
        audit.log(None, "sms_modtaget", msg, kendt_kunde=bool(msg.customer_id))
        stored += 1
    return stored


@transaction.atomic
def assign(message: SmsMessage, customer: Customer, actor: Employee) -> None:
    message.customer = customer
    message.save(update_fields=["customer"])
    audit.log(actor, "sms_tilknyttet", message, kunde=customer.pk)
