# TODO
**Implementeret + testet (mock):** besøgsplan m. interval/sæson/helligdage, flyt behold/forskyd, registrering én gang, offline-kø, faktureringskø → kladde → bogført → betalt, SMS ud/ind/ukendte/dubletter, roller (simuleret), provision, GDPR-eksport/sletning, backup/gendan (JSON), auditlog.

**Ikke lavet endnu**
- [ ] Rigtig login, MFA, server-side adgangskontrol (fase B)
- [ ] Database + server i EU (fase B)
- [ ] Rigtig e-conomic-adapter (kræver testaftale + app-token)
- [ ] Rigtig SMS-gateway + lejet nummer + webhook-signatur
- [ ] Geokodning af nye adresser (DAWA/Dataforsyningen – gratis, SKAL VERIFICERES) så ruteforslag virker for nye kunder
- [ ] Kreditnota-flow, delbetalinger, samlefaktura-regler
- [x] Import fra SkvizBiz (CSV/Excel, preview, felttilknytning, dubletkontrol, fortryd) – mangler test på rigtig eksport
- [ ] Flere medarbejdere på samme dag, kapacitet, tidsvinduer
- [ ] Push-notifikation ved indgående SMS (ikke besluttet)
- [ ] Print/eksport af ruteark; løngrundlag-eksport (CSV)
- [ ] Afprøv PDF-import med rigtigt kundekartotek (kolonner, ombrudte linjer). Kartotek-PDF mangler sandsynligvis pris, næste dato og rute → skal suppleres (rute-PDF eller manuelt)
- [ ] Betalingsservice-aftaler: hvordan e-conomic håndterer dem (SKAL VERIFICERES)
- [ ] Kontant: automatisk indbetaling i e-conomic (SKAL VERIFICERES)

## Database/login – før rigtig drift
- [x] MFA (TOTP) for admin – tvunget i appen, håndhævet i databasen (aal2)
- [x] Medarbejdere ser kun kunder/besøg på egne ruter (records.emps + RLS; fuld afstemning ved opstart)
- [ ] (Udskudt – få billeder) Billeder til Supabase Storage i stedet for i records
- [x] Lokalt lager i IndexedDB, separat pr. indlogget bruger
- [ ] Konfliktvisning når to enheder ændrer samme post
- [ ] Backup/gendannelse fra Supabase testet

## e-conomic – SKAL VERIFICERES i prøve-regnskab
- [ ] Opret kunde (PUT ved opdatering bevarer øvrige felter?)
- [x] Fortegn rettet til negativt (positivt øgede saldoen) – [ ] bekræft at saldo bliver 0 efter ny test
- [x] Kunde oprettes, kladde → bogført → mail modtaget
- [ ] Genoptagelse efter tabt svar (findBooked via reference)
