# Projektbeskrivelse – Vinduesfirmaets egen driftsapp

**Version:** 1.0 · **Dato:** 29. oktober 2026 · **Status:** Aftalt retning, ikke færdig kravspecifikation.

## 1. Formål og afgrænsning

Erstat SkvizBiz fuldstændigt, **når** en ny løsning er afprøvet og sikker at tage i brug. SkvizBiz fungerer allerede godt til meget af den daglige drift; kopier de *funktionelle arbejdsgange og oplevelsen*, ikke beskyttet kode, grafiske aktiver eller interne databaser. Den nye app skal være lettere at ændre, give bedre integration til regnskab og have lavere **samlede** driftsomkostninger. Billigere SMS er et ønske, ikke en garanteret besparelse.

**Grundregel:** Egen app er drifts- og kundesystem. e-conomic er regnskabs- og fakturasystem. Ingen parallel bogføring.

### Bekræftede brugerbeslutninger

- **3a:** Byg en komplet erstatning; skift først, når alt er klar og testet.
- **5c:** Fuld administration på computer; enkel og hurtig mobilapp til markarbejde/kørsel.
- **6d:** Faste grundruter + forslag til forbedringer ved nye kunder, aflysninger eller uhensigtsmæssig kørsel; bruger godkender ændringer.
- **7d:** Faste besøgsintervaller, sæsoner, ugedage og mulighed for at styre, om aflysning/ændring forskyder fremtidige besøg.
- **8b (SMS):** Kunden skal kunne besvare SMS direkte.
- **9c (volumen):** Ca. 750–1.500 udgående SMS/måned.
- SMS bør identificere virksomheden; dog har tovejskommunikation højere prioritet end et alfabetisk afsendernavn, som ofte ikke kan besvares.
- Telmore 'fri SMS' bruges ikke til automatiske erhvervsudsendelser uden skriftlig accept af dette fra teleselskabet.
- Fakturaer skal dannes, bogføres og sendes via e-conomic, ikke en hjemmelavet bogføringsmotor.
- AI og Claude Code kan bruges til udvikling og evt. optimering, men daglig drift må ikke afhænge af uforudsigelige AI-svar.

### Endnu ikke afklaret – må ikke antages som besluttet

- Skal SMS-svar udelukkende vises på kundekortet, eller også udløse pushnotifikationer? Mulighed for begge dele er ønskelig, men ikke besluttet.
- Nøjagtige rute-, kalender-, kundekort- og prisfelter i SkvizBiz; undersøg via ejerens demo/skærmbilleder/eksporter.
- Hvilke eksportformater, tilladelser og adgangsmuligheder SkvizBiz giver for den eksisterende konto.
- Valg af konkret SMS-gateway, tilhørende pris og nummeropsætning.
- e-conomic-pakke, fulde API-rettigheder, fakturaflow og abonnementsomkostning efter antal posteringer.
- Kundetal, medarbejderantal, særlige fakturatyper, betalingsvilkår, sæsonmønstre og eventuelle betalingsserviceaftaler.

## 2. Brugeroplevelse

### Administration (computer)
- Startside med dagens/ugens ruter, udførte/ikke udførte opgaver, kommende besøg, kundebeskeder og fakturastatus.
- Kundekartotek: navn, kunde-/fakturakontakt, telefon, adresse(r), koordinater ved behov, kommentarer, adgangsforhold, serviceydelser, prisaftaler, momsstatus, interval, sæson, foretrukken dag, betalingsvilkår og historik. Brug validering og undgå unødige følsomme oplysninger.
- Ruter: liste-, kalender- og kortvisning, faste grundruter, drag-and-drop ændringer, flere medarbejdere, flyt, spring over, planlæg om, optimeringsforslag, print/eksport ved behov.
- Faktura-overblik: arbejde klar til fakturering, kladder, godkendte/sendt, betalt/åbent/forfaldent, alle data hentet og synkroniseret med e-conomic.
- Beskeder: udgående og indgående SMS, knyttet til kundekort og samtalehistorik, tydelig leveringsstatus og fejl.
- Admin: medarbejderroller, serviceydelser, prisregler, standard-SMS, skabeloner, integrationsstatus, auditlog, backupstatus og omkostningsoverblik.

