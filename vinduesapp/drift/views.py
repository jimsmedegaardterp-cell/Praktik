import json
import uuid
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from functools import wraps

from django import forms
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Case, Count, IntegerField, Q, Sum, Value, When
from django.http import HttpResponse, HttpResponseBadRequest, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .integrations.economic import MockEconomicAdapter, get_economic
from .integrations.sms import get_sms_provider, segments, sign
from .models import (Address, AuditEvent, BillingItem, Customer, Employee, InvoiceDraft, Route,
                     Service, ServiceAgreement, SmsMessage, Visit)
from .services import audit, billing, planning, sms as sms_service, visits as visit_service


# --- Adgangskontrol (server-side på alle views) -------------------------------

def employee_required(view):
    @login_required
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        employee = getattr(request.user, "employee", None)
        if employee is None:
            raise PermissionDenied("Brugeren er ikke tilknyttet som medarbejder.")
        request.employee = employee
        return view(request, *args, **kwargs)
    return wrapper


def admin_required(view):
    @employee_required
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not request.employee.is_admin:
            raise PermissionDenied("Kun for administrator.")
        return view(request, *args, **kwargs)
    return wrapper


def demo_context(request):
    return {
        "demo_mode": settings.ECONOMIC_ADAPTER == "mock" and settings.SMS_ADAPTER == "fake",
        "company_name": settings.COMPANY_NAME,
        "me": getattr(request.user, "employee", None) if request.user.is_authenticated else None,
    }


def parse_date(value, default):
    try:
        return date.fromisoformat(value) if value else default
    except ValueError:
        return default


# --- Administration -----------------------------------------------------------

@employee_required
def start(request):
    if not request.employee.is_admin:
        return redirect("mobile_day")
    today = parse_date(request.GET.get("dato"), date.today())
    week_start = today - timedelta(days=today.weekday())
    week = Visit.objects.filter(planned_date__range=(week_start, week_start + timedelta(days=6)))
    ctx = {
        "today": today,
        "todays_routes": Route.objects.annotate(
            total=Count("visits", filter=Q(visits__planned_date=today)),
            done=Count("visits", filter=Q(visits__planned_date=today, visits__status__in=Visit.FINAL)),
        ).filter(total__gt=0),
        "week_counts": [(r["status"], Visit.Status(r["status"]).label, r["n"])
                        for r in week.values("status").annotate(n=Count("id")).order_by("status")],
        "postponed": Visit.objects.filter(status=Visit.Status.POSTPONED).select_related("agreement__customer"),
        "queue_ready": BillingItem.objects.filter(status__in=[BillingItem.Status.READY, BillingItem.Status.NEEDS_APPROVAL]).aggregate(n=Count("id"), s=Sum("amount")),
        "drafts_error": InvoiceDraft.objects.filter(status=InvoiceDraft.Status.ERROR).count(),
        "unhandled_sms": SmsMessage.objects.filter(direction=SmsMessage.Direction.IN, is_handled=False).count(),
        "unknown_sms": SmsMessage.objects.filter(direction=SmsMessage.Direction.IN, customer__isnull=True).count(),
    }
    return render(request, "drift/start.html", ctx)


@admin_required
def customer_list(request):
    q = request.GET.get("q", "").strip()
    customers = Customer.objects.all()
    if q:
        customers = customers.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(addresses__street__icontains=q)).distinct()
    return render(request, "drift/customer_list.html", {"customers": customers.prefetch_related("addresses"), "q": q})


@admin_required
def customer_detail(request, pk):
    customer = get_object_or_404(Customer, pk=pk)
    today = date.today()
    ctx = {
        "customer": customer,
        "agreements": customer.agreements.select_related("address", "service", "route"),
        "upcoming": Visit.objects.filter(agreement__customer=customer, planned_date__gte=today, status=Visit.Status.PLANNED).select_related("agreement__address")[:8],
        "history": Visit.objects.filter(agreement__customer=customer).exclude(status=Visit.Status.PLANNED).select_related("agreement__address").order_by("-planned_date")[:20],
        "sms": customer.sms.all(),
        "drafts": customer.invoice_drafts.all(),
    }
    return render(request, "drift/customer_detail.html", ctx)


