# Vurdering og udviklingsplan

*29.10.2026 · Status: forslag til ejerens godkendelse. Intet er koblet til rigtige systemer.*

## 1. Kritisk vurdering

**Retningen er rigtig:** Appen ejer drift (kunder, aftaler, ruter, besøg, SMS). e-conomic ejer alt regnskab. Det fjerner den største faglige risiko, nemlig at bygge sin egen bogføring.

**Det sværeste er ikke koden. Det er:**

| # | Risiko | Hvorfor den er alvorlig | Afbødning |
|---|---|---|---|
| 1 | **Data ud af SkvizBiz** | Uden en fuld eksport (kunder, aftaler, næste datoer, priser, historik) kan der ikke skiftes. Det er stadig ukendt. | Afklar som det **første**, før der bygges mere. Bed SkvizBiz om en eksport og et feltkort. |
| 2 | **Vedligeholdelse** | Med egen app bliver firmaet ejer af software. Hvem retter fejl en mandag kl. 7? | Kedelig, udbredt teknologi, tests, dokumentation, overvågning og en nødplan (daglig printbar/CSV-ruteliste). |
| 3 | **Dobbelt fakturering/SMS** | Netværksfejl og dobbelttryk kan koste penge og tillid. | Idempotens på tre niveauer (se DECISIONS.md). Testet i prototypen. |
| 4 | **e-conomic-detaljer** | Det er uafklaret, om API'et har idempotensnøgler og webhooks, hvilken abonnementspakke der kræves, og hvordan rate limits virker. | Vi bruger kun det, der er verificeret. Prototypen bruger reference-opslag, som virker uden særlige API-features. |
| 5 | **Samlede omkostninger** | Hosting er billig (se COSTS.md). Den store post er udviklings- og vedligeholdelsestid. | Byg kun det, som SkvizBiz bruges til i dag. Ikke mere. |
| 6 | **Offline på iPhone** | En PWA i Safari har begrænsninger: ingen baggrundssynk, og lager kan blive ryddet. | Registreringer gemmes lokalt og sendes, når appen er åben og har net. Det er testet. Status vises tydeligt. |
| 7 | **Sikkerhed/GDPR** | Kundedata ligger hos jer selv, ikke hos en leverandør med certificeringer. | EU-hosting, databehandleraftaler, MFA, auditlog, krypteret backup med gendannelsestest og ekstern sikkerhedsgennemgang før go-live. |

## 2. Mangler i kravene (bør afklares)

**Skal afklares før fase B er færdig:**
1. **Antal kunder, medarbejdere og ruter.** Det har betydning for skærmdesign og budget.
2. **Engangsopgaver og tilbud** (tagrender, ovenlys, flytterengøring). Projektbeskrivelsen nævner kun faste aftaler.
3. **Vejraflysning af en hel dag eller rute.** Det sker ofte i branchen. Kræver en masseflytning med samme valg: behold rytme eller forskyd.
4. **Prismodel:** fast pris pr. aftale, pr. vindue eller tillæg (fx 1. sal, inde/ude)?
5. **Faktureringsrytme:** én faktura pr. besøg, samlefaktura pr. måned eller forudbetaling/abonnement?
6. **Betaling på stedet** (MobilePay/kontant) og **Betalingsservice**-aftaler.
7. **Erhvervskunder:** EAN/e-faktura og rekvisitionsnumre. Det sendes via e-conomic, men appen skal kende felterne.
8. **Servicefradrag:** Skal arbejdsløn stå særskilt på fakturaen? *SKAL VERIFICERES* hos Skattestyrelsen/bogholder.
9. **Provision:** grundlag (ekskl. moms? udført- eller fakturadato? kreditnotaer?). Det er allerede markeret som uafklaret.
10. **SMS-regler:** hvornår der sendes (dagen før? morgenen?), og om svar skal give push-notifikation.
11. **Opbevaring og sletning:** hvor længe gemmes data om tidligere kunder? Bogføringsmateriale ligger i e-conomic.
12. **Medarbejdernes telefoner:** private eller firmaets (har betydning for MDM, logout og tabt telefon)?

**Kan udskydes:** ruteoptimering med kort-API, kalendervisning med drag-and-drop, push-notifikationer og flere roller (bogholder).

## 3. Anbefalet teknisk design

