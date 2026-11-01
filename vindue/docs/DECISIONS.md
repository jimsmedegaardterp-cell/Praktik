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