class NewCustomerForm(forms.Form):
    name = forms.CharField(label="Navn", max_length=200)
    phone = forms.CharField(label="Mobil", max_length=20, required=False)
    email = forms.EmailField(label="E-mail", required=False)
    street = forms.CharField(label="Adresse", max_length=200)
    postal_code = forms.RegexField(label="Postnr.", regex=r"^\d{4}$", error_messages={"invalid": "Fire cifre."})
    city = forms.CharField(label="By", max_length=100)
    access_notes = forms.CharField(label="Adgangsforhold", widget=forms.Textarea(attrs={"rows": 2}), required=False)
    service = forms.ModelChoiceField(label="Ydelse", queryset=Service.objects.all())
    price = forms.DecimalField(label="Pris ekskl. moms", min_value=0, max_digits=10, decimal_places=2)
    interval_weeks = forms.IntegerField(label="Interval (uger)", min_value=1, max_value=52, initial=4)
    route = forms.ModelChoiceField(label="Rute", queryset=Route.objects.all())
    first_date = forms.DateField(label="Første besøg", widget=forms.DateInput(attrs={"type": "date"}))

    def clean_phone(self):
        phone = self.cleaned_data["phone"]
        if not phone:
            return ""
        phone = sms_service.normalize_phone(phone)
        if not (phone.startswith("+") and 9 <= len(phone) <= 16):
            raise ValidationError("Ugyldigt telefonnummer.")
        return phone

    def clean(self):
        data = super().clean()
        route, first = data.get("route"), data.get("first_date")
        if route and first and first.weekday() != route.weekday:
            self.add_error("first_date", f"Ruten kører {route.get_weekday_display().lower()}e.")
        return data


@admin_required
def customer_create(request):
    form = NewCustomerForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        d = form.cleaned_data
        customer = Customer.objects.create(name=d["name"], phone=d["phone"], email=d["email"])
        address = Address.objects.create(customer=customer, street=d["street"], postal_code=d["postal_code"],
                                         city=d["city"], access_notes=d["access_notes"])
        last = d["route"].agreements.order_by("-route_order").first()
        agreement = ServiceAgreement.objects.create(
            customer=customer, address=address, service=d["service"], route=d["route"], price=d["price"],
            interval_weeks=d["interval_weeks"], anchor_date=d["first_date"],
            route_order=(last.route_order + 1) if last else 1,
        )
        planning.generate_visits(agreement, until=d["first_date"] + timedelta(weeks=26), start=d["first_date"])
        audit.log(request.employee, "kunde_oprettet", customer)
        messages.success(request, f"{customer.name} oprettet, og besøg er planlagt et halvt år frem.")
        return redirect("customer_detail", pk=customer.pk)
    return render(request, "drift/customer_form.html", {"form": form})


@admin_required
def routes_week(request):
    day = parse_date(request.GET.get("uge"), date.today())
    monday = day - timedelta(days=day.weekday())
    days = [monday + timedelta(days=i) for i in range(6)]
    visits = (Visit.objects.filter(planned_date__range=(days[0], days[-1]))
              .select_related("agreement__customer", "agreement__address", "route", "employee__user"))
    grid = []
    for route in Route.objects.select_related("employee__user"):
        cells = [[v for v in visits if v.route_id == route.pk and v.planned_date == d] for d in days]
        grid.append({"route": route, "cells": cells,
                     "total": sum((v.price for c in cells for v in c), Decimal(0))})
    ctx = {"days": days, "grid": grid, "prev": monday - timedelta(weeks=1), "next": monday + timedelta(weeks=1),
           "week_no": monday.isocalendar().week, "today": date.today()}
    return render(request, "drift/routes_week.html", ctx)


@admin_required
@require_POST
def plan_ahead(request):
    until = date.today() + timedelta(weeks=26)
    n = sum(len(planning.generate_visits(a, until)) for a in ServiceAgreement.objects.filter(active=True))
    audit.log(request.employee, "besoeg_planlagt", request.employee, antal=n)
    messages.success(request, f"{n} nye besøg planlagt (frem til {until:%d.%m.%Y}). Eksisterende besøg er uændrede.")
    return redirect(request.POST.get("next") or "routes_week")


