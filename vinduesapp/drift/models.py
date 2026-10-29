"""Domænemodel.

Appen ejer kunder, aftaler, ruter, besøg og intern historik.
e-conomic ejer fakturaer, bogføring, moms og betalinger — her gemmes kun
koblinger (numre og status), aldrig en parallel bogføring.

Beløb er i DKK ekskl. moms; moms beregnes af e-conomic.
"""
import uuid

from django.conf import settings
from django.db import models


class Employee(models.Model):
    class Role(models.TextChoices):
        ADMIN = "admin", "Ejer/administrator"
        WORKER = "medarbejder", "Medarbejder"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="employee")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.WORKER)
    phone = models.CharField(max_length=20, blank=True)

    @property
    def is_admin(self) -> bool:
        return self.role == self.Role.ADMIN

    def __str__(self):
        return self.user.get_full_name() or self.user.username


class Customer(models.Model):
    name = models.CharField("navn", max_length=200)
    phone = models.CharField("telefon (+45…)", max_length=20, blank=True, db_index=True)
    email = models.EmailField("e-mail", blank=True)
    is_business = models.BooleanField("erhvervskunde", default=False)
    notes = models.TextField("bemærkninger", blank=True)
    # Stabil kobling til e-conomic. Udfyldes først når kunden er synkroniseret.
    economic_customer_number = models.PositiveIntegerField(null=True, blank=True, unique=True)
    # Reference til SkvizBiz-ID ved import (historisk, ikke en nøgle i appen).
    legacy_id = models.CharField(max_length=50, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Address(models.Model):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="addresses")
    street = models.CharField("adresse", max_length=200)
    postal_code = models.CharField("postnr.", max_length=4)
    city = models.CharField("by", max_length=100)
    access_notes = models.TextField("adgangsforhold", blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    def __str__(self):
        return f"{self.street}, {self.postal_code} {self.city}"

    @property
    def maps_query(self) -> str:
        return f"{self.street}, {self.postal_code} {self.city}, Danmark"


class Service(models.Model):
    name = models.CharField("ydelse", max_length=100)
    default_price = models.DecimalField("standardpris", max_digits=10, decimal_places=2)
    economic_product_number = models.CharField(max_length=25, blank=True)

    def __str__(self):
        return self.name


class Route(models.Model):
    WEEKDAYS = [(0, "Mandag"), (1, "Tirsdag"), (2, "Onsdag"), (3, "Torsdag"), (4, "Fredag"), (5, "Lørdag")]
    name = models.CharField("rute", max_length=100)
    weekday = models.PositiveSmallIntegerField("fast ugedag", choices=WEEKDAYS)
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="routes")

    class Meta:
        ordering = ["weekday", "name"]

    def __str__(self):
        return self.name


class ServiceAgreement(models.Model):
    """Fast aftale: hvilken ydelse, på hvilken adresse, hvor ofte, til hvilken pris."""

    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="agreements")
    address = models.ForeignKey(Address, on_delete=models.PROTECT, related_name="agreements")
    service = models.ForeignKey(Service, on_delete=models.PROTECT)
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="agreements")
    price = models.DecimalField("aftalt pris", max_digits=10, decimal_places=2)
    interval_weeks = models.PositiveSmallIntegerField("interval (uger)", default=4)
    # Grundrytme: første dato i serien. Alle rytmedatoer = anker + n * interval.
    anchor_date = models.DateField("grundrytme starter")
    season_start_month = models.PositiveSmallIntegerField("sæson fra måned", default=1)
    season_end_month = models.PositiveSmallIntegerField("sæson til måned", default=12)
    route_order = models.PositiveIntegerField("rækkefølge på rute", default=0)
    active = models.BooleanField(default=True)

    def __str__(self):
        return f"{self.customer} – {self.service} ({self.address.street})"

    def in_season(self, day) -> bool:
        s, e = self.season_start_month, self.season_end_month
        return s <= day.month <= e if s <= e else (day.month >= s or day.month <= e)


class Visit(models.Model):
    class Status(models.TextChoices):
        PLANNED = "planlagt", "Planlagt"
        DONE = "udfoert", "Udført"
        PARTIAL = "delvist", "Delvist udført"
        NO_ACCESS = "forgaeves", "Forgæves besøg"
        POSTPONED = "udsat", "Udsat"
        CANCELLED = "aflyst", "Aflyst"

    FINAL = {Status.DONE, Status.PARTIAL, Status.NO_ACCESS, Status.CANCELLED}
    BILLABLE = {Status.DONE, Status.PARTIAL}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agreement = models.ForeignKey(ServiceAgreement, on_delete=models.PROTECT, related_name="visits")
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="visits")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="visits")
    rhythm_date = models.DateField("grundrytme-dato")
    planned_date = models.DateField("planlagt dato", db_index=True)
    completed_date = models.DateField("faktisk udført", null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLANNED)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["planned_date", "agreement__route_order"]
        constraints = [
            # Samme aftale kan aldrig have to besøg på samme rytmedato.
            models.UniqueConstraint(fields=["agreement", "rhythm_date"], name="unik_besoeg_pr_rytmedato"),
        ]

    def __str__(self):
        return f"{self.agreement.customer} {self.planned_date}"

    @property
    def is_final(self) -> bool:
        return self.status in self.FINAL


