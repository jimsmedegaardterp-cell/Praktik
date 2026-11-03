# Omkostninger – estimat (ALLE PRISER SKAL VERIFICERES)
Leverandørsider kunne ikke hentes fra udviklingsmiljøet 1. nov. 2026. Tal er erfaringsbaserede intervaller, ekskl. moms.

| Post | Type | Estimat/md. | Note |
|---|---|---|---|
| SMS 750–1.500 stk (GatewayAPI e.l.) | Variabel | ca. 200–700 kr | Pris pr. SMS til DK er steget pga. teleselskaber. Æ/ø/å er OK (GSM-7); emojis gør SMS dyrere (Unicode). Lange beskeder = flere dele |
| Dansk nummer til tovejs-SMS | Fast | SKAL VERIFICERES | Kræves for at kunder kan svare direkte |
| Indgående SMS | Variabel | Ofte gratis/billig | SKAL VERIFICERES |
| e-conomic abonnement | Fast | Har I allerede | API er gratis iflg. sekundær kilde; kræver CVR. Tjek om jeres pakke tillader integrationer |
| Hosting (Supabase EU / Hetzner) | Fast | 0–200 kr | Gratisniveau kan række i test; produktion bør have betalt plan m. backup |
| Google Maps (links) | – | 0 kr | Kun vejvisning i telefonens app |
| Google Routes API (køretider) | Variabel | 0–100 kr | Kun hvis luftlinje-forslag ikke er godt nok |
| Domæne | Fast | ca. 10 kr | |

**Realistisk total:** ca. 300–1.000 kr/md. ekskl. moms + e-conomic. Sammenlign med jeres nuværende SkvizBiz-pris.

**Gratis SMS?** Automatisk udsendelse fra privat "fri SMS" (Telmore) er ikke tilladt uden skriftlig accept. Gratis-alternativ i appen: "Send fra egen telefon" (manuelt, ét tryk pr. kunde, svar havner på telefonen – ikke i appen).

## Google Maps (dagsplan)
- Routes API `computeRoutes` (køretid, vejrute, optimering). Ét kald pr. 24 stop. Hentes **automatisk**, når en dag, rute eller uge vises, og huskes, mens appen er åben.
- Forbrug: groft 10–30 kald pr. arbejdsdag ≈ 200–600/md. Google: 5.000 gratis "Compute Routes Pro" pr. md. (prisliste 2026). Om optimering tæller som dyrere type: **SKAL VERIFICERES**. Begræns evt. kvoten i Google Cloud (fx 200/dag).


Se også **docs/DRIFT.md** for konti, fornyelser og backup (opdateret 3/11-2026).
