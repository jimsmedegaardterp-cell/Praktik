"""Tests af de kritiske flows. Numre henviser til accepttests i PROJEKTBESKRIVELSE.md §11."""
import json
import uuid
from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth.models import User
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase, override_settings
from django.urls import reverse

from .integrations.economic import MockEconomicAdapter
from .integrations.sms import FakeSmsProvider, InboundSms, segments, sign
from .models import (Address, AuditEvent, BillingItem, Customer, Employee, InvoiceDraft, MockEconomicInvoice,
                     Route, Service, ServiceAgreement, SmsMessage, Visit, WorkLog)
from .services import billing, planning, sms, visits
from .services.calendar_dk import closed_days, easter_sunday

MONDAY = date(2027, 8, 2)  # en mandag; ingen helligdage på de følgende 4-ugers mandage


def make_employee(username, role=Employee.Role.WORKER):
    user = User.objects.create_user(username, password="test-adgang-123456")
    return Employee.objects.create(user=user, role=role)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])  # hurtige tests
class Fixture(TestCase):
    def setUp(self):
        self.admin = make_employee("admin", Employee.Role.ADMIN)
        self.worker = make_employee("m1")
        self.other = make_employee("m2")
        self.route = Route.objects.create(name="Mandag", weekday=0, employee=self.worker)
        self.service = Service.objects.create(name="Vinduer", default_price=Decimal("250"))
        self.customer = Customer.objects.create(name="Test Kunde", phone="+4599990001")
        self.address = Address.objects.create(customer=self.customer, street="Testvej 1", postal_code="8000", city="Testby")
        self.agreement = self.agreement_for(self.address, Decimal("250"))

    def agreement_for(self, address, price, interval=4):
        return ServiceAgreement.objects.create(
            customer=address.customer, address=address, service=self.service, route=self.route,
            price=price, interval_weeks=interval, anchor_date=MONDAY)

    def visits(self, agreement=None, weeks=20):
        planning.generate_visits(agreement or self.agreement, until=MONDAY + timedelta(weeks=weeks), start=MONDAY)
        return list((agreement or self.agreement).visits.order_by("rhythm_date"))

    def done(self, visit, employee=None, event=None, **kw):
        return visits.register(visit.pk, employee or self.worker, Visit.Status.DONE, event or uuid.uuid4(), **kw)


class PlanningTests(Fixture):
    def test_generates_every_interval_and_is_rerunnable(self):
        vs = self.visits()
        self.assertEqual([v.rhythm_date for v in vs], [MONDAY + timedelta(weeks=4 * i) for i in range(6)])
        planning.generate_visits(self.agreement, until=MONDAY + timedelta(weeks=20), start=MONDAY)
        self.assertEqual(self.agreement.visits.count(), 6)  # ingen dubletter

    def test_season_is_respected(self):
        self.agreement.season_start_month, self.agreement.season_end_month = 4, 10
        self.agreement.save()
        vs = self.visits(weeks=60)
        self.assertTrue(all(4 <= v.rhythm_date.month <= 10 for v in vs))

    def test_holiday_moves_planned_date_but_not_rhythm(self):
        easter_monday = easter_sunday(2027) + timedelta(days=1)  # 29.3.2027
        self.agreement.anchor_date = easter_monday
        self.agreement.save()
        v = planning.generate_visits(self.agreement, until=easter_monday, start=easter_monday)[0]
        self.assertEqual(v.rhythm_date, easter_monday)
        self.assertEqual(v.planned_date, easter_monday + timedelta(days=1))

    def test_danish_holidays(self):
        self.assertEqual(easter_sunday(2026), date(2026, 4, 5))
        self.assertIn(date(2026, 5, 14), closed_days(2026))      # Kr. himmelfart 2026
        self.assertNotIn(date(2026, 5, 1), closed_days(2026))    # Store bededag afskaffet

    # Accepttest 2
    def test_move_keep_rhythm(self):
        v1, v2 = self.visits()[:2]
        planning.reschedule(v1, v1.planned_date + timedelta(days=2), planning.KEEP_RHYTHM, self.admin)
        v1.refresh_from_db(); v2.refresh_from_db()
        self.assertEqual(v1.planned_date, MONDAY + timedelta(days=2))
        self.assertEqual(v1.rhythm_date, MONDAY)
        self.assertEqual(v2.planned_date, MONDAY + timedelta(weeks=4))

    def test_move_shift_series(self):
        v1, v2, v3 = self.visits()[:3]
        planning.reschedule(v2, v2.planned_date + timedelta(weeks=1), planning.SHIFT_SERIES, self.admin)
        for v in (v1, v2, v3):
            v.refresh_from_db()
        self.assertEqual(v1.planned_date, MONDAY)                         # tidligere urørt
        self.assertEqual(v2.planned_date, MONDAY + timedelta(weeks=5))
        self.assertEqual(v3.planned_date, MONDAY + timedelta(weeks=9))
        self.agreement.refresh_from_db()
        self.assertEqual(self.agreement.anchor_date, MONDAY + timedelta(weeks=1))
        # Ny planlægning følger den nye rytme uden dubletter.
        planning.generate_visits(self.agreement, until=MONDAY + timedelta(weeks=30), start=MONDAY + timedelta(weeks=2))
        dates = list(self.agreement.visits.values_list("rhythm_date", flat=True))
        self.assertEqual(len(dates), len(set(dates)))
        self.assertTrue(all((d - (MONDAY + timedelta(weeks=1))).days % 28 == 0 for d in dates if d > MONDAY))

    def test_shift_backwards_onto_existing_visit_is_rejected(self):
        v1, v2 = self.visits()[:2]
        self.done(v1)
        with self.assertRaises(ValidationError):
            planning.reschedule(v2, v1.planned_date, planning.SHIFT_SERIES, self.admin)

    def test_final_visit_cannot_be_moved(self):
        v1 = self.visits()[0]
        self.done(v1)
        with self.assertRaises(ValidationError):
            planning.reschedule(v1, MONDAY + timedelta(days=1), planning.KEEP_RHYTHM, self.admin)


