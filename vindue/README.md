# Sindal Vinduespolering – driftsapp (prototype)

Driftsapp til vinduespudserfirma (erstatning for SkvizBiz på sigt). **Prototype: kun testdata og mock-integrationer – ingen rigtige SMS eller fakturaer.**

- Åbn: `https://<github-bruger>.github.io/Praktik/vindue/` (GitHub Pages) eller lokalt: `python3 -m http.server` i repo-roden → `http://localhost:8000/vindue/`
- Tests: `node --test vindue/tests/*.test.mjs`
- Krav/scope: `docs/PROJEKTBESKRIVELSE.md`, arbejdsregler: `docs/CLAUDE.md`
- Plan og vurdering: `docs/PLAN.md` · `docs/DECISIONS.md` · `docs/TODO.md` · `docs/COSTS.md`

## Struktur
| Fil | Indhold |
|---|---|
| `js/domain.js` | Ren logik: besøgsplan, helligdage, sæson, flyt (behold/forskyd), statusmaskine, faktureringskø, SMS-dele, provision |
| `js/services.js` | Applikationslag (bliver server i produktion): roller, idempotent fakturering, SMS ind/ud, auditlog, GDPR |
| `js/adapters.js` | `MockEconomic`, `MockSms`, Google Maps-links, simpel ruteoptimering |
| `js/app.js` | Brugerflade (admin på computer + mobil dagsrute) |
| `tests/` | Accepttest 1–8 fra projektbeskrivelsen + enhedstests |
