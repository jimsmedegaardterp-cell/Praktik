# Plan og kritisk vurdering (v0.1, 1. nov. 2026)

## Største risici
1. **Scope** – komplet SkvizBiz-erstatning er et stort system. Mitigering: vertikale flows, paralleldrift, ingen skift før accepttests.
2. **Dataflytning fra SkvizBiz** – eksportmulighed ukendt. Uden eksport = manuel indtastning. *Afklares først.*
3. **Dobbeltfakturering/-SMS** – løst i design (deterministiske besøgs-id, idempotensnøgler, lokal lås før API-kald). Testet med mocks.
4. **e-conomic API** – legacy REST er i "feature freeze"; nye versionerede API'er + webhooks (2026). Produktionsadgang kræver CVR. SKAL VERIFICERES.
5. **Sikkerhed/GDPR** – prototypen har ingen rigtig login og gemmer i browseren → må ikke bruges med rigtige kunder.
6. **Vedligehold** – én person/AI-bygget app skal kunne drives i årevis: få afhængigheder, testet kerne, backup.

## Anbefalet teknisk design (produktion)
- **Frontend:** samme PWA (vanilla JS, ingen build) – virker på PC og telefon, offline-kø.
- **Backend:** PostgreSQL + server-side funktioner i EU. Kandidat: **Supabase (EU-region)** – database, login m. MFA, row-level security, edge functions til e-conomic/SMS-webhooks, backup. Alternativ: lille Node-server + Postgres hos Hetzner (billigere, mere selv-drift).
- `domain.js` genbruges uændret på serveren; `services.js` flyttes bag API'et; adaptere skiftes fra mock til rigtige.
- e-conomic + SMS-nøgler kun på serveren. Webhook-signaturer verificeres.

## Faser
| Fase | Leverance | Status |
|---|---|---|
| A | Vurdering, design, budget, prototype `kunde → rute → udført → fakturakø` | **Prototype klar** (denne commit) |
| B | Login/roller, rigtig database, kalender/ruter/dagsrute mod server, auditlog | Afventer godkendelse |
| C | e-conomic (testaftale), tovejs-SMS (testnummer) | Afventer valg |
| D | Import fra SkvizBiz, paralleldrift | Afventer eksport |
| E | Kontrolleret skift | – |

## Skærme i prototypen
Overblik · Kunder (søg, kundekort m. adresser, aftaler, SMS-tråd, besøg, GDPR) · Kalender (uge, træk-og-slip, flyt behold/forskyd) · Ruter & kort (rækkefølge, forslag, Google Maps) · 📱 Dagsrute (store knapper, offline-kø) · Fakturering (kø → kladde → bogført → betalt) · Beskeder (tråde, ukendte numre) · Admin (provision, skabeloner, lukkedage, backup, auditlog)