class VisitRegistrationTests(Fixture):
    # Accepttest 1
    def test_same_event_twice_is_idempotent(self):
        v = self.visits()[0]
        event = uuid.uuid4()
        r1 = self.done(v, event=event)
        r2 = self.done(v, event=event)
        self.assertTrue(r1.created)
        self.assertFalse(r2.created)
        self.assertEqual(WorkLog.objects.count(), 1)
        self.assertEqual(BillingItem.objects.count(), 1)

    def test_double_tap_with_new_event_does_not_duplicate(self):
        v = self.visits()[0]
        self.done(v)
        r = self.done(v)
        self.assertFalse(r.created)
        self.assertEqual(BillingItem.objects.count(), 1)

    # Accepttest 5
    def test_invoiced_visit_never_creates_new_billing_item(self):
        v = self.visits()[0]
        self.done(v)
        billing.approve([v.billing_item.pk], self.admin)
        for d in billing.build_drafts(self.admin):
            billing.push_draft(d, MockEconomicAdapter(), self.admin)
        r = visits.register(v.pk, self.admin, Visit.Status.PARTIAL, uuid.uuid4())
        self.assertFalse(r.created)
        self.assertEqual(BillingItem.objects.count(), 1)

    def test_price_change_requires_approval(self):
        v = self.visits()[0]
        self.done(v, proposed_price=Decimal("200"))
        item = BillingItem.objects.get()
        self.assertEqual(item.status, BillingItem.Status.NEEDS_APPROVAL)
        self.assertEqual(item.amount, Decimal("200"))

    def test_not_billable_outcomes(self):
        v1, v2 = self.visits()[:2]
        visits.register(v1.pk, self.worker, Visit.Status.NO_ACCESS, uuid.uuid4())
        visits.register(v2.pk, self.worker, Visit.Status.CANCELLED, uuid.uuid4())
        self.assertEqual(BillingItem.objects.count(), 0)

    def test_postponed_can_be_registered_later(self):
        v = self.visits()[0]
        visits.register(v.pk, self.worker, Visit.Status.POSTPONED, uuid.uuid4())
        planning.reschedule(v, MONDAY + timedelta(days=1), planning.KEEP_RHYTHM, self.admin)
        self.assertTrue(self.done(v).created)

    # Accepttest 8
    def test_worker_cannot_register_other_workers_visit(self):
        v = self.visits()[0]
        with self.assertRaises(PermissionDenied):
            self.done(v, employee=self.other)

    def test_audit_trail(self):
        v = self.visits()[0]
        self.done(v)
        self.assertTrue(AuditEvent.objects.filter(action="besoeg_registreret", object_id=str(v.pk), actor=self.worker).exists())


