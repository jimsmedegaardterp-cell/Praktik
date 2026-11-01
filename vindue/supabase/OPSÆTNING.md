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
2. **Authentication → Sign In / Providers → Email**: skal være slået til. Lad "Confirm email" være slået til.

## 4. Forbind appen
1. **Project Settings → API Keys** (eller "Data API"): kopiér
   - **Project URL** (fx `https://abcd1234.supabase.co`)
   - **anon / publishable key** (den offentlige nøgle)
2. **Brug aldrig `service_role` / secret-nøglen** i appen.
3. Send de to værdier til Claude, så de lægges ind i `js/config.js` (så virker det automatisk på alle enheder) – eller indtast dem selv i appen under **Admin → Fælles database og login → Forbind** (gælder kun den browser).

## 5. Første login
1. Åbn appen → **Opret ny bruger** med din e-mail → bekræft via mailen → log ind.
2. Vælg **Opret firma**.
3. Vælg **Upload de data, der ligger på denne computer** (hvis du har importeret kunderne) eller **Start tomt**.
4. Opret dine medarbejdere under **Admin → Medarbejdere**, og lav en **invitationskode** til hver under **Admin → Brugere og adgang**.

## GDPR og drift – SKAL VERIFICERES
- Indgå Supabase's databehandleraftale (DPA) under organisationens indstillinger.
- Gratis-planen kan sætte projekter på pause efter en periode uden aktivitet og har begrænset backup. Tjek gældende vilkår; overvej betalt plan før rigtig drift.
- Tag stadig jævnligt **Admin → Download backup**.

## Hvordan det virker
- Appen gemmer lokalt og synkroniserer hvert 30. sekund, når du gemmer, og når appen åbnes. Status ses øverst til højre ("✓ Synk 12:03"). Klik på den for at synkronisere nu.
- Adgang styres i databasen (Row Level Security): kun brugere i firmaet ser data; medarbejdere kan kun ændre besøg, kladder, SMS-log og auditlog.
- Test af reglerne: `vindue/supabase/test/run.sh` (kræver lokal PostgreSQL).
