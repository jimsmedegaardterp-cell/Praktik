# Status og TODO

Forklaring: ✅ implementeret og testet · 🧪 kun demonstreret med mock/fake · ⬜ ikke lavet · 🏭 i produktion (intet endnu)

## Implementeret (prototype)
- ✅ Kunder, adresser, ydelser, ruter, aftaler (interval, sæson, anker)
- ✅ Planlægning af besøg: kan køres igen uden dubletter, helligdage, sæson
- ✅ Flyt besøg: behold grundrytme / forskyd serie (accepttest 2)
- ✅ Mobil dagsrute: store knapper, vej/ring, adgangsnoter, kun egne besøg
- ✅ Idempotent registrering ved dobbelttryk og genafsendelse (accepttest 1)
- ✅ Offline-kø i browseren med tydelig status og konfliktvisning (testet i Chromium, ikke på rigtig telefon)
- ✅ Fakturakø → godkend → samlekladde pr. kunde → status (accepttest 4, 5)
- ✅ Prisændring/delvist udført kræver godkendelse
- ✅ Rollebaseret adgang server-side, også mod IDOR (accepttest 8)
- ✅ Auditlog uden følsomt indhold
- ✅ SMS: tråde på kundekort, ukendt afsender til indbakke, dublet-beskyttelse, signeret webhook (accepttest 7)
- 🧪 e-conomic (MockEconomicAdapter inkl. simuleret timeout)
- 🧪 SMS-gateway (FakeSmsProvider sender intet)

## Næste (fase B)
- ⬜ MFA (TOTP) for admin, fx django-allauth MFA eller django-otp
- ⬜ Brute-force-beskyttelse på login (rate limit/lockout)
- ⬜ Redigering af kunde/aftale, pause/opsigelse, flere aftaler pr. kunde i UI
- ⬜ Vejraflysning: flyt hel dag/rute i ét greb
- ⬜ Engangsopgaver (uden fast interval)
- ⬜ Admin-rettelse af registrering (fortryd udført, før fakturering) med spor
- ⬜ Service worker, så dagsruten kan åbnes helt offline. IndexedDB i stedet for localStorage
- ⬜ Rækkefølge på rute (drag-and-drop) og print/CSV af dagsruter (nødplan)
- ⬜ Indstillinger: ydelser, priser, SMS-skabeloner, medarbejdere
- ⬜ GDPR: eksport og sletning af kunde, register over behandlinger, logretention
- ⬜ Jobtabel og baggrundskørsel (SMS-afsendelse, statussynk) i stedet for synkrone kald
- ⬜ Provisionsgrundlag (konfigurerbart) og CSV-eksport til lønsystem

## Integrationer (fase C, kræver godkendelse)
- ⬜ e-conomic: verificér auth, kladde-endpoint, referencefelt, idempotens, rate limits, webhooks/polling og pakke. Brug testaftale
- ⬜ SMS: vælg gateway, tovejsnummer, webhook-signatur, leveringsrapporter og pris
- ⬜ Kreditnota/prisændring efter bogføring (accepttest 6). Håndteres i e-conomic, og appen viser kun status

## Drift (før rigtige data)
- ⬜ Hosting (EU), TLS, firewall, automatiske sikkerhedsopdateringer
- ⬜ Natlig krypteret backup til separat lager og automatisk gendannelsestest (accepttest 9)
- ⬜ Overvågning og alarm ved integrationsfejl
- ⬜ Databehandleraftaler: hosting, SMS-gateway, e-conomic
- ⬜ Ekstern sikkerhedsgennemgang
- ⬜ Flyt til eget privat repo

## Migration (fase D–E)
- ⬜ Afklar SkvizBiz-eksport (felter, format, historik)
- ⬜ Importpipeline: preview, felttilknytning, dubletkontrol, rollback
- ⬜ Paralleldrift og afstemning (accepttest 10)

## Kendte begrænsninger i prototypen
- SQLite låser hele databasen ved skrivning, så samtidighed er kun reelt sikret med PostgreSQL.
- e-conomic-kaldet sker synkront i requesten. Det flyttes til et baggrundsjob.
- "Aflyst" påvirker ikke serien. Hvis aflysning skal kunne forskyde, gøres det via "Flyt"/forskyd. Afklar med ejeren.
