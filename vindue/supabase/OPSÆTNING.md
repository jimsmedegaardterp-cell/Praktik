# Opsætning af den fælles database (Supabase)

Tager ca. 10 minutter. Du kan bruge samme Supabase-konto som til andre apps, men **lav et nyt projekt**, så data og logins holdes adskilt.

## 1. Opret projektet
1. Gå til <https://supabase.com> og log ind.
2. **New project**:
   - Name: `sindal-vinduespolering`
   - Region: **Central EU (Frankfurt)** eller **North EU (Stockholm)** (data skal ligge i EU)
   - Database password: lav et stærkt kodeord og gem det i din kodeordsmanager (bruges ikke af appen)
3. Vent til projektet er klar (1–2 min).

## 2. Opret tabeller og adgangsregler
1. Venstre menu → **SQL Editor** → **New query**.
2. Kopiér hele indholdet af [`schema.sql`](schema.sql) ind og tryk **Run**. Det skal ende med "Success".
   (Filen kan køres igen senere uden at slette data.)

## 3. Login-indstillinger
1. **Authentication → URL Configuration**
   - Site URL: `https://jimsmedegaardterp-cell.github.io/Praktik/vindue/`
   - Redirect URLs: tilføj samme adresse.
2. **Authentication → Sign In / Providers → Email**: skal være slået til. Slå **"Confirm email" fra**, indtil der er sat egen mailserver (SMTP) op – Supabase' indbyggede mails er meget begrænsede og havner ofte ikke i indbakken.

## 4. Forbind appen
1. **Project Settings → API Keys** (eller "Data API"): kopiér
   - **Project URL** (fx `https://abcd1234.supabase.co`)
   - **anon / publishable key** (den offentlige nøgle)
2. **Brug aldrig `service_role` / secret-nøglen** i appen.
3. Send de to værdier til Claude, så de lægges ind i `js/config.js` (så virker det automatisk på alle enheder) – eller indtast dem selv i appen under **Admin → Fælles database og login → Forbind** (gælder kun den browser).

## 5. Første login
1. Åbn appen → **Opret ny bruger** med din e-mail → (log ind, hvis "Confirm email" er slået til: bekræft via mailen først).
2. Vælg **Opret firma**.
3. Vælg **Upload de data, der ligger på denne computer** (hvis du har importeret kunderne) eller **Start tomt**.
4. Opret dine medarbejdere under **Admin → Medarbejdere**, og lav en **invitationskode** til hver under **Admin → Brugere og adgang**.

## To-trinslogin (admin)
- Admin skal slå to-trinslogin til ved første login (QR-kode → godkendelses-app). Databasen afviser derefter alt fra en session uden kode.
- Supabase: **Authentication → Multi-Factor** – "TOTP (App Authenticator)" skal være slået til (standard).
- Tilføj en **ekstra enhed** under Admin → Brugere og adgang (fx kodeordsmanager), så du ikke låses ude.

### Mistet enhed
Supabase → **SQL Editor** → kør (ret e-mailen):
```sql
delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'din@mail.dk');
```
Log derefter ind med kodeord – appen beder dig sætte to-trinslogin op igen.

## e-conomic
Appen taler med e-conomic gennem en lille serverfunktion i Supabase (`supabase/functions/economic/index.ts`). e-conomic-nøglerne ligger **kun** dér – aldrig i appen/browseren. Kun admin (med to-trinslogin) kan bruge den.

### 1. Konti hos e-conomic (til test)
1. **Udvikleraftale** (gratis) – bruges kun til at lave "appen" og nøglen. Login kommer pr. mail.
2. **Prøve-regnskab** (sandkasse) med testdata: <https://www.e-conomic.dk/regnskabsprogram/demo-alle> (14 dage; e-conomic kan forlænge på api@e-conomic.com).

### 2. Lav appen og hent nøglerne
1. Log ind på **udvikleraftalen** → fanen **Apps** → **New app** → navn `Sindal Vinduespolering`, rolle **SuperUser** → opret. Kopiér **AppSecretToken** (vises kun én gang).
2. Klik **Tokens** ved appen → kopiér **Installation URL**.
3. **Log ud** af udvikleraftalen, log ind på **prøve-regnskabet**, og åbn Installation URL → godkend. Kopiér den **AgreementGrantToken**, der vises.

### 3. Installér serverfunktionen i Supabase
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Navn: `economic` (præcis). Slet eksempelkoden, indsæt hele `supabase/functions/economic/index.ts`, **Deploy**.
3. **Edge Functions → Secrets** → tilføj:
   - `ECONOMIC_APP_SECRET` = AppSecretToken
   - `ECONOMIC_GRANT` = AgreementGrantToken

### 4. I appen
**Admin → e-conomic**: vælg kundegruppe, betalingsbetingelse, momszone (Domestic/Indland), layout og den vare, fakturalinjerne skal bogføres på (opret evt. varen "Vinduespolering" i e-conomic med 25 % moms). Til betaling på stedet: kassekladde og konti for kontant og MobilePay. Slå **"Brug e-conomic til fakturering"** til.

I e-conomic skal firmaets e-mail være udfyldt (Indstillinger → Firma), ellers kan fakturaer ikke sendes pr. mail.

### Når det skal i drift
Lav den rigtige regnskabsaftale, åbn Installation URL dér, og udskift `ECONOMIC_GRANT` med den nye token. Opsætningen i appen skal vælges igen (numrene kan være anderledes).

## GDPR og drift – SKAL VERIFICERES
- Indgå Supabase's databehandleraftale (DPA) under organisationens indstillinger.
- Gratis-planen kan sætte projekter på pause efter en periode uden aktivitet og har begrænset backup. Tjek gældende vilkår; overvej betalt plan før rigtig drift.
- Tag stadig jævnligt **Admin → Download backup**.

## Opdateringer af skemaet
Når `schema.sql` ændres (står i ændringsbeskrivelsen), så kør hele filen igen i **SQL Editor** – **før** den nye version af appen tages i brug. Data slettes ikke.

## Hvordan det virker
- Appen gemmer lokalt og synkroniserer hvert 30. sekund, når du gemmer, og når appen åbnes. Status ses øverst til højre ("✓ Synk 12:03"). Klik på den for at synkronisere nu.
- Adgang styres i databasen (Row Level Security): kun brugere i firmaet ser data. Medarbejdere ser kun kunder, aftaler og besøg på **egne ruter** (plus rutenavne og fælles indstillinger) og kan kun ændre besøg, kladder, SMS-log og egne logposter. Flyttes en rute til en anden medarbejder, forsvinder kunderne fra den gamles telefon næste gang appen åbnes.
- Data på enheden ligger i browserens IndexedDB, adskilt pr. bruger.
- Test af reglerne: `vindue/supabase/test/run.sh` (kræver lokal PostgreSQL).
