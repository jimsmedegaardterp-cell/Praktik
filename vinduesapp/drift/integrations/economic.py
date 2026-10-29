"""Adapter til e-conomic.

Resten af systemet kender kun EconomicAdapter-grænsefladen. Mock-versionen
gemmer i en lokal tabel; live-versionen er bevidst ikke implementeret endnu.
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from django.conf import settings

from ..models import Customer, MockEconomicInvoice
from .base import IntegrationError, require_live_permission


@dataclass
class InvoiceLine:
    description: str
    amount: Decimal          # ekskl. moms
    product_number: str


@dataclass
class RemoteStatus:
    booked_number: int | None
    paid: bool


class EconomicAdapter(Protocol):
    def ensure_customer(self, customer: Customer) -> int: ...
    def find_draft_by_reference(self, reference: str) -> int | None: ...
    def create_draft(self, customer_number: int, lines: list[InvoiceLine], reference: str) -> int: ...
    def get_status(self, draft_number: int) -> RemoteStatus: ...


class MockEconomicAdapter:
    """Simuleret e-conomic til demo og test. Kan simulere netværksfejl."""

    name = "mock"

    def __init__(self, fail_before_create: bool = False, fail_after_create: bool = False):
        self.fail_before_create = fail_before_create
        # "Timeout": kladden ER oprettet hos e-conomic, men svaret når ikke frem.
        self.fail_after_create = fail_after_create

    def ensure_customer(self, customer: Customer) -> int:
        if customer.economic_customer_number:
            return customer.economic_customer_number
        customer.economic_customer_number = 10000 + customer.pk
        customer.save(update_fields=["economic_customer_number"])
        return customer.economic_customer_number

    def find_draft_by_reference(self, reference: str) -> int | None:
        inv = MockEconomicInvoice.objects.filter(reference=reference).first()
        return inv.draft_number if inv else None

    def create_draft(self, customer_number, lines, reference) -> int:
        if self.fail_before_create:
            raise IntegrationError("Simuleret fejl: e-conomic svarede ikke.")
        inv = MockEconomicInvoice.objects.create(
            customer_number=customer_number,
            reference=reference,
            lines=[{"tekst": l.description, "beløb": str(l.amount), "varenr": l.product_number} for l in lines],
        )
        if self.fail_after_create:
            raise IntegrationError("Simuleret timeout efter oprettelse.")
        return inv.draft_number

    def get_status(self, draft_number: int) -> RemoteStatus:
        inv = MockEconomicInvoice.objects.get(pk=draft_number)
        return RemoteStatus(inv.booked_number, inv.paid)

    # --- Kun demo: det ejeren ellers gør inde i e-conomic ------------------
    @staticmethod
    def simulate_book(draft_number: int) -> None:
        inv = MockEconomicInvoice.objects.get(pk=draft_number)
        if inv.booked_number is None:
            inv.booked_number = 20000 + inv.pk
            inv.save()

    @staticmethod
    def simulate_paid(draft_number: int) -> None:
        MockEconomicInvoice.objects.filter(pk=draft_number, booked_number__isnull=False).update(paid=True)


class LiveEconomicAdapter:
    """Rigtig e-conomic. IKKE implementeret – kræver godkendelse og verificering.

    Plan (alt SKAL VERIFICERES i den officielle dokumentation før kode skrives):
    - Autentifikation med app-secret-token + agreement-grant-token i headers,
      opbevaret som miljøvariabler på serveren.
    - Kunde: slå op på eget kundenummer/reference før oprettelse (ingen dubletter).
    - Kladde: undersøg om API'et understøtter en idempotensnøgle. Hvis ikke:
      skriv vores idempotency_key i et referencefelt på kladden og søg efter
      den før et genforsøg (samme mønster som mock'en).
    - Status: polling af bogførte fakturaer og restbeløb, evt. webhooks.
    - Rate limits og paginering.
    """

    name = "live"

    def __init__(self):
        require_live_permission("e-conomic")

    def ensure_customer(self, customer):
        raise NotImplementedError("SKAL VERIFICERES: e-conomic kunde-API")

    def find_draft_by_reference(self, reference):
        raise NotImplementedError("SKAL VERIFICERES: søgning på kladde-reference")

    def create_draft(self, customer_number, lines, reference):
        raise NotImplementedError("SKAL VERIFICERES: oprettelse af fakturakladde")

    def get_status(self, draft_number):
        raise NotImplementedError("SKAL VERIFICERES: status/betaling")


def get_economic() -> EconomicAdapter:
    if settings.ECONOMIC_ADAPTER == "live":
        return LiveEconomicAdapter()
    return MockEconomicAdapter()
