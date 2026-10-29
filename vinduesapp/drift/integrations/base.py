from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


class IntegrationError(Exception):
    """Fejl fra en ekstern tjeneste. Handlingen må genforsøges."""


def require_live_permission(name: str) -> None:
    """Live-adaptere må kun bruges efter ejerens eksplicitte godkendelse."""
    if not settings.ALLOW_LIVE_INTEGRATIONS:
        raise ImproperlyConfigured(
            f"{name}: live-integration er ikke godkendt. Sæt ALLOW_LIVE_INTEGRATIONS=ja "
            "først efter skriftlig godkendelse fra ejeren."
        )
