from django.contrib.auth import views as auth_views
from django.urls import path

from drift import views

urlpatterns = [
    path("", views.start, name="start"),
    path("login/", auth_views.LoginView.as_view(template_name="drift/login.html"), name="login"),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("kunder/", views.customer_list, name="customer_list"),
    path("kunder/ny/", views.customer_create, name="customer_create"),
    path("kunder/<int:pk>/", views.customer_detail, name="customer_detail"),
    path("kunder/<int:pk>/sms/", views.sms_send, name="sms_send"),
    path("ruter/", views.routes_week, name="routes_week"),
    path("ruter/planlaeg/", views.plan_ahead, name="plan_ahead"),
    path("besoeg/<uuid:pk>/", views.visit_detail, name="visit_detail"),
    path("faktura/", views.invoices, name="invoices"),
    path("beskeder/", views.sms_inbox, name="sms_inbox"),
    path("beskeder/simuler/", views.sms_simulate_inbound, name="sms_simulate"),
    path("log/", views.audit_log, name="audit_log"),
    path("m/", views.mobile_day, name="mobile_day"),
    path("m/besoeg/<uuid:pk>/", views.mobile_register, name="mobile_register"),
    path("webhooks/sms/", views.sms_webhook, name="sms_webhook"),
]
