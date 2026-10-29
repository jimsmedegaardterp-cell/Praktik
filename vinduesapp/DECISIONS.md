# Beslutninger

Format: beslutning – begrundelse – fravalgt. Status: **Foreslået** (afventer ejer) / **Truffet**.

## D1 · Stack: Django + PostgreSQL, server-renderet (Foreslået)
- **Hvorfor:** Login, sessioner, CSRF, ORM (beskytter mod SQL injection), migrationshistorik og template-autoescaping (beskytter mod XSS) er indbygget. Kun én reel afhængighed (Django). Den er moden, har lang LTS-support og er let for andre udviklere at overtage.
- **Fravalgt:** Node/TypeScript med SPA: flere valg og pakker (auth, ORM, CSRF, build) og mere at vedligeholde. Firebase/Supabase: leverandørbinding og uklar dataplacering. Low-code (Airtable/Power Apps): billig start, men svag idempotens, offline og adgangsstyring.
- Python har type-hints. Statisk typecheck (mypy) kan tilføjes senere uden omskrivning.

## D2 · Én EU-server (Foreslået)
- **Hvorfor:** Volumen er lille. Én VPS hos Hetzner (DE/FI) med Docker Compose: Caddy (automatisk TLS), app og PostgreSQL. Det er billigst og enklest. Databehandleraftale med leverandøren.
- **Fravalgt:** PaaS (højere pris), Kubernetes (unødig kompleksitet), amerikanske hyperscalere (GDPR/tredjelandsrisiko).
- **Risiko:** Én server er et single point of failure. Accepteres, fordi nødplanen er backup og gendannelse inden for få timer plus en daglig ruteliste.

## D3 · Prototype på SQLite, produktion på PostgreSQL (Truffet)
- SQLite gør demoen nem at køre lokalt. Koden er databaseuafhængig, og idempotens hviler på unikke constraints, som virker i begge. Rækkelåse (`select_for_update`) virker kun reelt i PostgreSQL.

## D4 · Idempotens i tre lag (Truffet, implementeret)
1. **Mobil → server:** Hver registrering får et `event_id` (UUID) på telefonen. `WorkLog.client_event_id` er unik, så genafsendelse giver "allerede registreret".
2. **Besøg → fakturalinje:** `BillingItem.visit` er OneToOne. Et besøg kan aldrig få to fakturalinjer (accepttest 1 og 5).
3. **App → e-conomic:** `InvoiceDraft.idempotency_key` gemmes og committes *før* API-kaldet og sendes med som reference. Ved fejl eller timeout søger genforsøget først efter en kladde med referencen (accepttest 4). Mønstret kræver ikke, at e-conomic understøtter en idempotens-header. Om API'et har en sådan, *SKAL VERIFICERES*.
- SMS: `SmsMessage(provider, provider_message_id)` er unik for indgående. Udgående har unik `idempotency_key`.

## D5 · Grundrytme vs. planlagt dato (Truffet, implementeret)
- `rhythm_date` = anker + n × interval. `planned_date` = den faktiske plan (kan være flyttet eller helligdagsjusteret). `completed_date` = udført.
- "Behold" flytter kun ét besøg. "Forskyd" rykker dette og alle senere ikke-afsluttede besøg og flytter ankeret. Kollisioner afvises.
- Helligdage beregnes lokalt (påskeformel). Grundlovsdag, juleaften og nytårsaften er sat som lukkedage. *SKAL VERIFICERES* med ejeren.

## D6 · Fakturering: kun kladder, aldrig bogføring (Truffet)
- Appen opretter kun **kladder** i e-conomic. Bogføring og afsendelse sker i e-conomic af en person. Status (bogført nr., betalt) hentes derfra og vises aldrig, før e-conomic har bekræftet den.
- Samlefaktura: godkendte linjer samles i én kladde pr. kunde pr. kørsel.
- Prisændring fra marken og "delvist udført" kræver altid admin-godkendelse.

## D7 · SMS: nummerbaseret tovejs, udskiftelig adapter (Foreslået)
- Svar fra kunden prioriteres over et alfanumerisk afsendernavn, og firmanavnet skrives i teksten. Gateway vælges i fase A4. GatewayAPI er en kandidat, men tovejsnummer, pris og webhook-signatur *SKAL VERIFICERES*.
- Ingen brug af privat "fri SMS". Kunden matches på normaliseret nummer. Er der flere kunder med samme nummer, gætter appen ikke, og beskeden går til manuel indbakke.

## D8 · Ingen kort-/routing-API i første version (Foreslået)
- "Vej" åbner telefonens egen kort-app via et link. Det koster intet, og der deles ingen data med en tredjepart. Ruteoptimering vurderes senere: selvhostet OSRM/Valhalla med Danmarks-kort på samme server eller en betalt API.

## D9 · Medarbejdere ser ikke priser eller økonomi (Foreslået)
- Mobilvisningen viser kun egne besøg, adresse, ydelse og adgangsnoter. Medarbejderen kan foreslå en anden pris, men den kræver godkendelse. Skal medarbejdere se egen omsætning/provision, laves det som en særskilt visning.

## D10 · Placering i repo (Midlertidig)
- Prototypen ligger i `vinduesapp/` i repoet *Praktik*, som ellers er en husholdningsapp. **Anbefaling:** Flyt til et eget **privat** repo, før der kommer rigtige data eller nøgler i nærheden. Repoet indeholder kun fiktive testdata, og databasefilen er git-ignoreret.
