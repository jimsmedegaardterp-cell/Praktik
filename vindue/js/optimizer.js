// Ruteoptimering (forsøg): flyt kunder mellem de faste ruter/dage, så arbejdsdagene bliver ca. 7–8 timer
// inkl. kørsel fra og til startadressen. Ren logik – ingen DOM/netværk. Testet i tests/optimizer.test.mjs.
//
// Regler (aftalt med Jim):
//  - En kunde (alle aftaler på samme adresse og rute flyttes samlet) må flyttes til en anden fast rute,
//    hvis ruten kører på en dato højst `windowBack` dage før og `windowFwd` dage efter kundens næste besøg.
//  - Kundens interval skal være et multiplum af rutens (8-ugers kunde kan ligge på en 4-ugers rute).
//  - På egen rute må kunden flyttes til enhver arbejdsdag i vinduet – også dage uden ruter (så tomme dage kan fyldes).
//  - Ruter i `excludeRouteIds` flyttes ikke, men deres tid tæller med på dagen.
//  - Ruter i `ignoreRouteIds` (Tagrenderens – udføres af en anden) flyttes ikke og tæller ikke med.
//  - Hele ruter kan også flyttes (fase 1: alle rutens kunder samme antal dage, inden for samme vindue);
//    derefter flyttes enkeltkunder (fase 2) oven på ruteflytningerne.
//  - Én person, man–fre. Dagens tid = arbejde + kørsel (start → stop → start).
//  - Kørsel skønnes med luftlinje × 1,3 ved 50 km/t × kalibreringsfaktor (målt mod Google).
import * as D from './domain.js';
import { km, optimize } from './dayplan.js';

export const DEFAULTS = { horizonDays: 84, windowBack: 4, windowFwd: 10, minDay: 420, maxDay: 450, underW: 0.02, early: 0.02, factor: 1, moveCost: 10, routeMoveCost: 30, timeMs: 4000, saMs: 0 };
const legMin = (a, b, f) => { const k = km(a, b); return k == null ? 0 : (k * 1.3) / 50 * 60 * f; };
/** Strafpoint for en dags samlede minutter (0 = fridag, ingen straf). */
export function dayPenalty(T, o = DEFAULTS) {
  if (T <= 0) return 0;
  const over = Math.max(0, T - o.maxDay), under = Math.max(0, o.minDay - T);
  return over * 10 + over * over * 0.2 + under * (o.underW ?? 0.02); // over målet straffes hårdt; korte dage næsten ikke (kørslen hjem tæller i forvejen)
}
/** Dagens samlede straf: kørsel betales særskilt; her længde + "tidlighed" (arbejde senere i perioden koster lidt, så alt rykker frem mod startdatoen). */
const dayCost = (dy, work, drive, o) => dayPenalty(work + drive, o) + (o.early ?? 0) * work * dy.idx;
/** Næste rytmedato ≥ fromIso for en aftale (uden sæson). */
function nextRhythm(a, fromIso) { const step = a.intervalWeeks * 7; const k = Math.max(0, Math.ceil(D.diffDays(a.anchorDate, fromIso) / step)); return D.addDays(a.anchorDate, k * step); }
/** De første n planlagte datoer (i sæson) fra en ny ankerdato – samme antal besøg som nu, så en flytning aldrig "sparer" besøg væk.
 *  null hvis et besøg ville falde mere end `slack` dage efter perioden (fx skubbet ud af sæsonen). */
/** Strukturen beregnes på normale uger: kun weekend er lukket (helligdage/ferie flyttes som altid, når besøgene dannes). */
const wkday = (d) => { const w = D.weekday(d); return w === 5 ? D.addDays(d, 2) : w === 6 ? D.addDays(d, 1) : d; };
const isOff = (d) => D.weekday(d) >= 5;
function occN(a, anchor, n, end, slack) {
  const out = []; const step = a.intervalWeeks * 7; const lim = D.addDays(end, slack);
  for (let r = anchor, g = 0; out.length < n && g < 400; r = D.addDays(r, step), g++) { if (!D.inSeason(a, r)) continue; const p = wkday(r); if (p > lim) return null; out.push(p); }
  return out.length === n ? out : null;
}
/**
 * Byg problemet ud fra databasen. start = første dag (mandag) der må ændres.
 * Returnerer { pts, dates, items, fixed, routes, opts }.
 */