```
 Telefon (PWA)        Computer (browser)
      │  HTTPS             │
      └──────┬─────────────┘
        Caddy (auto-TLS)
             │
        Django-app  ──── adapters ──→ e-conomic API   (mock i dag)
        (én proces)                 └→ SMS-gateway    (fake i dag)
             │                    ←── webhook (signeret) indgående SMS
        PostgreSQL
             │
   natlig krypteret backup → separat EU-lager (+ ugentlig gendannelsestest)

 Alt på én virtuel server i EU (fx Hetzner, Tyskland/Finland).
```

- **Én kodebase og én server.** Ingen mikroservices, Redis eller Kubernetes. Baggrundsjobs (SMS-udsendelse, statussynk med e-conomic) kører som en kommando hvert minut via systemd-timer, med en jobtabel i databasen.
- **Django (Python)** fordi login, sessioner, CSRF-beskyttelse, ORM med parametriserede forespørgsler (mod SQL injection), migrationer og autoescaping (mod XSS) er indbygget. Det giver færre afhængigheder og færre valg, der kan gå galt. Begrundelse og fravalg står i DECISIONS.md.
- **Server-renderede sider** og lidt JavaScript kun til mobilens offline-kø. Der er intet frontend-buildtrin.
- **Skalerbarhed:** En lille server kan klare hundredvis af samtidige brugere og titusinder af kunder. Det er langt over behovet.

## 4. Implementeringsplan (trinvis og testbar)

| Fase | Leverance | Accept / test | Status |
|---|---|---|---|
| **A1** | Prototype: kunde → rute → besøg udført → fakturakø → mock-kladde → status | 35 automatiske tests og skærmbilleder | ✅ Denne leverance |
| **A2** | Ejeren afprøver prototypen og godkender flow og arkitektur | Ejerens feedback | ⏳ Næste skridt |
| **A3** | SkvizBiz: eksport, feltliste og skærmbilleder af det, I bruger dagligt | Kendt eksportformat | ⏳ Kræver ejeren |
| **A4** | Verificér e-conomic (testaftale, API-rettigheder, pakke) og vælg SMS-gateway | Skriftlige svar/dokumentation | ⏳ |
| **B1** | MFA for admin, brute-force-beskyttelse, roller, rettelser med spor, vejraflysning af hel dag | Sikkerhedstests | |
| **B2** | Fuld kundeadministration (redigér, flere aftaler, pause/opsig, slet/eksport efter GDPR) | Accepttest 3 og GDPR-eksport | |
| **B3** | Service worker (ruten kan åbnes helt offline), engangsopgaver | Offline-test på rigtig iPhone og Android | |
| **B4** | Drift: server, TLS, backup, gendannelsestest og overvågning | Accepttest 9 | |
| **C1** | e-conomic live-adapter mod **testaftale** | Accepttest 4–6 mod sandbox | |
| **C2** | SMS live-adapter med **testnummer**, kun til egne telefoner | Accepttest 7 | |
| **D** | Importpipeline med preview, dubletkontrol og rollback. Paralleldrift med SkvizBiz | Accepttest 10 | |
| **E** | Kontrolleret skift og opsigelse af SkvizBiz efter stabil drift | Ejer og bogholder godkender | |

**Princip:** Hver fase slutter med noget, ejeren kan afprøve. Live-integrationer aktiveres først efter skriftlig godkendelse (`ALLOW_LIVE_INTEGRATIONS`).

## 5. Skærmoversigt

**Computer (admin):** Overblik · Ruter (uge) · Besøg (flyt med behold/forskyd) · Kunder (liste, kort, opret) · Fakturering (godkend → kladder → status) · Beskeder (ukendte afsendere, ubehandlede svar) · Log.
*Senere:* Indstillinger (ydelser, priser, SMS-skabeloner, medarbejdere), Integrationsstatus/backup/omkostninger, Import, Provisionsgrundlag.

**Mobil (medarbejder):** Dagsrute med store knapper: Udført · Delvist · Forgæves · Udsat · Aflyst. Der er også bemærkning, prisforslag, "Vej" (telefonens kort-app), "Ring" og adgangsnoter. Dagsruten viser kun egne besøg og ingen økonomi.

## 6. Beslutninger, som kun ejeren kan træffe

1. Godkender du arkitekturen (Django + PostgreSQL på én EU-server)?
2. Kan du skaffe en eksport fra SkvizBiz og fortælle, hvad du betaler for SkvizBiz i dag? Det skal bruges til at sammenligne omkostninger.
3. Hvilken e-conomic-pakke har I i dag, og må vi oprette en udviklings-/testaftale?
4. Svar på punkterne i afsnit 2. Især 2, 3, 5 og 9.