@admin_required
def visit_detail(request, pk):
    visit = get_object_or_404(Visit.objects.select_related("agreement__customer", "agreement__address", "agreement__service"), pk=pk)
    if request.method == "POST":
        new_date = parse_date(request.POST.get("new_date"), None)
        if new_date is None:
            messages.error(request, "Vælg en dato.")
        else:
            try:
                moved = planning.reschedule(visit, new_date, request.POST.get("mode"), request.employee)
                messages.success(request, f"Flyttet. {len(moved)} besøg ændret.")
                return redirect(f"{reverse('routes_week')}?uge={new_date}")
            except ValidationError as e:
                messages.error(request, " ".join(e.messages))
    following = visit.agreement.visits.filter(rhythm_date__gt=visit.rhythm_date)[:3]
    return render(request, "drift/visit_detail.html", {"visit": visit, "following": following,
                                                       "worklogs": visit.worklogs.select_related("employee__user")})


@admin_required
@transaction.non_atomic_requests
def invoices(request):
    if request.method == "POST":
        action = request.POST.get("action")
        adapter = get_economic()
        if action == "approve":
            n = billing.approve(request.POST.getlist("items"), request.employee)
            messages.success(request, f"{n} linjer godkendt.")
        elif action == "send":
            # 1) Kladder gemmes og committes lokalt. 2) Derefter kaldes e-conomic.
            billing.build_drafts(request.employee)
            pending = InvoiceDraft.objects.filter(status=InvoiceDraft.Status.PENDING)
            results = [billing.push_draft(d, adapter, request.employee) for d in pending]
            ok = sum(r.status == InvoiceDraft.Status.DRAFT for r in results)
            messages.success(request, f"{ok} kladder oprettet i e-conomic ({adapter.name}).")
            if ok < len(results):
                messages.error(request, f"{len(results) - ok} fejlede – se nedenfor og prøv igen.")
        elif action == "retry":
            draft = get_object_or_404(InvoiceDraft, pk=request.POST.get("draft"))
            billing.push_draft(draft, adapter, request.employee)
        elif action == "sync":
            n = billing.sync_status(adapter)
            messages.success(request, f"Status hentet fra e-conomic: {n} ændret.")
        elif action in ("sim_book", "sim_paid") and isinstance(adapter, MockEconomicAdapter):
            draft = get_object_or_404(InvoiceDraft, pk=request.POST.get("draft"))
            with transaction.atomic():
                (adapter.simulate_book if action == "sim_book" else adapter.simulate_paid)(draft.economic_draft_number)
                billing.sync_status(adapter)
        return redirect("invoices")
    queue = BillingItem.objects.filter(status__in=[BillingItem.Status.READY, BillingItem.Status.NEEDS_APPROVAL]).select_related("customer", "visit__employee__user")
    approved = BillingItem.objects.filter(status=BillingItem.Status.APPROVED).select_related("customer")
    ctx = {
        "queue": queue,
        "approved": approved,
        "approved_sum": sum((i.amount for i in approved), Decimal(0)),
        # Det der kræver handling øverst: fejl, kladder, bogført/åben, betalt.
        "drafts": InvoiceDraft.objects.select_related("customer").annotate(
            total=Sum("items__amount"), lines=Count("items"),
            prio=Case(*[When(status=s, then=Value(i)) for i, s in enumerate(
                ["fejl", "afventer", "kladde", "bogfoert", "betalt"])], output_field=IntegerField()),
        ).order_by("prio", "customer__name"),
        "is_mock": isinstance(get_economic(), MockEconomicAdapter),
    }
    return render(request, "drift/invoices.html", ctx)


@admin_required
def sms_inbox(request):
    if request.method == "POST":
        msg = get_object_or_404(SmsMessage, pk=request.POST.get("message"))
        if request.POST.get("action") == "assign":
            customer = get_object_or_404(Customer, pk=request.POST.get("customer"))
            sms_service.assign(msg, customer, request.employee)
        msg.is_handled = True
        msg.save(update_fields=["is_handled"])
        return redirect("sms_inbox")
    ctx = {
        "unknown": SmsMessage.objects.filter(direction=SmsMessage.Direction.IN, customer__isnull=True),
        "unhandled": SmsMessage.objects.filter(direction=SmsMessage.Direction.IN, customer__isnull=False, is_handled=False).select_related("customer"),
        "recent": SmsMessage.objects.select_related("customer").order_by("-created_at")[:30],
        "customers": Customer.objects.only("id", "name"),
    }
    return render(request, "drift/sms.html", ctx)


