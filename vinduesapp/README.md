# Vinduesapp – prototype

Driftsapp til et vinduespudsningsfirma: kunder, ruter, besøg, fakturakø og SMS. e-conomic er regnskabssystem.
**Status:** Prototype med fiktive testdata. e-conomic og SMS er simuleret, og intet sendes ud af huset.

Læs først: `PLAN.md` (vurdering og plan) · `DECISIONS.md` · `COSTS.md` · `TODO.md`.

## Kør demoen lokalt

Kræver Python 3.12+.

```bash
cd vinduesapp
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo      # nulstiller og indlæser fiktive data
python manage.py runserver
```

Åbn http://127.0.0.1:8000. Adgangskoden er `demo-adgang-2026` for alle tre brugere:
- `admin`: administration på computer
- `medarbejder1` / `medarbejder2`: mobil dagsrute (prøv med telefon-visning i browseren)

Prøv flowet: **Mobil → Udført → Fakturering → Godkend → Opret kladder → Simulér bogføring → Hent status.**

## Tests

```bash
python manage.py test drift
```

Der er 35 tests. De dækker accepttest 1–5, 7 og 8 samt planlægning, helligdage, SMS og adgangskontrol.

## Struktur

```
config/            indstillinger og URL'er
drift/models.py    domænemodel
drift/services/    forretningslogik (planning, visits, billing, sms, audit)
drift/integrations/ adaptere: economic.py (mock/live), sms.py (fake/live)
drift/templates/   skærme;  drift/static/ CSS + mobilens offline-kø
```

Al kontakt med eksterne systemer går gennem `drift/integrations/`. Resten af koden kender kun grænsefladerne.

## Miljøvariabler

| Variabel | Standard | Betydning |
|---|---|---|
| `DJANGO_DEBUG` | `ja` | Skal være `nej` i produktion |
| `DJANGO_SECRET_KEY` | (demo-værdi) | **Påkrævet** i produktion |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Domænenavne |
| `POSTGRES_DB/USER/PASSWORD/HOST/PORT` | – | Er de sat, bruges PostgreSQL i stedet for SQLite |
| `ECONOMIC_ADAPTER` | `mock` | `live` kræver også nedenstående |
| `SMS_ADAPTER` | `fake` | `live` kræver også nedenstående |
| `ALLOW_LIVE_INTEGRATIONS` | `nej` | Sættes kun efter **skriftlig godkendelse** fra ejeren |
| `SMS_WEBHOOK_SECRET` | (demo-værdi i debug) | Delt hemmelighed til webhook-signatur |
| `COMPANY_NAME` | Demo Vinduespudsning | Vises i UI og SMS |

Hemmeligheder ligger kun i miljøet på serveren (fx `/etc/vinduesapp.env`, rettigheder 600). De må aldrig ligge i git.

## Sikkerhedsvalg (implementeret)
- Server-side adgangskontrol på alle views. Medarbejdere ser kun egne besøg og ingen admin- eller økonomisider.
- CSRF på alle formularer og JSON-kald. Webhook er CSRF-fri, men kræver en HMAC-signatur (sammenlignes i konstant tid).
- Sikre cookies, HSTS og SSL-redirect, når `DJANGO_DEBUG=nej`. Clickjacking-beskyttelse.
- Adgangskoder på mindst 12 tegn med Djangos validatorer.
- Auditlog gemmer handlinger og ID'er, ikke beskedtekster.
- **Mangler før produktion:** MFA og login-rate-limit (se TODO.md).

## Backup og gendannelse (plan for produktion, ikke sat op endnu)

```bash
# natligt (systemd-timer):
pg_dump -Fc vinduesapp | age -r <offentlig-nøgle> > backup-$(date +%F).dump.age
# kopiér til separat EU-lager; behold fx 30 daglige + 12 månedlige
```

```bash
# gendannelsestest (ugentligt, automatisk):
age -d -i nøgle.txt backup.dump.age | pg_restore -d vinduesapp_restoretest --clean
python manage.py check && python manage.py test drift   # + optælling af kunder/besøg mod produktion
```

Den private dekrypteringsnøgle opbevares offline hos ejeren, ikke på serveren.