class BillingTests(Fixture):
    def prepare(self, n=2):
        for v in self.visits()[:n]:
            self.done(v)
        billing.approve(BillingItem.objects.values_list("pk", flat=True), self.admin)
        return billing.build_drafts(self.admin)

    def test_collective_invoice_one_draft_per_customer(self):
        drafts = self.prepare(2)
        self.assertEqual(len(drafts), 1)
        self.assertEqual(drafts[0].items.count(), 2)

    # Accepttest 4
    def test_push_twice_creates_one_remote_draft(self):
        draft = self.prepare()[0]
        a = MockEconomicAdapter()
        billing.push_draft(draft, a, self.admin)
        billing.push_draft(draft, a, self.admin)
        self.assertEqual(MockEconomicInvoice.objects.count(), 1)
        draft.refresh_from_db()
        self.assertEqual(draft.status, InvoiceDraft.Status.DRAFT)

    def test_timeout_after_create_then_retry_finds_existing(self):
        draft = self.prepare()[0]
        billing.push_draft(draft, MockEconomicAdapter(fail_after_create=True), self.admin)
        draft.refresh_from_db()
        self.assertEqual(draft.status, InvoiceDraft.Status.ERROR)
        billing.push_draft(draft, MockEconomicAdapter(), self.admin)
        draft.refresh_from_db()
        self.assertEqual(MockEconomicInvoice.objects.count(), 1)
        self.assertEqual(draft.status, InvoiceDraft.Status.DRAFT)
        self.assertEqual(draft.economic_draft_number, MockEconomicInvoice.objects.get().pk)

    def test_error_is_shown_and_never_marked_sent(self):
        draft = self.prepare()[0]
        billing.push_draft(draft, MockEconomicAdapter(fail_before_create=True), self.admin)
        draft.refresh_from_db()
        self.assertEqual(draft.status, InvoiceDraft.Status.ERROR)
        self.assertIsNone(draft.economic_draft_number)
        self.assertTrue(draft.items.filter(status=BillingItem.Status.APPROVED).exists())

    def test_status_comes_from_economic(self):
        draft = self.prepare()[0]
        a = MockEconomicAdapter()
        billing.push_draft(draft, a, self.admin)
        draft.refresh_from_db()
        a.simulate_book(draft.economic_draft_number)
        billing.sync_status(a)
        draft.refresh_from_db()
        self.assertEqual(draft.status, InvoiceDraft.Status.BOOKED)
        self.assertIsNotNone(draft.economic_invoice_number)
        a.simulate_paid(draft.economic_draft_number)
        billing.sync_status(a)
        draft.refresh_from_db()
        self.assertEqual(draft.status, InvoiceDraft.Status.PAID)

    def test_customer_synced_once(self):
        a = MockEconomicAdapter()
        n1 = a.ensure_customer(self.customer)
        n2 = a.ensure_customer(Customer.objects.get(pk=self.customer.pk))
        self.assertEqual(n1, n2)

    # Accepttest 3
    def test_two_addresses_are_not_confused(self):
        summer = Address.objects.create(customer=self.customer, street="Klitvej 7", postal_code="6990", city="Strand")
        ag2 = self.agreement_for(summer, Decimal("150"), interval=8)
        v_home = self.visits()[0]
        v_summer = self.visits(ag2)[0]
        self.done(v_home)
        self.done(v_summer)
        self.assertEqual(v_home.billing_item.amount, Decimal("250"))
        self.assertEqual(BillingItem.objects.get(visit=v_summer).amount, Decimal("150"))
        self.assertNotEqual(v_home.pk, v_summer.pk)
        self.assertEqual(v_home.rhythm_date, v_summer.rhythm_date)  # samme dag, alligevel adskilt


