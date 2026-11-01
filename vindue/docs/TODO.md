# TODO
**Implementeret + testet (mock):** besøgsplan m. interval/sæson/helligdage, flyt behold/forskyd, registrering én gang, offline-kø, faktureringskø → kladde → bogført → betalt, SMS ud/ind/ukendte/dubletter, roller (simuleret), provision, GDPR-eksport/sletning, backup/gendan (JSON), auditlog.

**Ikke lavet endnu**
- [ ] Rigtig login, MFA, server-side adgangskontrol (fase B)
- [ ] Database + server i EU (fase B)
- [ ] Rigtig e-conomic-adapter (kræver testaftale + app-token)
- [ ] Rigtig SMS-gateway + lejet nummer + webhook-signatur
- [ ] Geokodning af nye adresser (DAWA/Dataforsyningen – gratis, SKAL VERIFICERES) så ruteforslag virker for nye kunder
- [ ] Kreditnota-flow, delbetalinger, samlefaktura-regler
- [ ] Import fra SkvizBiz (preview, felttilknytning, dubletkontrol, rollback)
- [ ] Flere medarbejdere på samme dag, kapacitet, tidsvinduer
- [ ] Push-notifikation ved indgående SMS (ikke besluttet)
- [ ] Print/eksport af ruteark; løngrundlag-eksport (CSV)