### Mobil (PWA eller anden passende løsning)
- Fokuseret, hurtig dagsrute med **store knapper og få tryk**; nemt at navigere mellem kunder.
- Marker: `Udført`, `Delvist udført`, `Forgæves besøg`, `Udsat`, `Aflyst`; mulighed for bemærkning og justering af pris med godkendelsesregler.
- Vis kun de oplysninger medarbejderen skal bruge; ingen generel adgang til virksomhedens økonomi, medmindre rollen tillader det.
- Åbn vejvisning via telefonens kort-app, ring til kunden, se praktiske adgangsnoter.
- Vis offline-tilstand tydeligt; gem godkendte driftsregistreringer lokalt med sikker genafsendelse, og vis konflikter ved synkronisering. Fakturering og SMS skal ikke foregives gennemført offline.

### Designkrav
Dansk som hovedsprog, meget overskueligt, få skærmbilleder og enkle arbejdsgange. Først praktisk brugbarhed, derefter visuel polering. Let at ændre og udvide uden fuld omskrivning.

## 3. Ruteplanlægning og frekvens

- Kunder kan have faste intervaller (for eksempel 4, 8, 12 uger), bestemte dage, perioder og sæsonregler.
- Skeln mellem **planlagt besøgsdato**, **faktisk udførelsesdato** og **grundrytme**.
- Ved flytning/aflysning skal brugeren kunne vælge: `behold næste oprindeligt planlagte dato` eller `forskyd hele serien`.
- Undgå dobbeltbookinger og fejl ved helligdage, ferie, gentagne besøgsplaner og skift mellem vinter/sommer.
- Optimér rejsetid med realistiske afstande/køretider fra en egnet kort-/routingudbyder. AI kan foreslå ændringer, men må ikke ændre grundruter uden godkendelse.
- Foreslå smartere ruter, men respekter kundens tidsvindue, servicetid, medarbejderens kapacitet og foretrukne rækkefølge.
- Et afsluttet besøg registreres præcist én gang; rettelser skal kunne spores.

## 4. Fakturering og e-conomic

**e-conomic er source of truth for regnskabsdata**, herunder faktura, kreditnota, bogført beløb, betaling, moms og bankafstemning. Appen ejer serviceaftaler, ruter, besøg og intern kundehistorik.

### Ønsket arbejdsgang
1. Medarbejderen markerer besøget udført i mobilappen.
2. Systemet lægger besøget i en faktureringskø med pris, ydelse, dato og kundereference.
3. Administrator kan godkende enkeltvis eller samlet efter regler.
4. Appens server opretter fakturakladde i e-conomic via dokumenteret API.
5. Faktura bogføres og afsendes gennem e-conomic efter godkendt arbejdsgang.
6. Appen viser korrekt fakturanummer, status, betalingsstatus og evt. kreditnota fra e-conomic.

### Ufravigelige integrationsregler
- Opret/synkroniser kunden uden dubletter og gem en stabil kobling mellem interne ID'er og e-conomic-kundenumre.
- Brug **idempotensnøgler, låsning og revisionsspor**, så ét besøg ikke kan oprette flere fakturaer ved timeout, dobbeltklik eller genforsøg.
- Log API-fejl og giv et tydeligt genforsøg; vis aldrig `sendt`, før e-conomic faktisk har bekræftet handlingen.
- Understøt samlefakturering for flere besøg, hvis behovet bekræftes; undersøg kreditnotaer, prisændringer og delbetalinger.
- Hent betalingsstatus fra e-conomic; bankintegration og bilagsafstemning ligger der, **ikke** i den hjemmelavede app.
- Bekræft dokumentation for API-autentifikation, rate limits, webhooks eller nødvendig polling. Nøgler opbevares på serveren.
- Vælg abonnement efter funktioner, faktisk årlig postering og integration; e-conomic Smart kan være relevant pga. bilags- og bankautomatisering, men er ikke endeligt valgt.

## 5. SMS og tovejskommunikation

- Volumen: ca. 750–1.500 udgående SMS/måned. Krav: kunder kan **svare direkte**.
- Brug en professionel SMS-gateway med dokumenteret dansk **tovejssupport**, dedikeret modtagernummer og indgående beskeder via webhook/API.
- Byg en udskiftelig `SmsProvider`-adapter, så gateway kan udskiftes uden at ændre resten af systemet.
- Vis SMS-samtaler på kundekortet. Ukendt afsender går i en særskilt indbakke til manuel tilknytning.
- Funktioner: servicemeddelelse før besøg, forsinkelse, aflysning, individuelt svar, status `klargjort/afsendt/leveret/fejlet` hvor data findes.
- Indgående og udgående beskeder har provider-ID, tidsstempel, log og beskyttelse mod dubletter.
- Et alfanumerisk firmanavn som afsender understøtter normalt **ikke direkte svar**. Start derfor med nummerbaseret tovejs-SMS og skriv firmanavnet tydeligt i teksten; undersøg eventuel dokumenteret udbyderløsning, der kombinerer ønskerne.
- Undgå marketing-SMS uden gyldigt samtykke; skeln mellem servicemeddelelser og markedsføring.
- Beregn **fuld pris** inkl. udgående SMS, evt. lang-SMS/Unicode, nummerleje, indgående SMS, platformgebyrer og moms.
- Telmores private 'fri SMS'-abonnement må ikke antages egnet til automatiske erhvervsudsendelser. Ingen sådan implementering uden udtrykkelig skriftlig tilladelse.
- I testmiljø: kun fake-SMS, aldrig til rigtige kunder.

