# Beslutninger
| # | Dato | Beslutning | Begrundelse |
|---|---|---|---|
| 1 | 2026-11-01 | Ny app i `vindue/`, eksisterende Praktik-app urørt | Undgå at bryde husstandsappen på GitHub Pages |
| 2 | 2026-11-01 | Vanilla JS-moduler, ingen build, ingen afhængigheder | Enkel drift, let at ændre, kører direkte på GitHub Pages |
| 3 | 2026-11-01 | Besøgs-id = `aftale#serieindeks` | Samme besøg kan aldrig dannes to gange |
| 4 | 2026-11-01 | Fakturalink oprettes lokalt *før* API-kald, nøgle = sorterede besøgs-id | Timeout/dobbeltklik giver ikke dobbeltfaktura |
| 5 | 2026-11-01 | Google Maps via gratis links; ruteforslag lokalt (luftlinje) | 0 kr; betalt Routes API kun hvis behov |
| 6 | 2026-11-01 | Helligdag → næste arbejdsdag, grundrytme uændret | Projektbeskrivelse §3 |
| 7 | 2026-11-01 | Medarbejders prisændring > ±20 % kræver admin | Godkendelsesregel (§2), tal kan ændres |
| 8 | 2026-11-01 | "Send fra egen telefon" (sms:-link) som gratis manuel mulighed | Ikke automatisk udsendelse; svar lander på telefonen |
| 9 | 2026-11-01 | Størrelse: ejer + 1–2 medarbejdere, 300–800 kunder | Ejerens svar |
| 10 | 2026-11-01 | Data hentes via Excel/CSV-eksport fra SkvizBiz → importværktøj med preview | Ejerens svar |
| 11 | 2026-11-01 | SMS: gratis fra egen telefon (sms:-link). Ingen gateway nu → svar kommer på telefonen, ikke i appen | Ejerens svar. Gateway-adapter bevares, så det kan slås til senere |
| 12 | 2026-11-01 | Hosting: Supabase i EU-region | Ejerens svar |
| 13 | 2026-11-01 | Provision: udført arbejde ekskl. moms, udførelsesmåned; sats pr. medarbejder (standard 35 %); CSV-løngrundlag | Ejerens svar |
| 14 | 2026-11-01 | Én faktura pr. besøg (standard; samlefaktura kan slås til) | Ejerens svar |
| 15 | 2026-11-01 | Betalingsform pr. kunde: bank/FI, MobilePay, Betalingsservice, kontant. Kontant markeres i dagsruten; indbetaling registreres i e-conomic | Ejerens svar. Automatisk registrering SKAL VERIFICERES |
| 16 | 2026-11-01 | Import: CSV/Excel med manuel kolonnetilknytning, forhåndsvisning, dubletkontrol (kundenr./telefon), fortryd pr. batch | SkvizBiz' kolonnenavne er ukendte |
| 17 | 2026-11-01 | Ruter i cyklus (standard 4 uger): rute = cyklusuge + ugedag; aftaler advarer hvis interval ikke passer | Ejerens svar |
| 18 | 2026-11-01 | SMS-varsel dagen før: liste på Overblik med ét tryk pr. kunde (egen telefon), logges | Ejerens svar |
| 19 | 2026-11-01 | Vejr: knap pr. dag – flyt (behold rytme) / flyt og forskyd / spring over + SMS-liste | Ejerens svar: vælges hver gang |
| 20 | 2026-11-01 | Medarbejdere ser pris og kundens telefon, ikke provision eller andres ruter | Ejerens svar |
| 21 | 2026-11-01 | Ruter har egen rytme + næste dato (erstatter cyklusuge/ugedag) – som "faste ruter" i SkvizBiz | Ejerens screenshots |
| 22 | 2026-11-01 | Tid pr. besøg på aftalen; dag/rute/uge viser timer, oms./time, kørsel | Ejerens screenshots |
| 23 | 2026-11-01 | "Ikke fast"-aftaler (interval 0) bookes manuelt | Ejerens screenshots |
| 24 | 2026-11-01 | Færdigmelding pr. rute: status pr. kunde, kontantbeløb, opgave, provisionsfordeling, Gem til senere / Gem og færdigmeld (idempotent) | Ejerens screenshots |
| 25 | 2026-11-01 | Provision kan fordeles pr. besøg mellem medarbejdere (resten = firma); standard = rutens medarbejders sats; ejer 0 % | Ejerens screenshots |
| 26 | 2026-11-01 | Vejr-funktion fjernet; i stedet "Flyt / aflys…" på valgte kunder eller hel dag | Ejerens svar |
| 27 | 2026-11-01 | Ejerens screenshots indeholder rigtige kundedata – bruges kun som skærmreference, gemmes ikke i repo | GDPR |
| 28 | 2026-11-01 | Færdigmelding 0/1/2/3 som SkvizBiz: 0 åben, 1 udført, 2 udført + kontant, 3 spring over (menu: næste gang / indsæt igen næste arbejdsdag / skub til dato / skub og flyt fremtidige / forgæves) | Ejerens svar + screenshot |
| 29 | 2026-11-01 | Kontanter samles pr. rute; bogføres dags dato på kasse-konto (18100 Kasse) i e-conomic | Ejerens screenshot. Integration SKAL VERIFICERES |
| 30 | 2026-11-01 | Kun medarbejdere får provision; ejer 0 % | Ejerens svar |
| 31 | 2026-11-01 | Import af SkvizBiz' kundekartotek fra PDF: pdf.js læser teksten i browseren, kolonner findes ud fra overskriftsrækken | SkvizBiz kan kun eksportere PDF. Intet sendes ud af browseren |
| 32 | 2026-11-01 | pdf.js 3.11.174 (Apache-2.0) ligger i `vendor/` og hentes kun ved import | Ingen CDN-afhængighed, virker uden ekstern adgang |
| 33 | 2026-11-01 | Kundefelter som SkvizBiz: kundegruppe, fastnet, CVR, kontaktperson, fakturatype, fakturainterval, betalingsdage, ring/SMS før, SMS efter, husk hver gang (adresse), husk næste gang (engangsnote, slettes ved færdigmelding), internt notat | Ejerens screenshots |
| 34 | 2026-11-01 | "SMS før besøg"-listen viser kun kunder med SMS før besøg = Ja | Som i SkvizBiz |
| 35 | 2026-11-01 | Import af SkvizBiz' GDPR-udtræk (zip eller udpakket mappe): kun `data.json` pr. kunde læses, i browseren, med egen zip-læser (ingen afhængighed) | Bedste datakilde; PDF-fakturaer ligger i e-conomic/arkiv |
| 36 | 2026-11-01 | Felter som `portal_password`, `cache_*` og lignende læses aldrig | Dataminimering/sikkerhed |
| 37 | 2026-11-01 | Aftaler findes ved at lede efter lister med interval/pris/næste/rute – feltnavne SKAL VERIFICERES; forhåndsvisningen viser ukendte felter og hvor aftaler blev fundet | Kun ét eksempel set |
| 38 | 2026-11-01 | Ruter fra udtrækket, der ikke findes i appen, kan oprettes med ét klik (rytme = mindste interval, dato = tidligste næste gang) | Hurtig start |
| 39 | 2026-11-01 | Primær import = SkvizBiz' "Stamdata for valgte kunder"-PDF (én pr. rute, filtreret på rute i kundelisten) + valgfrit GDPR-zip koblet på kundenr. | Stamdata har aftaler (interval, næste gang, pris, tid), telefon og noter; GDPR har fakturatype, EAN, SMS-indstillinger, koordinater |
| 40 | 2026-11-01 | "Noter" i stamdata → "Husk hver gang" på adressen (udskrives på ruten) | Samme tekst som "Husk hver gang" i kundekortet |
| 41 | 2026-11-01 | Flere aftaler på samme kunde lægges på leveringsadressen med advarsel | PDF'en angiver ikke adresse pr. aftale |
| 42 | 2026-11-01 | Ruteoversigt-PDF pr. rute ("Komplet ruteoversigt for …") giver rute + fast rækkefølge; kobles til stamdata på navn + adresse | Stamdata mangler rute; ruteoversigt mangler kundenr. og næste dato |
| 43 | 2026-11-01 | Nye ruter fra import: rytme = mindste interval på ruten, dato = tidligste "næste gang" blandt rutens kunder; fjernes igen ved fortryd | Afledt af data, kan rettes under Admin |
| 44 | 2026-11-01 | "Start tomt (til rigtige data)" sletter testdata; topbjælken viser om appen kører på testdata eller rigtige data | Undgå blanding af test- og rigtige kunder |
| 45 | 2026-11-01 | Brugere i topbjælken = appens medarbejdere (ikke hårdkodet); medarbejdere oprettes/omdøbes/fjernes under Admin; mindst én admin; fjernede beholdes til historik/provision | "Mads" var testdata og var låst fast |
| 46 | 2026-11-01 | Ruteoversigter kan importeres efter kunderne: eksisterende kunder (navn + adresse) får rute på faste aftaler og planlagte besøg samt rækkefølge | Ejer importerede kunder uden ruter |
| 47 | 2026-11-01 | Tomme ruter (fx fra import med gammel version) får rytme og dato ved ny import af ruteoversigter; reserve-match på adresse + postnr. når navn afviger; ukendt rutedato vises som "ukendt"; versionsnummer i topbjælken; "Slet ruter uden kunder" | Ejers import blev kørt med cachet gammel version |
| 48 | 2026-11-01 | Cache-busting: import map i index.html giver alle JS-moduler `?v=N`; ved hver udgivelse hæves N og VERSION i app.js | Browseren kørte gammel kode efter opdatering (GitHub Pages cacher 10 min) |
| 49 | 2026-11-01 | Admin → Ruter: "Genberegn rytme og dato ud fra kunderne" | Reparation af ruter uden at importere igen |
| 50 | 2026-11-01 | Stamdata: e-mail i telefonfeltet (kunder uden tlf.) flyttes til e-mail; fejl vises før advarsler; preview viser hvor mange rutekunder der blev fundet i stamdata | Set i ejerens forhåndsvisning |
| 51 | 2026-11-01 | Rute åbner på første dag med planlagte besøg; "Næste" i rutelisten = første besøgsdag; Forrige/Næste gang springer også til dage med besøg | Besøg der allerede er åbne/udskrevet i SkvizBiz kommer ikke med i stamdata ("Næste gang" er efter dem) |
| 52 | 2026-11-01 | GDPR-zip kan lægges på efter importen og opdaterer eksisterende kunder på kundenr. (fakturatype, EAN, SMS før/efter, ring før, kontant, koordinater, manglende tlf./e-mail); navn, adresse, aftaler og ruter røres ikke; nye kunder kun hvis valgt | Ejer importerede uden zip |
| 53 | 2026-11-01 | Ruteoversigt kobles pr. AFTALE (opgave/pris/interval), ikke pr. kunde; kunder kan have aftaler på flere ruter; række med anden adresse flytter de pågældende aftaler til den adresse; faste aftaler uden rute får kundens eneste rute, ellers advarsel | Ejer så forkerte beløb/ekstra "Enkeltbesøg" (fx kunde på både Hjørring og Tagrenderens) |
| 54 | 2026-11-01 | Ruteoversigtens rækker viser ALLE kundens aftaler; aftale→rute afgøres derfor: entydige aftaler først → rutens dato/rytme → aftaler på flere ruter fordeles efter om deres "næste gang" passer med rutens datoer, derefter navnelighed (fx Tagrende ↔ Tagrenderens), ellers advarsel | Inge Sørensen-tilfældet |
| 55 | 2026-11-01 | Dobbeltbooking = samme adresse samme dag med samme opgave to gange ELLER på to forskellige ruter (flere opgaver på samme rute er normalt); liste med aflys-knap | 12 "dobbeltbookinger" var mest kunder med flere opgaver |
| 56 | 2026-11-01 | Importens advarsler gemmes pr. import (Import → Tidligere importer) med "markér løst"; Datakontrol finder problemer direkte i data (aftaler uden rute, dubletkunder, uden kundenr., uden aftaler, uden kontaktinfo, ruter uden dato) | Advarsler forsvandt efter import |
| 57 | 2026-11-01 | "Faktureres gennem anden konto": GDPR `billing_id` → `billTo` (betalerens kunde-id); fakturakladden oprettes på betaleren med leveringskundens navn på linjen; vises på kundekort og i faktureringskø; datakontrol viser betalere der ikke findes | Ejer: nogle kunder faktureres via anden konto |
| 58 | 2026-11-01 | Kunder med samme navn behandles som "familie" ved rute-import (fx leveringskonto + betalerkonto): rækkens aftaler kan tilhøre ethvert familiemedlem, hver aftale følger sin ejer og adresse | "Landbrug ved Johnny Jørgensen" 00000038/00000730 |
| 59 | 2026-11-01 | Betaler kobles også fra stamdata: faktureringsadresse = anden kundes leveringsadresse (helst samme navn) → billTo; GDPR billing_id overskriver kun når den findes | Virker uden GDPR-zip |
