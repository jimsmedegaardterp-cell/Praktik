from ..models import AuditEvent, Employee


def log(actor: Employee | None, action: str, obj, **data) -> AuditEvent:
    """Skriv en revisionshændelse. Læg aldrig beskedtekster, adgangskoder el.lign. i data."""
    return AuditEvent.objects.create(
        actor=actor,
        action=action,
        object_type=type(obj).__name__,
        object_id=str(obj.pk),
        data={k: str(v) for k, v in data.items()},
    )