class SmsTests(Fixture):
    def test_phone_normalization(self):
        self.assertEqual(sms.normalize_phone("99 99 00 01"), "+4599990001")
        self.assertEqual(sms.normalize_phone("004599990001"), "+4599990001")

    # Accepttest 7
    def test_inbound_lands_in_thread_and_unknown_goes_to_inbox(self):
        p = FakeSmsProvider()
        sms.receive(p, [InboundSms("a1", "99990001", "Hej"), InboundSms("a2", "+4511111111", "Hvem?")])
        known = SmsMessage.objects.get(provider_message_id="a1")
        unknown = SmsMessage.objects.get(provider_message_id="a2")
        self.assertEqual(known.customer, self.customer)
        self.assertIsNone(unknown.customer)

    def test_duplicate_shared_phone_is_not_guessed(self):
        Customer.objects.create(name="Samme nr.", phone="+4599990001")
        sms.receive(FakeSmsProvider(), [InboundSms("b1", "+4599990001", "Hej")])
        self.assertIsNone(SmsMessage.objects.get().customer)

    def test_inbound_duplicate_event_handled_once(self):
        p = FakeSmsProvider()
        item = InboundSms("dup", "+4599990001", "Hej")
        self.assertEqual(sms.receive(p, [item]), 1)
        self.assertEqual(sms.receive(p, [item]), 0)

    def test_outbound_idempotent(self):
        p = FakeSmsProvider()
        sms.send(self.customer, "Hej", "k1", p, self.admin)
        sms.send(self.customer, "Hej", "k1", p, self.admin)
        self.assertEqual(SmsMessage.objects.count(), 1)

    def test_segments(self):
        self.assertEqual(segments("Æble ø å " * 17), 1)       # 153 tegn, GSM-7
        self.assertEqual(segments("x" * 161), 2)
        self.assertEqual(segments("Hej 🙂"), 1)               # UCS-2
        self.assertEqual(segments("🙂" * 40), 2)

    @override_settings(SMS_WEBHOOK_SECRET="hemmelig")
    def test_webhook_requires_valid_signature(self):
        raw = json.dumps({"id": "w1", "msisdn": "+4599990001", "message": "Hej"}).encode()
        url = reverse("sms_webhook")
        bad = self.client.post(url, raw, content_type="application/json", headers={"X-Signature": "forkert"})
        self.assertEqual(bad.status_code, 401)
        ok = self.client.post(url, raw, content_type="application/json", headers={"X-Signature": sign(raw, "hemmelig")})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(SmsMessage.objects.count(), 1)


class AccessTests(Fixture):
    def login(self, employee):
        self.client.force_login(employee.user)

    # Accepttest 8
    def test_worker_cannot_open_admin_pages(self):
        self.login(self.worker)
        for name in ["customer_list", "routes_week", "invoices", "sms_inbox", "audit_log"]:
            self.assertEqual(self.client.get(reverse(name)).status_code, 403, name)

    def test_worker_sees_only_own_visits(self):
        other_route = Route.objects.create(name="Tirsdag", weekday=0, employee=self.other)
        self.agreement.route = other_route
        self.agreement.save()
        v = self.visits()[0]  # tilhører nu m2
        self.login(self.worker)
        page = self.client.get(reverse("mobile_day") + f"?dato={v.planned_date}")
        self.assertNotContains(page, self.customer.name)
        r = self.client.post(reverse("mobile_register", args=[v.pk]),
                             json.dumps({"event_id": str(uuid.uuid4()), "outcome": "udfoert"}),
                             content_type="application/json")
        self.assertEqual(r.status_code, 403)

    def test_mobile_json_flow_is_idempotent(self):
        v = self.visits()[0]
        self.login(self.worker)
        body = json.dumps({"event_id": str(uuid.uuid4()), "outcome": "udfoert", "note": "", "price": ""})
        url = reverse("mobile_register", args=[v.pk])
        r1 = self.client.post(url, body, content_type="application/json").json()
        r2 = self.client.post(url, body, content_type="application/json").json()
        self.assertTrue(r1["created"])
        self.assertFalse(r2["created"])
        self.assertEqual(BillingItem.objects.count(), 1)

    def test_anonymous_is_redirected(self):
        self.assertEqual(self.client.get(reverse("start")).status_code, 302)

    def test_admin_pages_render(self):
        self.visits()
        self.login(self.admin)
        for name in ["start", "customer_list", "routes_week", "invoices", "sms_inbox", "audit_log", "mobile_day"]:
            self.assertEqual(self.client.get(reverse(name)).status_code, 200, name)
        self.assertEqual(self.client.get(reverse("customer_detail", args=[self.customer.pk])).status_code, 200)
