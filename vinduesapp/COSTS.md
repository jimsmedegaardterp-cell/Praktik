# Driftsomkostninger (estimat)

**Alle priser er SKAL VERIFICERES.** De officielle prissider (e-conomic.dk, gatewayapi.com) var ikke tilgængelige fra udviklingsmiljøet. Tallene nedenfor stammer fra tredjepartsoversigter og er kun pejlemærker. Beløb er ekskl. moms. Kurs: 1 € ≈ 7,46 kr.

## Faste pr. måned

| Post | Estimat | Kilde/bemærkning |
|---|---|---|
| Server (Hetzner, 2 vCPU/4 GB, EU) | ca. 35–60 kr. | Tredjepart: ca. €4–8/md efter Hetzners prisstigning 1.4.2026 |
| Backup-lager (separat EU-lager) | ca. 25–45 kr. | Fx Hetzner Storage Box/Object Storage. SKAL VERIFICERES |
| Domæne | ca. 10 kr. | |
| Overvågning (uptime) | 0 kr. | Gratis niveau hos fx en uptime-tjeneste |
| **e-conomic** | ca. 195–300 kr. | Tredjepart (Tekpon, udateret): Basis €26, Plus €33, Smart €40. **Betales formentlig allerede i dag.** Kun en eventuel ændring af pakke er en ny udgift. Om API-adgang kræver tillæg: SKAL VERIFICERES |
| SMS-tovejsnummer | ukendt | GatewayAPI oplyser "ingen faste månedsgebyrer som standard", men pris for virtuelt nummer er ikke fundet. SKAL VERIFICERES |
| **Infrastruktur i alt (ekskl. e-conomic og nummer)** | **ca. 70–115 kr.** | |

## Variable

| Post | Estimat | Bemærkning |
|---|---|---|
| Udgående SMS (750–1.500/md) | ca. 185–370 kr./md | Ved ca. €0,033/SMS (tredjepart, uverificeret; GatewayAPI's egen side siger pris pr. operatør via prisliste). En SMS over 160 tegn tæller som 2. Æ/ø/å er OK, men emoji halverer længden (appen tæller segmenter) |
| Indgående SMS | ukendt | SKAL VERIFICERES |
| Kort/routing | 0 kr. i første version | Telefonens kort-app bruges via link |
| e-conomic posteringer | afhænger af pakke | Kun relevant hvis pakken har loft over bilag/posteringer. SKAL VERIFICERES |

## Det, der koster mest

- **Udvikling og vedligeholdelse** (egen tid eller konsulent samt Claude-abonnement). Det er større end alt ovenfor tilsammen.
- **Engangsomkostning:** ekstern sikkerhedsgennemgang før go-live (anbefalet).

## Sammenligning

Du skal oplyse, hvad SkvizBiz koster i dag (abonnement og SMS). Først derefter kan den samlede besparelse vurderes ærligt. Billigere SMS er **ikke** garanteret.

### Kilder (tredjepart, skal kontrolleres mod officielle sider)
- e-conomic: https://tekpon.com/software/e-conomic/reviews
- GatewayAPI: https://gatewayapi.com/pricing/ · https://frontdeskreview.com/software/sms-gateways/gatewayapi/
- Hetzner: https://agentdeals.dev/hetzner-pricing-2026 · https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/
