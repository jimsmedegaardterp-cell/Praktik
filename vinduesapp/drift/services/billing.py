"""Fakturakø → fakturakladde i e-conomic → status hentet fra e-conomic.

Vigtigt for idempotens: InvoiceDraft (med idempotency_key) committes i
databasen FØR e-conomic kaldes. Går svaret tabt, finder genforsøget kladden
via referencen i stedet for at oprette en ny.
"""
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from ..integrations.base import IntegrationError
from ..integrations.economic import EconomicAdapter, InvoiceLine
from ..models import BillingItem, Employee, InvoiceDraft
from . import audit


@transaction.atomic
def approve(item_ids, actor: Employee) -> int:
    items = BillingItem.objects.select_for_update().filter(
        pk__in=item_ids,
        status__in=[BillingItem.Status.READY, BillingItem.Status.NEEDS_APPROVAL],
    )
    n = 0
    for item in items:
        item.status = BillingItem.Status.APPROVED
        item.approved_by = actor
        item.approved_at = timezone.now()
        item.save()
        audit.log(actor, "fakturalinje_godkendt", item, beløb=item.amount)
        n += 1
    return n


@transaction.atomic
def build_drafts(actor: Employee) -> list[InvoiceDraft]:
    """Saml godkendte linjer i én kladde pr. kunde (samlefaktura)."""
    items = list(BillingItem.objects.select_for_update()
                 .filter(status=BillingItem.Status.APPROVED, invoice_draft__isnull=True))
    by_customer = defaultdict(list)
    for item in items:
        by_customer[item.customer_id].append(item)
    drafts = []
    for customer_id, group in by_customer.items():
        draft = InvoiceDraft.objects.create(customer_id=customer_id)
        for item in group:
            item.invoice_draft = draft
            item.save(update_fields=["invoice_draft"])
        audit.log(actor, "kladde_forberedt", draft, linjer=len(group))
        drafts.append(draft)
    return drafts


def push_draft(draft: InvoiceDraft, adapter: EconomicAdapter, actor: Employee) -> InvoiceDraft:
    """Send én kladde til e-conomic. Sikker at kalde igen (dobbeltklik/genforsøg)."""
    with transaction.atomic():
        draft = InvoiceDraft.objects.select_for_update().select_related("customer").get(pk=draft.pk)
        if draft.status not in (InvoiceDraft.Status.PENDING, InvoiceDraft.Status.ERROR):
            return draft
        draft.attempts += 1
        draft.save(update_fields=["attempts"])
        reference = str(draft.idempotency_key)
        try:
            number = adapter.find_draft_by_reference(reference)
            if number is None:
                customer_number = adapter.ensure_customer(draft.customer)
                lines = [InvoiceLine(i.description, i.amount, i.visit.agreement.service.economic_product_number)
                         for i in draft.items.select_related("visit__agreement__service")]
                number = adapter.create_draft(customer_number, lines, reference)
        except IntegrationError as exc:
            draft.status = InvoiceDraft.Status.ERROR
            draft.last_error = str(exc)[:500]
            draft.save()
            audit.log(actor, "kladde_fejl", draft, forsøg=draft.attempts)
            return draft
        draft.economic_draft_number = number
        draft.status = InvoiceDraft.Status.DRAFT
        draft.last_error = ""
        draft.save()
        draft.items.update(status=BillingItem.Status.INVOICED)
        audit.log(actor, "kladde_oprettet", draft, kladde_nr=number)
        return draft


def sync_status(adapter: EconomicAdapter) -> int:
    """Hent bogført nummer og betalingsstatus. e-conomic er sandheden."""
    changed = 0
    for draft in InvoiceDraft.objects.filter(status__in=[InvoiceDraft.Status.DRAFT, InvoiceDraft.Status.BOOKED]):
        try:
            remote = adapter.get_status(draft.economic_draft_number)
        except IntegrationError as exc:
            draft.last_error = str(exc)[:500]
            draft.save(update_fields=["last_error"])
            continue
        new_status = draft.status
        if remote.booked_number:
            draft.economic_invoice_number = remote.booked_number
            new_status = InvoiceDraft.Status.PAID if remote.paid else InvoiceDraft.Status.BOOKED
        if new_status != draft.status:
            draft.status = new_status
            draft.save()
            audit.log(None, "status_synkroniseret", draft, status=new_status)
            changed += 1
    return changed
