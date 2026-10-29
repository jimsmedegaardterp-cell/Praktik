"""Registrering af besøg fra marken. Idempotent og med revisionsspor."""
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction

from ..models import BillingItem, Employee, Visit, WorkLog
from . import audit

FIELD_OUTCOMES_ORDERED = [
    Visit.Status.DONE, Visit.Status.PARTIAL, Visit.Status.NO_ACCESS,
    Visit.Status.POSTPONED, Visit.Status.CANCELLED,
]
FIELD_OUTCOMES = set(FIELD_OUTCOMES_ORDERED)


@dataclass
class Result:
    visit: Visit
    created: bool          # False = genafsendelse/dobbelttryk, intet nyt oprettet
    message: str


def can_access(employee: Employee, visit: Visit) -> bool:
    return employee.is_admin or visit.employee_id == employee.pk


@transaction.atomic
def register(visit_id, employee: Employee, outcome: str, client_event_id: uuid.UUID,
             note: str = "", proposed_price: Decimal | None = None, on_date: date | None = None) -> Result:
    # Lås besøget først, så samtidige forsøg behandles ét ad gangen.
    visit = Visit.objects.select_for_update().select_related("agreement__service").get(pk=visit_id)
    if not can_access(employee, visit):
        raise PermissionDenied("Besøget tilhører ikke din rute.")

    existing = WorkLog.objects.filter(client_event_id=client_event_id).first()
    if existing:
        if existing.visit_id != visit.pk:
            raise ValidationError("Registrerings-ID er allerede brugt til et andet besøg.")
        return Result(visit, False, "Allerede registreret – intet ændret.")

    if outcome not in FIELD_OUTCOMES:
        raise ValidationError("Ugyldig status.")
    if visit.is_final:
        return Result(visit, False, f"Besøget var allerede registreret som '{visit.get_status_display()}'.")
    if hasattr(visit, "billing_item"):
        # Ekstra værn (accepttest 5): et besøg med fakturalinje kan aldrig få en ny.
        return Result(visit, False, "Besøget er allerede i fakturakøen.")

    WorkLog.objects.create(visit=visit, employee=employee, outcome=outcome, note=note,
                           proposed_price=proposed_price, client_event_id=client_event_id)
    visit.status = outcome
    if note:
        visit.note = note
    if outcome in Visit.BILLABLE | {Visit.Status.NO_ACCESS}:
        visit.completed_date = on_date or date.today()
    visit.save()

    if outcome in Visit.BILLABLE:
        price_changed = proposed_price is not None and proposed_price != visit.price
        needs_approval = price_changed or outcome == Visit.Status.PARTIAL
        BillingItem.objects.create(
            visit=visit,
            customer=visit.agreement.customer,
            description=f"{visit.agreement.service.name} {visit.completed_date:%d.%m.%Y}",
            amount=proposed_price if proposed_price is not None else visit.price,
            status=BillingItem.Status.NEEDS_APPROVAL if needs_approval else BillingItem.Status.READY,
        )
    audit.log(employee, "besoeg_registreret", visit, status=outcome,
              prisforslag=proposed_price if proposed_price is not None else "")
    return Result(visit, True, f"Registreret: {visit.get_status_display()}.")
