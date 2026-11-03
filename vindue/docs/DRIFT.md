# Drift – Sindal Vinduespolering-appen

Alt, der skal til for at holde appen kørende, og hvem der ejer hvad. **Ingen kodeord eller nøgler står her**: de ligger i de nævnte tjenester og i din kodeordsmanager.

## Konti og tjenester

| Tjeneste | Bruges til | Ejer/login | Pris (SKAL VERIFICERES) | Fornyelse / husk |
|---|---|---|---|---|
| **GitHub** – repo `jimsmedegaardterp-cell/Praktik` | Koden + hjemmesiden (GitHub Pages) | Jim | Gratis | Slå 2-trinslogin til på kontoen |
| **Supabase** – projekt `sindal-vinduespolering` (Frankfurt) | Login, fælles database, serverfunktionen `economic` | Jim | Gratis nu · Pro ca. 25 $/md. | **Køb Pro før rigtig drift**: gratis-projekter pauses efter 7 dage uden brug og har begrænset backup |
| **Google Cloud** – projekt med "Maps Platform API Key" | Køretider, vejrute og optimering (Routes API) | Jim | 5.000 gratis beregninger/md., derefter ca. 10 $ pr. 1.000 | **Prøveperioden udløber ca. 31/1-2027** → Billing → Upgrade. Nøglen er låst til appens adresse og Routes API |
| **e-conomic** – udvikleraftale + regnskab | Kunder, fakturaer, betalinger | Jim | Prøve-regnskab nu (14 dage) | Rigtig aftale ved drift → ny AgreementGrantToken i Supabase-hemmeligheden `ECONOMIC_GRANT` |
| **OpenStreetMap** | Kortbaggrund | – | Gratis ved lille forbrug | – |
| **Mailserver** (chosting, `mail.sindalvinduespolering.dk`) | Login-mails (ikke sat op endnu) | Jim | Del af webhotellet | Se OPSÆTNING.md |

Appen minder om Google og Supabase fra 10/1-2027 (forsiden → "Klaret").

## Backup
- **Admin → Download backup** (JSON med alle data). Appen minder dig om det, når den sidste er over 7 dage gammel.
- Gem filerne et sikkert sted (krypteret drev eller kodeordsmanager). De indeholder kundedata.
- Med Supabase Pro tages der også daglig backup i Supabase (7 dage tilbage).
- Fakturaer og bogføring ligger i e-conomic.

## Hvis noget går galt
| Problem | Gør dette |
|---|---|
| Appen viser "Synk-fejl" | Tjek om Supabase-projektet er sat på pause (dashboard → Restore). Appen virker lokalt imens |
| Kan ikke logge ind / glemt kodeord | Se OPSÆTNING.md ("Glemt kodeord" virker først med egen mailserver; ellers SQL i Supabase) |
| Mistet telefon med to-trinskode | OPSÆTNING.md → "Mistet enhed" |
| Google-tider mangler ("≈" foran tallene) | Tjek nøgle, betaling og kvote i Google Cloud |
| Fakturaer laves ikke | Fakturering-siden viser fejlen; serverfunktionen og hemmelighederne i Supabase |
| Gendan fra backup | Admin → Gendan… → vælg JSON-filen |

## Teknik i korte træk (til en ny udvikler)
- Ren HTML/JavaScript i `vindue/` uden byggetrin. Biblioteker ligger i `vindue/vendor/`.
- Database: `vindue/supabase/schema.sql` (kør hele filen i SQL Editor ved ændringer).
- Serverfunktion: `vindue/supabase/functions/economic/index.ts` (indsæt i Supabase → Edge Functions).
- Tests: `node --test vindue/tests/` og `vindue/supabase/test/run.sh`.
- Arbejdsregler: `CLAUDE.md` i roden.