@admin_required
@require_POST
def sms_send(request, pk):
    customer = get_object_or_404(Customer, pk=pk)
    body = request.POST.get("body", "").strip()
    if not customer.phone or not body:
        messages.error(request, "Kunden mangler telefonnummer, eller beskeden er tom.")
    else:
        msg = sms_service.send(customer, body, request.POST.get("key") or str(uuid.uuid4()),
                               get_sms_provider(), request.employee)
        messages.success(request, f"SMS {msg.get_status_display().lower()} via '{msg.provider}' "
                                  f"({segments(body)} SMS-enhed(er)).")
    return redirect("customer_detail", pk=pk)


@admin_required
@require_POST
def sms_simulate_inbound(request):
    """Kun demo: laver et signeret webhook-kald til os selv, som en gateway ville."""
    if settings.SMS_ADAPTER != "fake":
        raise PermissionDenied
    raw = json.dumps({"id": str(uuid.uuid4()), "msisdn": request.POST.get("phone", ""),
                      "message": request.POST.get("body", "")}).encode()
    from .integrations.sms import FakeSmsProvider
    provider = FakeSmsProvider()
    if provider.verify_webhook(raw, {"X-Signature": sign(raw, settings.SMS_WEBHOOK_SECRET)}):
        sms_service.receive(provider, provider.parse_inbound(raw))
        messages.success(request, "Simuleret indgående SMS modtaget.")
    return redirect(request.POST.get("next") or "sms_inbox")


@admin_required
def audit_log(request):
    return render(request, "drift/audit.html", {"events": AuditEvent.objects.select_related("actor__user")[:200]})


# --- Webhook fra SMS-gateway ---------------------------------------------------

@csrf_exempt
@require_POST
def sms_webhook(request):
    provider = get_sms_provider()
    if not provider.verify_webhook(request.body, request.headers):
        return HttpResponse(status=401)
    try:
        items = provider.parse_inbound(request.body)
    except (ValueError, KeyError):
        return HttpResponseBadRequest()
    sms_service.receive(provider, items)
    return HttpResponse(status=200)


# --- Mobil (medarbejder) -----------------------------------------------------

@employee_required
def mobile_day(request):
    day = parse_date(request.GET.get("dato"), date.today())
    qs = (Visit.objects.filter(planned_date=day)
          .select_related("agreement__customer", "agreement__address", "agreement__service", "route")
          .order_by("route__name", "agreement__route_order"))
    if not request.employee.is_admin:
        qs = qs.filter(employee=request.employee)
    stops = list(qs)
    return render(request, "drift/mobile_day.html", {
        "day": day, "stops": stops, "prev": day - timedelta(days=1), "next": day + timedelta(days=1),
        "done": sum(s.is_final for s in stops),
        "outcomes": [(s.value, s.label) for s in visit_service.FIELD_OUTCOMES_ORDERED],
    })


@employee_required
@require_POST
def mobile_register(request, pk):
    """Modtager registrering fra mobil – både online og fra offline-køen (JSON)."""
    is_json = request.content_type == "application/json"
    data = json.loads(request.body or b"{}") if is_json else request.POST
    try:
        event_id = uuid.UUID(str(data.get("event_id")))
        price = data.get("price") or None
        price = Decimal(str(price).replace(",", ".")) if price else None
        result = visit_service.register(pk, request.employee, data.get("outcome", ""), event_id,
                                        note=str(data.get("note", ""))[:1000], proposed_price=price)
    except (ValueError, InvalidOperation):
        return JsonResponse({"ok": False, "message": "Ugyldige data."}, status=400) if is_json else HttpResponseBadRequest()
    except Visit.DoesNotExist:
        return JsonResponse({"ok": False, "message": "Besøget findes ikke."}, status=404)
    except ValidationError as e:
        return JsonResponse({"ok": False, "message": " ".join(e.messages)}, status=409)
    payload = {"ok": True, "created": result.created, "message": result.message,
               "status": result.visit.status, "status_label": result.visit.get_status_display()}
    if is_json:
        return JsonResponse(payload)
    messages.info(request, result.message)
    return redirect(f"{reverse('mobile_day')}?dato={result.visit.planned_date}")