export function buildProblem(db, opts = {}) {
  const o = { ...DEFAULTS, ...opts }; const start = o.start; const end = D.addDays(start, o.horizonDays - 1); const closed = db.closedDays || [];
  const ign = new Set(o.ignoreRouteIds || []); const excl = new Set([...(o.excludeRouteIds || []), ...ign]);
  const addrById = new Map(db.addresses.map((a) => [a.id, a]));
  const pts = [o.startPoint?.lat != null ? o.startPoint : null]; const ptIdx = new Map();
  const ptOf = (addressId) => { const a = addrById.get(addressId); if (a?.lat == null) return -1; if (!ptIdx.has(addressId)) { ptIdx.set(addressId, pts.length); pts.push({ lat: a.lat, lng: a.lng }); } return ptIdx.get(addressId); };
  // Rutens dage = de dage ruten faktisk har planlagte besøg i kalenderen (rutens egen dato/rytme kun hvis den ingen besøg har)
  const visDays = new Map(); const hi = D.addDays(end, o.windowFwd);
  const rd = (v) => (v.manual ? v.plannedDate : wkday(v.rhythmDate || v.plannedDate)); // rytmedagen (uden helligdagsflytning)
  for (const v of db.visits) { if (!v.routeId || !(v.status === 'planlagt' || v.status === 'udsat')) continue; const d = rd(v); if (d < D.addDays(start, -o.windowBack) || d > hi) continue; if (!visDays.has(v.routeId)) visDays.set(v.routeId, new Set()); visDays.get(v.routeId).add(d); }
  // ruteflytning gælder en "rutedag" = rutens kunder med samme dag i rutens rytme (nøgle `${ruteId}@${dag i rytmen}`)
  const shifts = o.routeShifts || {}; const BASE = '2000-01-03';
  const cls = (r, d) => { const P = r.intervalWeeks * 7; return ((D.diffDays(BASE, d) % P) + P) % P; };
  const shiftOf = (r, d) => shifts[r.id + '@' + cls(r, d)] || 0;
  for (const r of db.routes) if (visDays.has(r.id) && r.intervalWeeks) visDays.set(r.id, new Set([...visDays.get(r.id)].map((d) => D.addDays(d, shiftOf(r, d)))));
  const routes = db.routes.filter((r) => r.intervalWeeks && (visDays.has(r.id) || (r.anchorDate && !r.anchorUnknown)));
  const runsOn = (r, d) => (visDays.has(r.id) ? visDays.get(r.id).has(d) : D.routeRuns(r, d));
  const nextRun = (r, from) => (visDays.has(r.id) ? [...visDays.get(r.id)].filter((d) => d >= from).sort()[0] || null : D.nextRouteDate(r, from));
  const firstPlanned = (a) => db.visits.filter((x) => x.agreementId === a.id && x.status === 'planlagt' && !x.manual && x.plannedDate >= start).sort((x, y) => (x.plannedDate < y.plannedDate ? -1 : 1))[0];
  const routeById = new Map(routes.map((r) => [r.id, r]));
  // flytbare: aktive faste aftaler på en ikke-udelukket rute, med koordinater
  const groups = new Map(); const skipped = [];
  for (const a of db.agreements) {
    const why = !a.active ? 'aftalen er ikke aktiv' : !a.intervalWeeks ? 'ikke fast interval' : !a.routeId ? 'ikke på en fast rute' : ign.has(a.routeId) ? 'ruten udføres af en anden og tæller ikke med' : excl.has(a.routeId) ? 'ruten er sat til "flyttes ikke"'
      : !routeById.has(a.routeId) ? 'ruten mangler dato/interval' : null;
    if (why) { skipped.push({ agreementId: a.id, addressId: a.addressId, customerId: a.customerId, routeId: a.routeId, why }); continue; }
    // samme adresse + rute + samme næste dato flyttes samlet; aftaler med forskellige datoer flyttes hver for sig
    const fp = firstPlanned(a); const k = a.addressId + '|' + a.routeId + '|' + (fp ? rd(fp) : nextRhythm(a, start)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a);
  }
  const movable = new Set([...groups.values()].flat().map((a) => a.id));
  const live = (v) => (v.status === 'planlagt' || v.status === 'udsat') && rd(v) >= start && rd(v) <= end;
  const isMovableVisit = (v) => movable.has(v.agreementId) && !v.manual && v.status === 'planlagt';
  const fixed = db.visits.filter((v) => live(v) && !isMovableVisit(v) && !ign.has(v.routeId)).map((v) => ({ date: rd(v), pt: ptOf(v.addressId), min: (v.durationMin ?? 15) + (o.stopMin || 0), visitId: v.id }));
  const items = [];
  for (const [key, ags] of groups) {
    const pt = ptOf(ags[0].addressId); const from = routeById.get(ags[0].routeId); const addressId = ags[0].addressId;
    const mk = (date, a) => ({ date, min: (a.durationMin ?? 15) + (o.stopMin || 0), pt, addressId });
    // reference = kundens næste planlagte besøg (ellers næste rytmedato)
    const d0 = new Map(ags.map((a) => { const v = firstPlanned(a);
      return [a.id, v ? rd(v) : wkday(nextRhythm(a, start))]; }));
    const ref = [...d0.values()].sort()[0]; const sh = shiftOf(from, ref); const rcls = from.id + '@' + cls(from, ref);
    // nuværende besøg (flyttes ruten i fase 1, følger kunden med)
    // antal besøg i perioden (normale uger, i sæson) – samme antal for alle muligheder
    const nOf = new Map(ags.map((a) => { let n = 0; for (let r = d0.get(a.id); r <= end; r = D.addDays(r, a.intervalWeeks * 7)) if (D.inSeason(a, r)) n++; return [a.id, n]; }));
    const occFor = (a, anchor) => occN(a, anchor, nOf.get(a.id), end, o.windowFwd);
    const cur = ags.flatMap((a) => (occFor(a, D.addDays(d0.get(a.id), sh)) || occN(a, D.addDays(d0.get(a.id), sh), nOf.get(a.id), end, 400) || []).map((d) => mk(d, a)));
    const cands = []; const why = [];
    if (pt < 0) { items.push({ key, agreementIds: ags.map((a) => a.id), addressId, customerId: ags[0].customerId, routeId: from.id, rcls, pt, ref, d0, nOf, curShift: sh, cur, cands, why, whyAll: 'adressen mangler koordinater (Admin → Manglende koordinater)' }); continue; }
    for (const r of routes) {
      if (excl.has(r.id)) { why.push({ routeId: r.id, why: ign.has(r.id) ? 'udføres af en anden' : 'sat til "flyttes ikke"' }); continue; }
      const bad = ags.find((a) => a.intervalWeeks % r.intervalWeeks); if (bad) { why.push({ routeId: r.id, why: `kundens interval (${bad.intervalWeeks} uger) passer ikke med rutens (${r.intervalWeeks} uger)` }); continue; }
      const n0 = cands.length;
      for (let s = -o.windowBack; s <= o.windowFwd; s++) {
        if (s === sh) continue; // samme dato giver ingen gevinst
        const anchors = new Map(ags.map((a) => [a.id, D.addDays(d0.get(a.id), s)]));
        // egen rute: må lægges på enhver arbejdsdag i vinduet (også dage uden ruter); andre ruter: kun deres dage
        if ([...anchors.values()].some((d) => d < start || (r.id !== from.id && !runsOn(r, d)) || isOff(d))) continue;
        const os = ags.map((a) => occFor(a, anchors.get(a.id))); if (os.some((x) => !x)) continue;
        const occ = ags.flatMap((a, i) => os[i].map((date) => mk(date, a)));
        cands.push({ routeId: r.id, shift: s, anchors, occ });
      }
      if (cands.length === n0 && r.id === from.id) continue;
      if (cands.length === n0 && runsOn(r, D.addDays(ref, sh))) why.push({ routeId: r.id, why: `kører samme dag (${ref}) – ingen gevinst ved kun at skifte rute` });
      else if (cands.length === n0) { const nx = nextRun(r, D.addDays(ref, -o.windowBack)); why.push({ routeId: r.id, why: `kører ikke inden for ${o.windowBack} dage før / ${o.windowFwd} dage efter ${ref}${nx ? ` (næste: ${nx})` : ''}` }); }
    }
    items.push({ key, agreementIds: ags.map((a) => a.id), addressId, customerId: ags[0].customerId, routeId: from.id, rcls, pt, ref, d0, nOf, curShift: sh, cur, cands, why });
  }
  // Fase 1: hele rutedage som enheder – kunderne på en rute med samme dag i rytmen flyttes samme antal dage
  if (o.mode === 'routes') {
    const custItems = items.splice(0);
    for (const rc of new Set(custItems.map((it) => it.rcls))) {
      const r = routeById.get(rc.split('@')[0]);
      if (excl.has(r.id)) continue; const mine = custItems.filter((it) => it.rcls === rc); if (!mine.length) continue;
      const ags = mine.flatMap((it) => it.agreementIds.map((id) => ({ it, a: db.agreements.find((x) => x.id === id) })));
      const cands = [];
      for (let s = -o.windowBack; s <= o.windowFwd; s++) {
        if (!s) continue; const anchors = ags.map(({ it, a }) => D.addDays(it.d0.get(a.id), s));
        if (anchors.some((d) => d < start || isOff(d))) continue;
        const os = ags.map(({ it, a }, i) => occN(a, anchors[i], it.nOf.get(a.id), end, o.windowFwd)); if (os.some((x) => !x)) continue;
        cands.push({ routeId: r.id, shift: s, occ: ags.flatMap(({ it, a }, i) => os[i].map((date) => ({ date, min: (a.durationMin ?? 15) + (o.stopMin || 0), pt: it.pt, addressId: it.addressId }))) });
      }
      const first = mine.map((it) => it.ref).sort()[0];
      items.push({ key: rc, isRoute: true, routeId: r.id, pt: -1, ref: first, cur: mine.flatMap((it) => it.cur), cands, why: [], agreementIds: [], n: mine.length });
    }
  }
  const dates = []; for (let d = start; d <= end; d = D.addDays(d, 1)) if (!isOff(d)) dates.push(d);
  return { pts, dates, items, fixed, routes, skipped, opts: o, start, end };
}