class WorkLog(models.Model):
    """Én registrering fra marken. client_event_id gør genafsendelse idempotent."""

    visit = models.ForeignKey(Visit, on_delete=models.PROTECT, related_name="worklogs")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT)
    outcome = models.CharField(max_length=20, choices=Visit.Status.choices)
    note = models.TextField(blank=True)
    proposed_price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    client_event_id = models.UUIDField(unique=True)
    created_at = models.DateTimeField(auto_now_add=True)


class InvoiceDraft(models.Model):
    """Kobling til én fakturakladde i e-conomic (kan samle flere besøg)."""

    class Status(models.TextChoices):
        PENDING = "afventer", "Afventer afsendelse til e-conomic"
        DRAFT = "kladde", "Kladde oprettet i e-conomic"
        BOOKED = "bogfoert", "Bogført i e-conomic"
        PAID = "betalt", "Betalt (ifølge e-conomic)"
        ERROR = "fejl", "Fejl – kan genforsøges"

    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="invoice_drafts")
    # Sendes med til e-conomic som reference, så et genforsøg kan genkende kladden.
    idempotency_key = models.UUIDField(unique=True, default=uuid.uuid4, editable=False)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    economic_draft_number = models.PositiveIntegerField(null=True, blank=True, unique=True)
    economic_invoice_number = models.PositiveIntegerField(null=True, blank=True, unique=True)
    last_error = models.TextField(blank=True)
    attempts = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]


class BillingItem(models.Model):
    """Fakturakø: præcis én linje pr. faktureret besøg (OneToOne)."""

    class Status(models.TextChoices):
        NEEDS_APPROVAL = "kraever_godkendelse", "Prisændring kræver godkendelse"
        READY = "klar", "Klar til godkendelse"
        APPROVED = "godkendt", "Godkendt"
        INVOICED = "faktureret", "Lagt på fakturakladde"
        WITHDRAWN = "annulleret", "Annulleret"

    visit = models.OneToOneField(Visit, on_delete=models.PROTECT, related_name="billing_item")
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="billing_items")
    description = models.CharField(max_length=255)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.READY)
    invoice_draft = models.ForeignKey(InvoiceDraft, on_delete=models.PROTECT, null=True, blank=True, related_name="items")
    approved_by = models.ForeignKey(Employee, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["visit__planned_date"]


class SmsMessage(models.Model):
    class Direction(models.TextChoices):
        OUT = "ud", "Udgående"
        IN = "ind", "Indgående"

    class Status(models.TextChoices):
        PREPARED = "klargjort", "Klargjort"
        SENT = "afsendt", "Afsendt"
        DELIVERED = "leveret", "Leveret"
        FAILED = "fejlet", "Fejlet"
        RECEIVED = "modtaget", "Modtaget"

    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name="sms")
    direction = models.CharField(max_length=5, choices=Direction.choices)
    phone = models.CharField(max_length=20, db_index=True)
    body = models.TextField()
    status = models.CharField(max_length=20, choices=Status.choices)
    provider = models.CharField(max_length=30)
    provider_message_id = models.CharField(max_length=100, null=True, blank=True)
    # Udgående: vores egen nøgle, så samme besked ikke sendes to gange.
    idempotency_key = models.CharField(max_length=100, null=True, blank=True, unique=True)
    is_handled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(fields=["provider", "provider_message_id"], name="unik_provider_besked"),
        ]


class AuditEvent(models.Model):
    """Revisionsspor. Indeholder handlinger og ID'er – ikke beskedtekster eller andet følsomt."""

    actor = models.ForeignKey(Employee, on_delete=models.PROTECT, null=True, blank=True)
    action = models.CharField(max_length=60)
    object_type = models.CharField(max_length=40)
    object_id = models.CharField(max_length=64)
    data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]


class MockEconomicInvoice(models.Model):
    """Kun til demo/test: simulerer e-conomics side. Bruges aldrig i produktion."""

    draft_number = models.AutoField(primary_key=True)
    customer_number = models.PositiveIntegerField()
    reference = models.CharField(max_length=100, unique=True)
    lines = models.JSONField()
    booked_number = models.PositiveIntegerField(null=True, blank=True)
    paid = models.BooleanField(default=False)
