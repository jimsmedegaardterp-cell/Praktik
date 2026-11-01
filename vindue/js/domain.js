// Ren domænelogik – ingen DOM, ingen netværk, ingen lagring.
// Alt her er deterministisk og testet i tests/domain.test.mjs.

/* ---------------- Datoer (ISO 'YYYY-MM-DD', beregnet i UTC for at undgå sommertidsfejl) ---------------- */
export const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const toIso = (dt) => dt.toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
export const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
export const weekday = (iso) => (toDate(iso).getUTCDay() + 6) % 7; // 0 = mandag … 6 = søndag
export const month = (iso) => toDate(iso).getUTCMonth() + 1;
export function isoWeek(iso) {
  const d = toDate(iso); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

/* ---------------- Danske helligdage ---------------- */
function easter(y) { // Anonym gregoriansk algoritme
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return toIso(new Date(Date.UTC(y, mo - 1, da)));
}
const holidayCache = new Map();
export function danishHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easter(y);
  const set = new Set([
    `${y}-01-01`, addDays(e, -3), addDays(e, -2), e, addDays(e, 1),
    addDays(e, 39), addDays(e, 49), addDays(e, 50),
    `${y}-06-05`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`, `${y}-12-31`,
  ]);
  // Store bededag er afskaffet fra 2024. Grundlovsdag, juleaften og nytårsaften er ikke lovpligtige
  // helligdage, men behandles som lukkedage her (konfigurerbart senere).
  if (y < 2024) set.add(addDays(e, 26));
  holidayCache.set(y, set);
  return set;
}
export const isClosedDay = (iso, extraClosed = []) =>
  weekday(iso) >= 5 || danishHolidays(+iso.slice(0, 4)).has(iso) || extraClosed.includes(iso);
export function nextWorkday(iso, extraClosed = []) {
  let d = iso; let guard = 0;
  while (isClosedDay(d, extraClosed)) { d = addDays(d, 1); if (++guard > 30) throw new Error('Ingen arbejdsdag fundet'); }
  return d;
}

/* ---------------- Besøgsplan ----------------
 * En aftale har en grundrytme: anchorDate + k * intervalWeeks.
 * Besøget får et deterministisk id `${agreementId}#${k}` → samme besøg kan aldrig dannes to gange.
 * Sæson: seasonMonths = [3,4,...,11]; rytmedatoer uden for sæson springes over.
 * Helligdag/lukkedag → næste arbejdsdag (grundrytmen ændres ikke).
 */
export function rhythmDate(agreement, k) { return addDays(agreement.anchorDate, k * agreement.intervalWeeks * 7); }
export function inSeason(agreement, iso) { return !agreement.seasonMonths?.length || agreement.seasonMonths.includes(month(iso)); }

export function generateVisits(agreement, fromIso, toIso_, existing = [], extraClosed = []) {
  if (!agreement.active) return [];
  const have = new Set(existing.map((v) => v.id));
  const out = [];
  const step = agreement.intervalWeeks * 7;
  let k = Math.max(0, Math.ceil(diffDays(agreement.anchorDate, fromIso) / step));
  for (; ; k++) {
    const r = rhythmDate(agreement, k);
    if (r > toIso_) break;
    if (!inSeason(agreement, r)) continue;
    const id = `${agreement.id}#${k}`;
    if (have.has(id)) continue;
    out.push({
      id, agreementId: agreement.id, customerId: agreement.customerId, addressId: agreement.addressId,
      routeId: agreement.routeId, seriesIndex: k, rhythmDate: r, plannedDate: nextWorkday(r, extraClosed),
      status: 'planlagt', price: agreement.price, service: agreement.service, completion: null, history: [],
    });
  }
  return out;
}

/* ---------------- Statusmaskine for besøg ---------------- */
export const RESULTS = { udfoert: 'Udført', delvis: 'Delvist udført', forgaeves: 'Forgæves besøg', udsat: 'Udsat', aflyst: 'Aflyst' };
const FINAL = new Set(['udfoert', 'delvis', 'forgaeves', 'aflyst']);
const BILLABLE = new Set(['udfoert', 'delvis']);
export const isBillable = (v) => BILLABLE.has(v.status);

/**
 * Registrér resultat præcis én gang. opId (genereres på klienten ved tryk) gør gentagne kald
 * (dobbelttryk, offline-genforsøg) til no-ops. Returnerer { visit, changed }.
 */
export function completeVisit(visit, { result, opId, by, at, note = '', price, cashPaid = false }) {
  if (!RESULTS[result]) throw new Error(`Ukendt resultat: ${result}`);
  if (visit.completion) {
    if (visit.completion.opId === opId) return { visit, changed: false }; // samme handling gentaget
    if (FINAL.has(visit.status)) return { visit, changed: false, conflict: `Besøget er allerede registreret som "${RESULTS[visit.status]}"` };
  }
  if (result === 'udsat') {
    return { visit: { ...visit, status: 'udsat', history: [...visit.history, { at, by, action: 'udsat', note }] }, changed: true };
  }
  const p = price ?? visit.price;
  const next = {
    ...visit, status: result, price: p,
    completion: { opId, by, at, note, result, priceChanged: p !== visit.price, originalPrice: visit.price, cashPaid: !!cashPaid && BILLABLE.has(result) },
    history: [...visit.history, { at, by, action: result, note, price: p }],
  };
  return { visit: next, changed: true };
}

/** Admin-rettelse: altid sporbar, og ikke tilladt når besøget allerede er knyttet til en faktura. */
export function correctVisit(visit, { by, at, status, price, reason }, invoiceLinks = []) {
  if (!reason) throw new Error('Rettelse kræver begrundelse');
  if (invoiceLinks.some((l) => l.visitIds.includes(visit.id) && l.status !== 'fejl'))
    throw new Error('Besøget er faktureret – ret via kreditnota i e-conomic');
  return { ...visit, status: status ?? visit.status, price: price ?? visit.price,
    history: [...visit.history, { at, by, action: 'rettelse', from: { status: visit.status, price: visit.price }, to: { status, price }, note: reason }] };
}

/**
 * Flyt et planlagt besøg.
 * mode 'keep'  → kun dette besøg flyttes; grundrytmen bevares.
 * mode 'shift' → aftalens anker forskydes; alle senere planlagte besøg i serien flyttes tilsvarende.
 * Returnerer { visits, agreement }.
 */
export function moveVisit(visits, agreement, visitId, newDate, mode, { by, at }, extraClosed = []) {
  const v = visits.find((x) => x.id === visitId);
  if (!v) throw new Error('Besøg findes ikke');
  if (v.status !== 'planlagt' && v.status !== 'udsat') throw new Error('Kun planlagte/udsatte besøg kan flyttes');
  const delta = diffDays(v.plannedDate, newDate);
  const log = (x, from) => [...x.history, { at, by, action: 'flyttet', from, to: x.plannedDate, mode }];
  if (mode === 'keep') {
    return { agreement, visits: visits.map((x) => x.id === visitId
      ? (() => { const n = { ...x, plannedDate: newDate, status: 'planlagt' }; n.history = log(n, x.plannedDate); return n; })() : x) };
  }
  if (mode !== 'shift') throw new Error('Ukendt flyttetype');
  const rDelta = diffDays(v.rhythmDate, newDate); // ny grundrytme starter på den valgte dato
  const ag = { ...agreement, anchorDate: addDays(agreement.anchorDate, rDelta) };
  return { agreement: ag, visits: visits.map((x) => {
    if (x.agreementId !== agreement.id || x.seriesIndex < v.seriesIndex) return x;
    if (x.status !== 'planlagt' && x.status !== 'udsat') return x;
    const r = rhythmDate(ag, x.seriesIndex);
    const n = { ...x, rhythmDate: r, plannedDate: x.id === visitId ? newDate : nextWorkday(r, extraClosed), status: 'planlagt' };
    n.history = log(n, x.plannedDate);
    return n;
  }) , delta };
}

/** Dobbeltbooking: samme adresse planlagt mere end én gang samme dag. */
export function findDoubleBookings(visits) {
  const m = new Map();
  for (const v of visits) { if (v.status === 'aflyst') continue; const k = `${v.addressId}|${v.plannedDate}`; m.set(k, [...(m.get(k) || []), v.id]); }
  return [...m.values()].filter((ids) => ids.length > 1);
}

/* ---------------- Faktureringskø ---------------- */
/** Besøg der er udført, men endnu ikke (succesfuldt) knyttet til en faktura. */
export function invoiceQueue(visits, invoiceLinks) {
  const linked = new Set(invoiceLinks.filter((l) => l.status !== 'fejl').flatMap((l) => l.visitIds));
  return visits.filter((v) => isBillable(v) && !linked.has(v.id));
}

/** Idempotensnøgle: afhænger kun af hvilke besøg der faktureres – samme besøg → samme nøgle. */
export const idempotencyKey = (visitIds) => 'inv:' + [...visitIds].sort().join(',');

/** Grupper køen pr. kunde (samlefaktura pr. kunde – kan slås fra). */
export function groupForInvoicing(queue, { perCustomer = true } = {}) {
  if (!perCustomer) return queue.map((v) => [v]);
  const g = new Map();
  for (const v of queue) g.set(v.customerId, [...(g.get(v.customerId) || []), v]);
  return [...g.values()];
}

/* ---------------- Telefonnumre / SMS ---------------- */
export function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\d{8}$/.test(s)) s = '+45' + s;
  if (/^45\d{8}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

/** GSM-7 vs. Unicode og antal SMS-dele (påvirker prisen). */
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
export function smsParts(text) {
  let len = 0; let unicode = false;
  for (const ch of text) { if (GSM7.includes(ch)) len += 1; else if (GSM7_EXT.includes(ch)) len += 2; else { unicode = true; break; } }
  if (unicode) { const n = [...text].length; return { encoding: 'UCS-2', parts: n <= 70 ? 1 : Math.ceil(n / 67), chars: n }; }
  return { encoding: 'GSM-7', parts: len <= 160 ? 1 : Math.ceil(len / 153), chars: len };
}

export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

/** Indgående SMS → kunde via normaliseret nummer. Flere kunder med samme nummer → manuel. */
export function matchInbound(phone, customers) {
  const p = normalizePhone(phone);
  const hits = customers.filter((c) => normalizePhone(c.phone) === p);
  return hits.length === 1 ? hits[0].id : null;
}

/* ---------------- Provision ---------------- */
/** Grundlag er konfigurerbart; standard: udført beløb ekskl. moms pr. udførende medarbejder. */
export function commission(visits, { rate = 0.35, rates = {}, from, to, inclVat = false, vatRate = 0.25 } = {}) {
  const per = {};
  for (const v of visits) {
    if (!isBillable(v) || !v.completion) continue;
    const d = v.completion.at.slice(0, 10);
    if ((from && d < from) || (to && d > to)) continue;
    const base = inclVat ? v.price * (1 + vatRate) : v.price;
    const e = (per[v.completion.by] ||= { base: 0, visits: 0 });
    e.base += base; e.visits += 1;
  }
  for (const k in per) { per[k].rate = rates[k] ?? rate; per[k].commission = Math.round(per[k].base * per[k].rate * 100) / 100; }
  return per;
}