## 6. Medarbejdere, løn og provision

- Roller: `ejer/admin` og `medarbejder`; fremtidig `kontor/bogholder` ved behov.
- Log hvem der gennemførte hvad og hvornår. Administrators rettelser skal være sporbare.
- Vis omsætning pr. medarbejder/rute/uge og grundlag for provision.
- Nuværende aftale i virksomheden: **35 % provision af relevant omsætning plus lovpligtige feriepenge mv.** Beregningsgrundlag (inkl./ekskl. moms, rabatter, kreditnotaer, bonus, returneringer og faktura vs. udført dato) skal verificeres og være **konfigurerbart** før lønberegning.
- Eksportér kontrollerbart løngrundlag til lønsystem; byg ikke egen lønbogføring eller lønudbetaling nu.

## 7. Dataflytning fra SkvizBiz

**Må ikke gennemføres ukritisk.** Kontakt evt. leverandøren om dokumenteret eksport og importér kun data, virksomheden har legitim adgang til.

- Undersøg præcis eksportmulighed og felter for kunder, adresser, ruter, besøgshistorik, intervaller, priser, åbne fakturaer, SMS-historik og betalingsstatus. Manglende eksport markeres, ikke opfindes.
- Lav importpipeline med preview, felttilknytning, datarens, dubletkontrol og rollback.
- Gem oprindelige ID'er som historiske referencer. Migrér ikke gamle bogførte fakturaer ind som nye fakturaer.
- Paralleltest med repræsentative kunder og ruter; tjek totalantal, adresser, aftaleintervaller, næste besøgsdatoer, priser, åbne poster og historik.
- Før overgang: afstem SkvizBiz, e-conomic og banken med bogholder; fastlæg skæringsdato og arkiv/eksport efter opbevaringsregler.
- Bevar adgang til historiske data og dokumentation, også efter SkvizBiz opsiges.

## 8. Sikkerhed, lovgivning og robusthed

- EU-hosting og relevante databehandleraftaler; dokumentér, hvor persondata opbevares og behandles.
- Login, sikre sessioner, MFA for administrator, rollebaseret adgang og server-side adgangskontrol på alle handlinger.
- TLS, sikret database, secrets manager/env, mindst mulige API-rettigheder, private logs uden følsomt indhold, begrænset logretention.
- Automatiske krypterede backups, **test af gendannelse**, versionshistorik og alarmer ved integrationsfejl.
- Beskyt mod SQL injection, XSS, CSRF, IDOR, brute force, usikre uploads, webhook-forfalskning og rate-limit-overtrædelser.
- GDPR: privatlivspolitik, databehandleraftaler, register over data, indsigts-/eksport-/sletterutiner efter lovens krav; dataminimering og adskilte medarbejderrettigheder.
- Ingen betroede beslutninger om moms, betalinger eller fakturabogføring baseret alene på AI; godkendelse og objektive valideringer er nødvendige.
- Kræv dokumenterede sikkerhedstests og manuel gennemgang før data fra virkelige kunder tages i brug.

## 9. Teknisk retning (forslag, ikke låst stack)

- Mobilvenlig webapp / PWA er en attraktiv løsning: én kodebase, nem drift, offline-visning og lokale arbejdsregistreringer med synkronisering.
- Typet frontend/backend, relationel database med tydelig model og migrationshistorik, server-side integrationsadaptere.
- Gør domænemodellen enkel: `Customer`, `ServiceAgreement`, `Address`, `Route`, `RouteStop`, `Visit`, `Employee`, `WorkLog`, `InvoiceLink`, `SmsThread`, `SmsMessage`, `AuditEvent`, `IntegrationJob`.
- Hvert besøg har entydigt ID og statusmaskine. Besøg, fakturakladde og SMS må ikke kobles alene på fritekst/adresse.
- Offline-kø med konfliktløsning, besked om synkstatus og sikker retry. Undgå automatisk fakturering ud fra ikke-synkroniserede poster.
- Start med omkostnings- og driftsvurdering af passende teknologistack; vælg først derefter leverandør/hosting.
- Ekstern korttjeneste kun efter behov; vurder routing, pris og GDPR.

