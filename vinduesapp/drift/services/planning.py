"""Besøgsplanlægning: grundrytme, sæson, helligdage og flytning af besøg.

Begreber:
- rhythm_date: datoen ifølge grundrytmen (anker + n * interval).
- planned_date: den dato besøget faktisk er planlagt til (kan være flyttet).
- completed_date: hvornår arbejdet reelt blev udført.
"""
from datetime import date, timedelta

from django.core.exceptions import ValidationError
from django.db import transaction

from ..models import Employee, ServiceAgreement, Visit
from . import audit
from .calendar_dk import next_workday

KEEP_RHYTHM = "behold"
SHIFT_SERIES = "forskyd"


def rhythm_dates(agreement: ServiceAgreement, start: date, until: date):
    step = timedelta(weeks=agreement.interval_weeks)
    d = agreement.anchor_date
    if d < start:
        # Spring direkte frem til første rytmedato >= start.
        n = -(-(start - d).days // step.days)
        d = d + n * step
    while d <= until:
        yield d
        d += step


@transaction.atomic
def generate_visits(agreement: ServiceAgreement, until: date, start: date | None = None) -> list[Visit]:
    """Opret manglende planlagte besøg. Kan køres igen uden at danne dubletter."""
    if not agreement.active:
        return []
    start = start or date.today()
    existing = set(agreement.visits.values_list("rhythm_date", flat=True))
    created = []
    for rd in rhythm_dates(agreement, start, until):
        if rd in existing or not agreement.in_season(rd):
            continue
        created.append(Visit.objects.create(
            agreement=agreement,
            route=agreement.route,
            employee=agreement.route.employee,
            rhythm_date=rd,
            planned_date=next_workday(rd),
            price=agreement.price,
        ))
    return created


@transaction.atomic
def reschedule(visit: Visit, new_date: date, mode: str, actor: Employee) -> list[Visit]:
    """Flyt et besøg.

    behold  – kun dette besøg flyttes; næste besøg følger stadig grundrytmen.
    forskyd – dette og alle senere planlagte besøg i serien rykkes lige så meget,
              og grundrytmen (ankeret) flyttes med.
    """
    visit = Visit.objects.select_for_update().get(pk=visit.pk)
    if visit.is_final:
        raise ValidationError("Et afsluttet besøg kan ikke flyttes.")
    old = visit.planned_date
    if mode == KEEP_RHYTHM:
        visit.planned_date = new_date
        visit.status = Visit.Status.PLANNED
        visit.save()
        audit.log(actor, "besoeg_flyttet", visit, fra=old, til=new_date, valg=mode)
        return [visit]
    if mode != SHIFT_SERIES:
        raise ValidationError("Ukendt valg for flytning.")

    delta = new_date - old
    agreement = ServiceAgreement.objects.select_for_update().get(pk=visit.agreement_id)
    series = list(agreement.visits.filter(rhythm_date__gte=visit.rhythm_date)
                  .exclude(status__in=Visit.FINAL))
    moving_ids = {v.pk for v in series}
    taken = set(agreement.visits.exclude(pk__in=moving_ids).values_list("rhythm_date", flat=True))
    if any(v.rhythm_date + delta in taken for v in series):
        raise ValidationError("Flytningen ville ramme et eksisterende besøg i serien.")

    # Opdatér i en rækkefølge, der undgår midlertidige dubletter på rytmedatoen.
    series.sort(key=lambda v: v.rhythm_date, reverse=delta.days > 0)
    for v in series:
        v.rhythm_date += delta
        v.planned_date = new_date if v.pk == visit.pk else next_workday(v.rhythm_date)
        v.status = Visit.Status.PLANNED
        v.save()
    agreement.anchor_date += delta
    agreement.save(update_fields=["anchor_date"])
    audit.log(actor, "serie_forskudt", visit, fra=old, til=new_date, dage=delta.days, antal=len(series))
    return series
