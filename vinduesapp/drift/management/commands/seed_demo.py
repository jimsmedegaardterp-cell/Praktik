"""Opretter fiktive testdata. Nægter at køre uden DJANGO_DEBUG (dvs. aldrig i produktion)."""
import random
import uuid
from datetime import date, timedelta
from decimal import Decimal

from django.conf import settings
from django.contrib.auth.models import User
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from drift.integrations.economic import MockEconomicAdapter
from drift.models import Address, Customer, Employee, Route, Service, ServiceAgreement, Visit
from drift.services import billing, planning, sms, visits

PASSWORD = "demo-adgang-2026"
FORNAVNE = ["Anne", "Bo", "Camilla", "Dorthe", "Erik", "Freja", "Gitte", "Hans", "Ida", "Jens", "Karen", "Lars",
            "Mette", "Niels", "Ole", "Pia", "Rasmus", "Susanne", "Torben", "Ulla", "Vibeke", "Søren"]
EFTERNAVNE = ["Testesen", "Prøvesen", "Demohøj", "Fiktivsen", "Eksempelgaard"]
VEJE = ["Testvej", "Prøvestien", "Demoallé", "Eksempelparken", "Fiktivgade"]
ADGANG = ["", "", "", "Nøgle i nøgleboks, kode 1234", "Hund i haven – ring først", "Låge bag carport", "Pas på bede"]


class Command(BaseCommand):
    help = "Nulstil og indlæs fiktive demodata"

    def handle(self, *args, **opts):
        if not settings.DEBUG:
            raise CommandError("seed_demo må kun køre i demo/udvikling (DJANGO_DEBUG=ja).")
        random.seed(42)
        with transaction.atomic():
            self.seed()
        self.stdout.write(self.style.SUCCESS(f"Demodata klar. Log ind som admin/medarbejder1/medarbejder2 med '{PASSWORD}'."))

    def user(self, username, first, last, role):
        u = User.objects.create_user(username, password=PASSWORD, first_name=first, last_name=last)
        return Employee.objects.create(user=u, role=role)

    def seed(self):
        from django.core.management import call_command
        call_command("flush", interactive=False, verbosity=0)

        admin = self.user("admin", "Ejer", "Demo", Employee.Role.ADMIN)
        m1 = self.user("medarbejder1", "Mads", "Medarbejder", Employee.Role.WORKER)
        m2 = self.user("medarbejder2", "Line", "Medarbejder", Employee.Role.WORKER)

        ude = Service.objects.create(name="Vinduespudsning udvendig", default_price=Decimal("250"), economic_product_number="1")
        begge = Service.objects.create(name="Vinduespudsning ud- og indvendig", default_price=Decimal("450"), economic_product_number="2")
        ovenlys = Service.objects.create(name="Ovenlysvinduer", default_price=Decimal("150"), economic_product_number="3")

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        routes = [
            Route.objects.create(name="Mandag Nord", weekday=0, employee=m1),
            Route.objects.create(name="Tirsdag Syd", weekday=1, employee=m2),
            Route.objects.create(name="Torsdag By", weekday=3, employee=m1),
            Route.objects.create(name="Fredag Land", weekday=4, employee=m2),
        ]

        n = 0
        for i in range(80):
            route = routes[i % len(routes)]
            n += 1
            name = f"{FORNAVNE[i % len(FORNAVNE)]} {EFTERNAVNE[(i // len(FORNAVNE)) % len(EFTERNAVNE)]}"  # unikke navne
            c = Customer.objects.create(name=name, phone=f"+459999{i:04d}",
                                        notes="Fiktiv testkunde.", is_business=(i % 9 == 0))
            a = Address.objects.create(customer=c, street=f"{VEJE[i % 5]} {i + 1}", postal_code=str(8000 + (i % 4) * 10),
                                       city="Testby", access_notes=random.choice(ADGANG))
            interval = random.choice([4, 4, 8, 8, 12])
            # Anker i fortiden på rutens ugedag, så der både er historik og kommende besøg.
            offset = random.randrange(interval)
            anchor = monday + timedelta(days=route.weekday) - timedelta(weeks=12 + offset)
            service = begge if i % 5 == 0 else ude
            ServiceAgreement.objects.create(customer=c, address=a, service=service, route=route,
                                            price=service.default_price + Decimal(10 * (i % 4)),
                                            interval_weeks=interval, anchor_date=anchor, route_order=i,
                                            season_start_month=4 if i % 7 == 0 else 1,
                                            season_end_month=10 if i % 7 == 0 else 12)
        # Accepttest 3: samme kunde, to adresser og to aftaler.
        c = Customer.objects.get(phone="+4599990001")
        sommerhus = Address.objects.create(customer=c, street="Klitvej 7 (sommerhus)", postal_code="6990", city="Testby Strand",
                                           access_notes="Nøgle hos naboen nr. 9")
        ServiceAgreement.objects.create(customer=c, address=sommerhus, service=ovenlys, route=routes[3], price=Decimal("150"),
                                        interval_weeks=8, anchor_date=monday + timedelta(days=4) - timedelta(weeks=6), route_order=99)

        start = monday - timedelta(weeks=6)
        for ag in ServiceAgreement.objects.all():
            planning.generate_visits(ag, until=today + timedelta(weeks=26), start=start)

        # Historik: alt før i dag er registreret.
        past = Visit.objects.filter(planned_date__lt=today).select_related("employee")
        for v in past:
            r = random.random()
            outcome = Visit.Status.DONE if r < 0.85 else (Visit.Status.NO_ACCESS if r < 0.93 else Visit.Status.PARTIAL)
            note = "Kun forsiden – stige for kort" if outcome == Visit.Status.PARTIAL else ""
            visits.register(v.pk, v.employee, outcome, uuid.uuid4(), note=note, on_date=v.planned_date)
        # Ældre linjer er godkendt og sendt til (mock) e-conomic; nogle er bogført/betalt.
        old = [v.billing_item.pk for v in Visit.objects.filter(planned_date__lt=monday - timedelta(weeks=1), status=Visit.Status.DONE)]
        billing.approve(old, admin)
        adapter = MockEconomicAdapter()
        for d in billing.build_drafts(admin):
            billing.push_draft(d, adapter, admin)
        for k, d in enumerate(Customer.objects.filter(invoice_drafts__isnull=False).distinct()):
            for draft in d.invoice_drafts.all():
                if k % 3 != 2:
                    adapter.simulate_book(draft.economic_draft_number)
                if k % 3 == 0:
                    adapter.simulate_paid(draft.economic_draft_number)
        billing.sync_status(adapter)

        # SMS: en samtale og en besked fra ukendt nummer.
        from drift.integrations.sms import FakeSmsProvider, InboundSms
        p = FakeSmsProvider()
        k = Customer.objects.get(phone="+4599990002")
        sms.send(k, f"Hej {k.name}. Demo Vinduespudsning kommer i næste uge. Svar gerne her.", "seed-1", p, admin)
        sms.receive(p, [InboundSms("seed-in-1", k.phone, "Fint, men husk at lukke lågen pga. hunden 🙂"),
                        InboundSms("seed-in-2", "+4512345678", "Hej, kan I også pudse mine vinduer? Mvh nabo")])
