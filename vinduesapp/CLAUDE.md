# Claude Code — Vinduesfirmaets driftsapp

Læs `PROJEKTBESKRIVELSE.md` i samme mappe før du planlægger eller skriver kode. Dette dokument er projektets faste arbejdsregler; projektbeskrivelsen indeholder scope og acceptkriterier.

## Målet
Byg en sikker, driftssikker og økonomisk enkel erstatning for SkvizBiz til en dansk vinduespudservirksomhed. Den nye app administrerer kunder, ruter, arbejdsregistrering, medarbejdere og tovejs-SMS. **e-conomic er eneste autoritative system for fakturaer, bogføring, bankafstemning, moms og bilag.**

## Sådan skal du arbejde
1. Start med at læse begge dokumenter og lav en **kort implementeringsplan** med faser, risici, antagelser og forventede driftsomkostninger. Spørg ejeren kun om beslutninger, der ikke kan udskydes eller afgøres med sikre standarder.
2. Undersøg aktuel officiel dokumentation for e-conomic, valgt SMS-udbyder og øvrige integrationer. **Opfind aldrig endpoint, tilladelse, pris eller funktion.** Ukendte forhold mærkes `SKAL VERIFICERES`.
3. Lav først en fungerende demo med testdata og lokale/mock-integrationer. **Ingen rigtige fakturaer, SMS-udsendelser, importer eller bankændringer uden eksplicit godkendelse.**
4. Byg vertikale, testede arbejdsgange fremfor mange halvfærdige skærme: kunde → rute → udført arbejde → fakturakladde → godkendelse → synkroniseret status.
5. Skriv læsbar, modulær kode, test kritiske flows, og dokumenter opsætning, miljøvariabler, backup/gendannelse og sikkerhedsvalg.
6. Opret `DECISIONS.md`, `TODO.md` og `COSTS.md` og vedligehold dem. Hold et klart skel mellem implementeret, demonstreret med mock-data og dokumenteret i produktion.
7. Brug `git`; commit små, sammenhængende ændringer. Del hemmeligheder aldrig i kode, logs, commit eller prompt. Hold alle eksterne systemhandlinger i adaptere.
8. Behandl kundedata efter GDPR-principperne om dataminimering, adgangsstyring, formålsbegrænsning og sikker sletning/eksport. Opfyld relevante databehandleraftaler, og få sikkerhedsgennemgang før produktion.
9. Implementer server-side autorisation, login-sikkerhed, MFA for administrator, auditlog, krypteret transport, sikre backups og verificerede webhook-signaturer, hvor leverandøren understøtter dem.
10. Indfør idempotens og revisionsspor: samme besøg må ikke danne to fakturaer, og samme SMS-event må ikke håndteres to gange.
11. Lav ikke automatisk udsendelse fra et privat 'fri SMS'-abonnement; det kræver skriftlig tilladelse fra teleselskabet. Tovejs-SMS med nummer prioriteres over visning af firmanavn som afsender, medmindre begge egenskaber reelt dokumenteres.
12. Tag ikke SkvizBiz ud af drift, før import, historik, ruter, regnskabsafstemning, SMS, brugerrettigheder, backups og paralleltest er godkendt.

## Anbefalet arbejdsstil
- Svar ejeren på dansk, kort og pædagogisk.
- Vis ændringer og beslutninger, inden du bygger dyre eller irreversible funktioner.
- Brug konservative, vedligeholdelige teknologier og få eksterne afhængigheder. Vælg stack efter konkret vurdering; ikke for teknologiens skyld.
- Vær ærlig om begrænsninger, usikre krav og hvad der endnu ikke er testet.