/* ---------- Tilstand: én tur pr. dato (liste af stop {pt, min, item}) ---------- */
function makeState(P) {
  const n = P.pts.length; const f = P.opts.factor; const M = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i * n + j] = i === j ? 0 : legMin(P.pts[i], P.pts[j], f);
  const dist = (i, j) => (i < 0 || j < 0 || (i === 0 && !P.pts[0]) || (j === 0 && !P.pts[0]) ? 0 : M[i * n + j]);
  const idx = new Map(P.dates.map((d, i) => [d, i])); const ix = (d) => idx.get(d) ?? Math.round(D.diffDays(P.start, d) * 5 / 7);
  const days = new Map(P.dates.map((d) => [d, { tour: [], work: 0, drive: 0, idx: ix(d) }]));
  const day = (d) => { if (!days.has(d)) days.set(d, { tour: [], work: 0, drive: 0, idx: ix(d) }); return days.get(d); };
  return { dist, days, day };
}
const tourLen = (S, t) => { let s = 0, prev = 0; for (const x of t) { s += S.dist(prev, x.pt); prev = x.pt; } return s + S.dist(prev, 0); };
function reorder(S, dy) { // nærmeste nabo + 2-opt fra startadressen
  const t = dy.tour; if (t.length < 2) { dy.drive = tourLen(S, t); return; }
  const ord = optimize(t.length, (i, j) => S.dist(i === t.length ? 0 : t[i].pt, j === t.length ? 0 : t[j].pt), t.length);
  dy.tour = ord.map((i) => t[i]); dy.drive = tourLen(S, dy.tour);
}
function insertCost(S, t, pt) { // billigste indsættelse
  let best = Infinity, at = 0; const m = t.length;
  for (let i = 0; i <= m; i++) { const a = i ? t[i - 1].pt : 0, b = i < m ? t[i].pt : 0; const c = S.dist(a, pt) + S.dist(pt, b) - S.dist(a, b); if (c < best) { best = c; at = i; } }
  return { cost: best, at };
}
const removeGain = (S, t, i) => { const a = i ? t[i - 1].pt : 0, b = i < t.length - 1 ? t[i + 1].pt : 0; return S.dist(a, t[i].pt) + S.dist(t[i].pt, b) - S.dist(a, b); };
const total = (dy) => dy.work + dy.drive;