## 10. Byggerækkefølge / milepæle

**Fase A – Kort analyse og design**
- Kortlæg de vigtigste skærme og arbejdsgange fra SkvizBiz med brugerens egne screenshots, testdata eller eksport.
- Verificér e-conomic API, SMS-to-vejs, dataeksport, og lav sammenligneligt månedsbudget for alle abonnementer.
- Tegn datamodel, skærmflow og liste over ubekræftede krav. Vis ejeren en klikbar prototype.

**Fase B – Drift med testdata**
- Login/roller, kundekartotek, aftaler, ruter, kalender, mobil-dagsrute, udført/aflyst/flyttet besøg og auditlog.
- Test gentagelse og forskydning af besøg over flere måneder og år.

**Fase C – Integrationer i testmiljø**
- e-conomic-kundelink, fakturakladder, status, fejlhåndtering og validering med mocks/sandbox/testaftale.
- Tovejssms med testnummer/testmiljø, skabeloner, modtagelse, sikkerhed og prisoverblik.

**Fase D – Import og pilot**
- Importér anonymiserede eller tilladte testdata fra SkvizBiz; sammenlign ruter, intervaller, beløb og historik.
- Kør løsningen sideløbende uden dobbelt fakturering/SMS. Reparer fundne afvigelser.

**Fase E – Kontrolleret skift**
- Godkend sikkerhed, backups, regressionstest og bogføringsafstemning. Frys overgangsdato, tag fuld arkiveksport, aktiver produktion og monitorér fejl.
- Opsig først SkvizBiz efter verificeret stabil drift og sikring af lovpligtigt arkiv.

## 11. Kritiske accepttests

1. Et besøg afsluttes én gang, også efter dobbelttryk, offline genforsøg og netværksfejl.
2. Flytning af besøg kan **enten** bevare grundrytmen **eller** forskyde fremtidige besøg, efter brugerens valg.
3. Samme kundes to adresser og serviceaftaler forveksles ikke.
4. En fakturakladde oprettes kun én gang ved gentagne API-kald; fakturanummer og status stemmer med e-conomic.
5. Udført besøg kan ikke uforvarende udløse en ny faktura på en allerede faktureret ydelse.
6. Kreditnota/ændret pris håndteres kontrolleret uden at overskrive bogført historik.
7. SMS-svar lander i korrekt tråd, og ukendte numre håndteres manuelt.
8. Medarbejder kan ikke tilgå andre medarbejderes skjulte oplysninger eller admin/regnskabsfunktioner.
9. En databasebackup kan gendannes og bestå en integritetstest.
10. Samlet antal kunder, intervaller, ruter og åbne poster afstemmes før overgang fra SkvizBiz.

## 12. Første opgave til Claude Code

Læs `CLAUDE.md` og hele dette dokument. **Byg ikke hele systemet på én gang.** Lever først:

1. En kort, kritisk vurdering af projektet, de største risici og manglende afklaringer.
2. Et anbefalet teknisk design med enkel drift, skalerbarhed og EU-hosting.
3. Et realistisk budget for e-conomic, hosting, SMS og kort/routing med variable og faste omkostninger tydeligt adskilt.
4. En prioriteret implementeringsplan med testbare leverancer og skærmoversigt.
5. En lille fungerende prototype (uden live-integrationer) til at afprøve flowet `kunde → rute → besøg udført → fakturakø`.

Få ejerens godkendelse af arkitektur og centrale brugerflows, før integrationer aktiveres.

## 13. Officielle ressourcer, der skal kontrolleres ved implementering

- e-conomic API: https://www.e-conomic.com/developer/documentation
- e-conomic REST: https://restdocs.e-conomic.com/
- e-conomic abonnementer: https://www.e-conomic.dk/priser
- GatewayAPI Danmark og tovejs-SMS: https://gatewayapi.com/pricing/
- SkvizBiz: https://skvizbiz.dk/
- SkvizBiz introduktions- og funktionsvideoer: https://skvizbiz.dk/videoer/
- Claude Code projektinstruktioner: https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts

**Vigtigt:** Dokumentation og priser ændrer sig. Claude Code skal kontrollere aktuelle vilkår og tekniske muligheder før implementering og må ikke betragte estimerede omkostninger eller udokumenterede integrationer som sikre fakta.