/** Samlet strafværdi for alle dage. */
function objective(S, o) { let s = 0; for (const dy of S.days.values()) s += dy.drive + dayCost(dy, dy.work, dy.drive, o); return s; }

/**
 * Optimér. Returnerer { moves, before, after } – intet i databasen ændres.
 * moves: [{ key, agreementIds, addressId, customerId, fromRoute, toRoute, shift, anchors{agId:dato}, fromDate, toDate, gain }]
 * before/after: { perDate: {dato: {work, drive, n}}, drive, over, under, objective }
 */
export function runOptimizer(P, { seed = 1, now = () => Date.now() } = {}) {
  const o = P.opts; const S = makeState(P);
  for (const x of P.fixed) { const dy = S.day(x.date); dy.tour.push({ pt: x.pt, min: x.min, item: null }); dy.work += x.min; }
  const choice = new Map(); // item.key → kandidat (ingen = bliver)
  for (const it of P.items) for (const c of it.cur) { const dy = S.day(c.date); dy.tour.push({ pt: c.pt, min: c.min, item: it.key }); dy.work += c.min; }
  for (const dy of S.days.values()) reorder(S, dy);
  const before = summary(S, o);
  let rnd = seed >>> 0 || 1; const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  /** Fjern alle stop for nøglerne (husk positioner, så genindsættelse giver præcis samme ture). */
  const removeKeys = (keys) => { const removed = []; let delta = 0;
    for (const [d, dy] of S.days) for (let i = dy.tour.length - 1; i >= 0; i--) if (keys.has(dy.tour[i].item)) {
      const b = dy.drive + dayCost(dy, dy.work, dy.drive, o); const g = removeGain(S, dy.tour, i); const [x] = dy.tour.splice(i, 1);
      dy.drive -= g; dy.work -= x.min; removed.push({ d, i, x, g }); delta += dy.drive + dayCost(dy, dy.work, dy.drive, o) - b; }
    return { removed, delta }; };
  const restore = (removed) => { for (const r of [...removed].reverse()) { const dy = S.days.get(r.d); dy.tour.splice(r.i, 0, r.x); dy.drive += r.g; dy.work += r.x.min; } };
  const costOf = (occ) => { // indsæt midlertidigt pr. dato (billigste indsættelse, ét stop ad gangen) og fjern igen
    const byDate = new Map(); for (const c of occ) byDate.set(c.date, [...(byDate.get(c.date) || []), c]);
    let s = 0; for (const [d, cs] of byDate) { const dy = S.day(d); let ic = 0, min = 0; const added = [];
      for (const c of cs) { const x = insertCost(S, dy.tour, c.pt); const e = { pt: c.pt, min: c.min, item: '~' }; dy.tour.splice(x.at, 0, e); added.push(e); ic += x.cost; min += c.min; }
      dy.tour = dy.tour.filter((e) => !added.includes(e));
      s += ic + dayCost(dy, dy.work + min, dy.drive + ic, o) - dayCost(dy, dy.work, dy.drive, o); }
    return s; };
  const place = (key, occ) => { for (const c of occ) { const dy = S.day(c.date); const { cost, at } = insertCost(S, dy.tour, c.pt); dy.tour.splice(at, 0, { pt: c.pt, min: c.min, item: key }); dy.drive += cost; dy.work += c.min; } };
  // naboer (≤ nearMin minutters kørsel) – til samlede flytninger, så en hel klynge kan skifte dag
  const nearMin = o.nearMin ?? 6; const nb = new Map();
  if (!P.items.some((x) => x.isRoute)) for (const a of P.items) { if (a.pt < 0 || !a.cands.length) continue;
    nb.set(a.key, P.items.filter((b) => b !== a && b.pt >= 0 && b.cands.length && S.dist(a.pt, b.pt) <= nearMin)); }
  const curOcc = (x) => (choice.get(x.key)?.occ || x.cur); const sig = (x) => curOcc(x).map((c) => c.date).sort().join();
  let pass = 0;
  const greedy = (ms) => { const t0 = now(); let improved = true, p = 0;
  while (improved && p < 30 && now() - t0 < ms) {
    improved = false; p++; pass++;
    const order = P.items.filter((it) => it.cands.length).map((it) => [rand(), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    for (const it of order) {
      if (now() - t0 > ms) break;
      const mc = it.isRoute ? o.routeMoveCost : o.moveCost;
      const { removed, delta } = removeKeys(new Set([it.key]));
      const stay = -delta; // tilbage som før = ophæver fjernelsen
      const curChoice = choice.get(it.key) || null;
      let best = { c: curChoice, cost: stay };
      if (curChoice) { const back = costOf(it.cur) - mc; if (back < best.cost - 1e-6) best = { c: null, cost: back }; }
      for (const c of it.cands) { if (c === curChoice) continue; const cost = costOf(c.occ) + (curChoice ? 0 : mc); if (cost < best.cost - 1e-6) best = { c, cost }; }
      if (best.c === curChoice) { restore(removed); continue; }
      place(it.key, best.c ? best.c.occ : it.cur);
      if (best.c) choice.set(it.key, best.c); else choice.delete(it.key);
      improved = true;
    }
    // samlede flytninger: kunden + naboer med samme dage flyttes til samme rute og dato
    for (const it of order) {
      if (now() - t0 > ms) break;
      const G = (nb.get(it.key) || []).filter((x) => sig(x) === sig(it)); if (!G.length) continue;
      let best = null; // den bedste samlede flytning (ikke bare den første, der hjælper)
      for (const c of it.cands) {
        if (choice.get(it.key) === c) continue; const tgt = D.addDays(it.ref, c.shift);
        const members = [[it, c], ...G.map((x) => [x, x.cands.find((k) => k.routeId === c.routeId && D.addDays(x.ref, k.shift) === tgt)]).filter(([x, k]) => k && choice.get(x.key) !== k)];
        if (members.length < 2) continue;
        const { removed, delta } = removeKeys(new Set(members.map(([x]) => x.key)));
        const gain = -delta - (costOf(members.flatMap(([, k]) => k.occ)) + o.moveCost * members.filter(([x]) => !choice.get(x.key)).length);
        restore(removed);
        if (gain > 1e-6 && (!best || gain > best.gain)) best = { gain, members };
      }
      if (best) { removeKeys(new Set(best.members.map(([x]) => x.key))); for (const [x, k] of best.members) { place(x.key, k.occ); choice.set(x.key, k); } improved = true; }
    }
    for (const dy of S.days.values()) reorder(S, dy);
  }
  };
  greedy(o.timeMs);
  // Dybere søgning (simulated annealing): tager også midlertidigt dårligere skridt, så fx en fuld dag kan give plads til en hel klynge
  if (o.saMs > 0) {
    const byKey = new Map(P.items.map((it) => [it.key, it])); const mcOf = (it) => (it.isRoute ? o.routeMoveCost : o.moveCost);
    const exact = () => objective(S, o) + [...choice.keys()].reduce((a, k) => a + mcOf(byKey.get(k)), 0);
    const rebuild = (ch) => { for (const dy of S.days.values()) { dy.tour = []; dy.work = 0; dy.drive = 0; }
      for (const x of P.fixed) { const dy = S.day(x.date); dy.tour.push({ pt: x.pt, min: x.min, item: null }); dy.work += x.min; }
      for (const it of P.items) for (const c of (ch.get(it.key)?.occ || it.cur)) { const dy = S.day(c.date); dy.tour.push({ pt: c.pt, min: c.min, item: it.key }); dy.work += c.min; }
      for (const dy of S.days.values()) reorder(S, dy); choice.clear(); for (const [k, v] of ch) choice.set(k, v); };
    const pool = P.items.filter((it) => it.cands.length);
    let obj = exact(), best = obj, bestCh = new Map(choice); const t1 = now(); const T0 = o.saT0 ?? 15; let iter = 0;
    while (pool.length && now() - t1 < o.saMs) {
      const T = T0 * Math.pow(0.02, (now() - t1) / o.saMs);
      const it = pool[Math.floor(rand() * pool.length)]; const cc = choice.get(it.key) || null;
      const opts = cc ? [null, ...it.cands.filter((c) => c !== cc)] : it.cands; const c = opts[Math.floor(rand() * opts.length)];
      const members = [[it, c]];
      if (rand() < 0.4) { const sg = sig(it); const tgt = c ? D.addDays(it.ref, c.shift) : null;
        for (const x of nb.get(it.key) || []) { if (sig(x) !== sg) continue; const k = c ? x.cands.find((y) => y.routeId === c.routeId && D.addDays(x.ref, y.shift) === tgt) : null;
          if (c ? k && choice.get(x.key) !== k : choice.get(x.key)) members.push([x, k || null]); } }
      const { removed, delta } = removeKeys(new Set(members.map(([x]) => x.key)));
      const mcd = members.reduce((a, [x, k]) => a + ((k ? 1 : 0) - (choice.get(x.key) ? 1 : 0)) * mcOf(x), 0);
      const d = delta + costOf(members.flatMap(([x, k]) => (k ? k.occ : x.cur))) + mcd;
      if (d < 0 || rand() < Math.exp(-d / T)) {
        for (const [x, k] of members) { place(x.key, k ? k.occ : x.cur); if (k) choice.set(x.key, k); else choice.delete(x.key); }
        obj += d; if (obj < best - 1e-6) { best = obj; bestCh = new Map(choice); }
      } else restore(removed);
      if (++iter % 2000 === 0) { for (const dy of S.days.values()) reorder(S, dy); obj = exact(); if (obj < best - 1e-6) { best = obj; bestCh = new Map(choice); } }
    }
    rebuild(bestCh); greedy(o.timeMs);
  }
  const after = summary(S, o);
  const moves = P.items.filter((it) => choice.has(it.key)).map((it) => { const c = choice.get(it.key);
    return { key: it.key, isRoute: !!it.isRoute, n: it.n, agreementIds: it.agreementIds, addressId: it.addressId, customerId: it.customerId, fromRoute: it.routeId, toRoute: c.routeId, shift: c.shift,
      anchors: c.anchors ? Object.fromEntries(c.anchors) : null, fromDate: it.ref, toDate: D.addDays(it.ref, c.shift), fromDates: it.cur.map((x) => x.date), toDates: c.occ.map((x) => x.date) }; });
  return { moves, before, after, passes: pass };
}
function summary(S, o) {
  const perDate = {}; let drive = 0, over = 0, under = 0, work = 0;
  for (const [d, dy] of [...S.days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { if (!dy.tour.length) continue; const T = total(dy);
    perDate[d] = { work: Math.round(dy.work), drive: Math.round(dy.drive), n: dy.tour.length }; drive += dy.drive; work += dy.work;
    over += Math.max(0, T - o.maxDay); under += Math.max(0, o.minDay - T); }
  return { perDate, drive: Math.round(drive), work: Math.round(work), over: Math.round(over), under: Math.round(under), objective: Math.round(objective(S, o)) };
}

/** Evaluér en delmængde af flytningerne (når brugeren fjerner nogle): dagstal med kun de valgte flytninger. */
export function evaluate(P, moves) {
  const o = P.opts; const S = makeState(P); const chosen = new Map(moves.map((m) => [m.key, m]));
  for (const x of P.fixed) { const dy = S.day(x.date); dy.tour.push({ pt: x.pt, min: x.min, item: null }); dy.work += x.min; }
  for (const it of P.items) { const m = chosen.get(it.key); const c = m && it.cands.find((k) => k.routeId === m.toRoute && k.shift === m.shift);
    for (const x of c ? c.occ : it.cur) { const dy = S.day(x.date); dy.tour.push({ pt: x.pt, min: x.min, item: it.key }); dy.work += x.min; } }
  for (const dy of S.days.values()) reorder(S, dy);
  return summary(S, o);
}

/** Stoppene (adresse-id'er og minutter) på en dato efter de valgte flytninger – bruges til kontrol med Google. */
export function dayStops(P, moves, date) {
  const chosen = new Map(moves.map((m) => [m.key, m])); const out = [];
  for (const x of P.fixed) if (x.date === date) out.push({ visitId: x.visitId, min: x.min });
  for (const it of P.items) { const m = chosen.get(it.key); const c = m && it.cands.find((k) => k.routeId === m.toRoute && k.shift === m.shift);
    for (const x of c ? c.occ : it.cur) if (x.date === date) out.push({ addressId: x.addressId, min: x.min }); }
  return out;
}

/**
 * Hvorfor (ikke) flyttet? For hver af kundens adresser: årsag hvis den ikke kan flyttes, ellers hver mulig flytning
 * med ændring i samlet strafværdi (negativ = bedre) og timerne på dagene før/efter – målt oven på de valgte flytninger.
 */
export function explain(P, moves, customerId) {
  const base = evaluate(P, moves); const T = (x) => (x ? x.work + x.drive : 0); const out = [];
  for (const s of P.skipped.filter((x) => x.customerId === customerId)) out.push({ addressId: s.addressId, routeId: s.routeId, why: s.why });
  for (const it of P.items.filter((x) => x.customerId === customerId)) {
    if (it.whyAll) { out.push({ addressId: it.addressId, routeId: it.routeId, why: it.whyAll }); continue; }
    const others = moves.filter((m) => m.key !== it.key); const mine = moves.find((m) => m.key === it.key);
    const stay = mine ? evaluate(P, others) : base;
    const opts = it.cands.map((c) => { const ev = mine && mine.toRoute === c.routeId && mine.shift === c.shift ? base : evaluate(P, [...others, { key: it.key, toRoute: c.routeId, shift: c.shift }]);
      const days = [...new Set([...it.cur.map((x) => x.date), ...c.occ.map((x) => x.date)])].sort().map((d) => ({ d, before: T(stay.perDate[d]), after: T(ev.perDate[d]) }));
      return { routeId: c.routeId, shift: c.shift, toDate: D.addDays(it.ref, c.shift), delta: Math.round(ev.objective - stay.objective + P.opts.moveCost), drive: ev.drive - stay.drive, chosen: mine?.toRoute === c.routeId && mine?.shift === c.shift, days }; })
      .sort((a, b) => a.delta - b.delta);
    out.push({ addressId: it.addressId, routeId: it.routeId, ref: it.ref, moved: !!mine, opts, why: it.why });
  }
  return out;
}

/** Fase 1 (hele ruter) + fase 2 (enkeltkunder). routeShifts givet = spring fase 1 over (bruges når ruteflytninger fravælges). */
export function optimizeAll(db, opts, { routeShifts, now } = {}) {
  let routeMoves = [], before0;
  if (!routeShifts) {
    const P1 = buildProblem(db, { ...opts, mode: 'routes', saMs: Math.round((opts.saMs || 0) / 4) }); const r1 = runOptimizer(P1, { now });
    routeMoves = r1.moves.map((m) => ({ key: m.key, routeId: m.toRoute, shift: m.shift, fromDate: m.fromDate, toDate: m.toDate, n: m.n })); before0 = r1.before;
    routeShifts = Object.fromEntries(routeMoves.map((m) => [m.key, m.shift]));
  }
  const P = buildProblem(db, { ...opts, routeShifts }); const r2 = runOptimizer(P, { now });
  if (!before0) before0 = evaluate(buildProblem(db, opts), []);
  return { P, routeShifts, routeMoves, moves: r2.moves, before: before0, after: r2.after };
}
/**
 * Alle flytninger der skal gennemføres: de valgte kundeflytninger + kunder der følger med deres rute.
 * routeAnchors: ny dato for de flyttede ruter (rutens egen dato/rytme rettes, så nye kunder lander rigtigt).
 */
export function finalMoves(P, customerMoves) {
  const sel = new Map(customerMoves.map((m) => [m.key, m])); const out = []; const routeAnchors = {};
  for (const it of P.items) {
    const old = it.cur.map((x) => D.addDays(x.date, -(it.curShift || 0)));
    if (sel.has(it.key)) { out.push({ ...sel.get(it.key), fromDates: old }); continue; }
    if (!it.curShift) continue;
    const anchors = Object.fromEntries([...it.d0].map(([id, d]) => [id, D.addDays(d, it.curShift)]));
    out.push({ key: it.key, agreementIds: it.agreementIds, addressId: it.addressId, customerId: it.customerId, fromRoute: it.routeId, toRoute: it.routeId, shift: it.curShift, anchors,
      fromDate: it.ref, toDate: D.addDays(it.ref, it.curShift), fromDates: old, toDates: it.cur.map((x) => x.date) });
    const a0 = Object.values(anchors).sort()[0]; if (!routeAnchors[it.routeId] || a0 < routeAnchors[it.routeId]) routeAnchors[it.routeId] = a0;
  }
  return { moves: out, routeAnchors };
}
