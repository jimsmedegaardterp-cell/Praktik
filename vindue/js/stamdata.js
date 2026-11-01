// Læser SkvizBiz' "Stamdata for valgte kunder"-PDF (kundekort-layout, ikke tabel).
// Opbygning (set 1/11-2026):
//   Kundenr. 00000003 - Navn
//   Leveringsadresse:            Faktureringsadresse:
//   <navn> / <vej> / [<ekstra linje>] / <postnr by>   (venstre og højre kolonne)
//   Tlf.: …                      Betalingsbetingelser: d.d. + 8 dage
//   Email: …                     CVR-nummer: …
//   EAN-nummer: …
//   Noter: … (kan fortsætte på flere linjer)
//   Aftaler med kunden | Interval | Næste gang | Pris ex moms | Tid
//   <beskrivelse> | Hver 8. uge | 15/12-2026 | kr. 96,00 | 0:05
import * as D from './domain.js';
import { parsePrice, parseDate, parseInterval, parseDuration } from './import.js';

const NONE = /^ikke oplyst$/i;
const FITS = { service: /./, interval: /^(hver|ikke fast|\d+\s*(uge|uger|md|måned))/i, next: /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|-)$/, price: /^(kr\.?\s*)?-?[\d.]+,\d{2}$|^kr\.?\s*[\d.,]+$/i, dur: /^\d{1,2}:\d{2}$/ };
const val = (s) => { const v = String(s ?? '').replace(/^[^:]*:\s*/, '').trim(); return NONE.test(v) ? '' : v; };

/** items: [{str,x,y,w,page}] fra pdf.js → kunder */
export function parseStamdataItems(items) {
  // linjer (samme side og y)
  const lines = [];
  for (const it of items.filter((i) => i.str && i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const l = lines.find((L) => L.page === it.page && Math.abs(L.y - it.y) <= 2);
    if (l) l.items.push(it); else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  const out = []; let c = null; let mode = null; let split = 300; let cols = null;
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x); const text = its.map((i) => i.str).join(' ').trim();
    if (/^Eksporteret fra SkvizBiz|^Powered by|^Side \d+ af \d+$/i.test(text)) continue;
    const m = text.match(/^Kundenr\.\s*(\d+)\s*-\s*(.*)$/);
    if (m) { c = { extId: m[1].padStart(8, '0'), name: m[2].trim(), delivery: [], billing: [], phone: '', email: '', paymentDays: null, cvr: '', ean: '', notes: [], agreements: [] }; out.push(c); mode = null; continue; }
    if (!c) continue;
    const left = its.filter((i) => i.x < split), right = its.filter((i) => i.x >= split);
    const L = left.map((i) => i.str).join(' ').trim(), R = right.map((i) => i.str).join(' ').trim();
    if (/^Leveringsadresse:/i.test(L)) { mode = 'addr'; const fa = right.find((i) => /^Faktureringsadresse/i.test(i.str)); split = fa ? fa.x - 5 : 300; continue; }
    if (/^Aftaler med kunden/i.test(text)) { mode = 'agr'; cols = its.map((i) => ({ x: i.x, key: /interval/i.test(i.str) ? 'interval' : /næste/i.test(i.str) ? 'next' : /pris/i.test(i.str) ? 'price' : /^tid$/i.test(i.str) ? 'dur' : 'service' })); continue; }
    if (/^Tlf\.?:/i.test(L) || /^Email:/i.test(L) || /^EAN-nummer:/i.test(L) || /^Betalingsbetingelser:/i.test(R) || /^CVR/i.test(R)) {
      mode = 'fields';
      for (const s of [L, R]) {
        if (/^Tlf\.?:/i.test(s)) c.phone = val(s);
        else if (/^Email:/i.test(s)) c.email = val(s);
        else if (/^EAN-nummer:/i.test(s)) c.ean = val(s);
        else if (/^CVR/i.test(s)) c.cvr = val(s);
        else if (/^Betalingsbetingelser:/i.test(s)) { const d = s.match(/\+\s*(\d+)/); c.paymentDays = d ? +d[1] : null; c.paymentText = val(s); }
      }
      continue;
    }
    if (/^Noter:/i.test(text)) { mode = 'notes'; c.notes.push(val(text)); continue; }
    if (mode === 'addr') { if (L) c.delivery.push(L); if (R) c.billing.push(R); continue; }
    if (mode === 'notes') { c.notes.push(text); continue; }
    if (mode === 'agr') {
      const row = {};
      for (const it of its) {
        const center = it.x + (it.w || 0) / 2; let k = cols[0].key; for (const col of cols) if (col.x <= center + 2) k = col.key;
        // lang beskrivelse kan række ind over talkolonnerne – kun tekst der ligner værdien må lande der
        if (!FITS[k]?.test(it.str.trim())) { k = cols[0].key; for (const col of cols) if (col.x <= it.x + 2) k = col.key; if (!FITS[k]?.test(it.str.trim())) k = 'service'; }
        row[k] = row[k] ? row[k] + ' ' + it.str : it.str;
      }
      if (!row.interval && !row.next && !row.price && c.agreements.length) c.agreements[c.agreements.length - 1].service += ' ' + (row.service || '');
      else c.agreements.push({ service: (row.service || 'Vinduesvask').trim(), interval: row.interval || '', next: row.next || '', price: row.price || '', dur: row.dur || '' });
    }
  }
  for (const c of out) { // e-mail havnet i telefonfeltet (kunder uden telefon) – og omvendt
    if (c.phone.includes('@')) { if (!c.email) c.email = c.phone; c.phone = ''; }
    if (c.email && !c.email.includes('@') && /^[\d\s+]{8,}$/.test(c.email)) { if (!c.phone) c.phone = c.email; c.email = ''; }
  }
  return out;
}

/** Adresse-linjer → { street, address2, zipCity }. Første linje er navnet (eller c/o). */
export function splitAddress(lines, name) {
  const ls = [...lines]; if (ls.length && ls[0].trim().toLowerCase() === String(name).trim().toLowerCase()) ls.shift();
  const zi = ls.findIndex((x) => /^\d{4}\s+\S/.test(x));
  const zipCity = zi >= 0 ? ls[zi] : ''; const rest = zi >= 0 ? ls.slice(0, zi) : ls;
  return { street: rest[0] || '', address2: rest.slice(1).join(', '), zipCity };
}

const INVOICE_MEDIA = { ean: 'ean', email: 'email', sms: 'sms', print: 'print' };
const yes = (v) => v === true || v === 1 || /^(yes|ja|true|1)$/i.test(String(v ?? ''));

/**
 * Importplan ud fra en eller flere stamdata-PDF'er (hver med valgfri rute) + valgfrit GDPR-udtræk.
 * stams: [{ fileName, routeId, customers }], gdpr: { '00000002': normaliseret data.json, ... }
 */
export function buildSkvizPlan(stams, gdpr, db, { today }) {
  const plan = { customers: [], issues: [], duplicates: [], skipped: 0, source: 'skviz' };
  const seen = new Map();
  for (const st of stams) for (const s of st.customers) {
    const line = `${s.extId} (${st.fileName})`;
    if (seen.has(s.extId)) { plan.issues.push({ line, msg: `Kundenr. ${s.extId} findes i flere filer – første bruges`, warn: true }); continue; }
    const g = gdpr?.[s.extId] || null;
    if (g && yes(g.deleted)) { plan.skipped++; continue; }
    const ad = splitAddress(s.delivery, s.name); const bill = splitAddress(s.billing, s.name);
    const street = [ad.street, ad.address2, ad.zipCity].filter(Boolean).join(', ');
    if (!ad.street) plan.issues.push({ line, msg: `${s.name}: mangler adresse`, warn: true });
    const phone = s.phone.replace(/\s/g, '');
    if (phone && !D.normalizePhone(phone)) plan.issues.push({ line, msg: `${s.name}: ukendt telefonnr. "${s.phone}"`, warn: true });
    const ags = s.agreements.map((a) => {
      const iv = parseInterval(a.interval); const price = parsePrice(a.price); const next = parseDate(a.next); const dur = parseDuration(a.dur);
      if (Number.isNaN(iv)) plan.issues.push({ line, msg: `${s.name}: ukendt interval "${a.interval}"` });
      if (Number.isNaN(price)) plan.issues.push({ line, msg: `${s.name}: ukendt pris "${a.price}"` });
      if (Number.isNaN(next)) plan.issues.push({ line, msg: `${s.name}: ukendt dato "${a.next}"`, warn: true });
      return { service: a.service, price: Number.isNaN(price) || price == null ? 0 : price, intervalWeeks: Number.isNaN(iv) || iv == null ? 0 : iv, durationMin: dur && !Number.isNaN(dur) ? dur : 15,
        anchorDate: next && !Number.isNaN(next) ? next : today, routeId: (iv && !Number.isNaN(iv) ? st.routeId : null) || null };
    });
    if (!ags.length) plan.issues.push({ line, msg: `${s.name}: ingen aftaler`, warn: true });
    const dupe = db.customers.find((c) => !c.deleted && (c.customerNo === s.extId || c.skvizbizId === s.extId));
    const lat = g ? Number(g.lat) : NaN, lng = g ? Number(g.lon) : NaN;
    const media = g ? INVOICE_MEDIA[String(g.invoice_media || '').toLowerCase()] || (yes(g.sms_invoice) ? 'sms' : 'email') : (s.ean ? 'ean' : 'email');
    const billingDiffers = bill.street && (bill.street !== ad.street || bill.zipCity !== ad.zipCity);
    const c = { line, extId: s.extId, name: s.name, keyStreet: ad.street, phone, email: s.email, notes: '', paymentMethod: g && yes(g.cash_payment) ? 'kontant' : 'bank', dupeOf: dupe?.id || null,
      extra: { customerNo: s.extId, skvizbizId: s.extId, ean: s.ean, cvr: s.cvr, paymentDays: s.paymentDays ?? 8, paymentTerms: `Netto ${s.paymentDays ?? 8} dage`, invoiceType: media,
        invoiceInterval: g && /month/i.test(String(g.billing_frequency_2)) ? 'maaned' : 'besoeg', callBefore: g ? yes(g.call_first) : false, smsBefore: g ? yes(g.sms_first) : false, smsAfter: g ? yes(g.sms_after) : false,
        group: g?.customer_group_id != null ? `Gruppe ${g.customer_group_id}` : 'Privat kunder', blocked: !!g?.timestamp_blocked, skvizId: g?.id ?? null, billingSkvizId: g?.billing_id ?? null,
        billing: billingDiffers ? { address: [bill.street, bill.address2].filter(Boolean).join(', '), zipCity: bill.zipCity } : null },
      addresses: [{ street, access: s.notes.join(' ').trim(), lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, agreements: ags }] };
    if (ags.length > 1) plan.issues.push({ line, msg: `${s.name}: ${ags.length} aftaler lagt på samme adresse – tjek om en af dem hører til en anden adresse`, warn: true });
    plan.customers.push(c); seen.set(s.extId, c);
    if (dupe) plan.duplicates.push({ line, name: s.name, existing: dupe.name });
  }
  if (gdpr) { const missing = Object.keys(gdpr).filter((k) => !seen.has(k) && !yes(gdpr[k].deleted)).length; if (missing) plan.issues.push({ line: 'GDPR', msg: `${missing} kunder i GDPR-udtrækket er ikke i stamdata-PDF'erne (importeres ikke)`, warn: true }); }
  plan.errors = plan.issues.filter((i) => !i.warn).length;
  return plan;
}

/* ---------------- Ruteoversigt ("Komplet ruteoversigt for "Bindslev"") ----------------
 * Kolonner: Nr | Kundenavn | Adresse | Postnr. / by | Tlf | Noter | Aftaler | Interval | Ex. moms | Tid
 * Noter og aftaler kan fylde flere linjer. Rækkefølgen (Nr) er rutens faste rækkefølge.
 */
const RCOLS = [[/^nr$/i, 'nr'], [/kundenavn|navn/i, 'name'], [/adresse/i, 'street'], [/post/i, 'zipCity'], [/^tlf|telefon/i, 'phone'], [/noter/i, 'notes'], [/aftaler/i, 'service'], [/interval/i, 'interval'], [/moms|pris/i, 'price'], [/^tid$/i, 'dur']];
export const isRouteOverview = (items) => items.some((i) => /ruteoversigt for/i.test(i.str));
export function parseRouteOverviewItems(items) {
  const lines = [];
  for (const it of items.filter((i) => i.str && i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const l = lines.find((L) => L.page === it.page && Math.abs(L.y - it.y) <= 2);
    if (l) l.items.push(it); else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  let routeName = ''; let cols = null; const rows = []; let cur = null;
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x); const text = its.map((i) => i.str).join(' ');
    const t = text.match(/ruteoversigt for\s*["“”]?([^"“”(]+)["“”]?/i); if (t) { routeName ||= t[1].trim(); continue; }
    if (its.some((i) => /^Kundenavn$/i.test(i.str))) { cols = its.map((i) => ({ x: i.x, key: (RCOLS.find(([re]) => re.test(i.str)) || [0, null])[1] })).filter((c) => c.key); continue; }
    if (!cols || /^Side \d+ af \d+$|^Powered by/i.test(text.trim())) continue;
    const cell = {};
    // Forkortede navne ("Landbrug ved Johnny Jørgen...") skrives i samme tekststykke som adressen
    // ("Landbrug ved Johnny Jørgen... Stabækvej 1") – del stykket ved "..." eller ved kolonnegrænsen.
    const parts = [];
    for (const it of its) {
      const w = it.w || it.str.length * 4.4;
      const nxt = cols.find((c) => c.x > it.x + 10 && c.x < it.x + w - 8);
      const dots = it.str.search(/(\.\.\.|…)/);
      if (nxt && dots > 0) { const k = dots + (it.str[dots] === '…' ? 1 : 3); const a = it.str.slice(0, k).trim(), b = it.str.slice(k).trim();
        if (a && b) { parts.push({ ...it, str: a, w: nxt.x - it.x - 2 }, { ...it, str: b, x: nxt.x, w: Math.max(4, w - (nxt.x - it.x)) }); continue; } }
      parts.push(it);
    }
    for (const it of parts) { const center = it.x + (it.w || 0) / 2; let k = cols[0].key; for (const c of cols) if (c.x <= center + 2) k = c.key; cell[k] = cell[k] ? cell[k] + ' ' + it.str : it.str; }
    if (cell.nr && /^\d+$/.test(cell.nr.trim())) { cur = { nr: +cell.nr, name: cell.name || '', street: cell.street || '', zipCity: cell.zipCity || '', phone: cell.phone || '', notes: cell.notes || '', agreements: [] }; rows.push(cur); }
    else if (!cur) continue;
    else { for (const k of ['name', 'street', 'zipCity']) if (cell[k]) cur[k] += ' ' + cell[k]; if (cell.notes) cur.notes += ' ' + cell.notes; }
    if (cell.service || cell.interval || cell.price) {
      if (!cell.interval && !cell.price && cur.agreements.length) cur.agreements[cur.agreements.length - 1].service += ' ' + cell.service;
      else cur.agreements.push({ service: (cell.service || 'Vinduesvask').trim(), interval: cell.interval || '', price: cell.price || '', dur: cell.dur || '' });
    }
  }
  for (const r of rows) for (const k of ['name', 'street', 'zipCity', 'notes']) r[k] = r[k].replace(/\s+/g, ' ').trim();
  return { routeName, rows };
}

const keyOf = (name, street) => `${String(name).toLowerCase().replace(/\s+/g, ' ').trim()}|${String(street).toLowerCase().replace(/[\s,.]+/g, ' ').trim()}`;

/**
 * Tilføjer rute + rækkefølge fra ruteoversigter til en importplan.
 * Hver række i en ruteoversigt viser kundens aftaler PÅ DEN RUTE (opgave, interval, pris). Derfor kobles ruten
 * til de enkelte aftaler – ikke til hele kunden. En kunde kan have aftaler på flere ruter, og står rækken med en
 * anden adresse end kundens, flyttes de pågældende aftaler til den adresse.
 * Kunder findes i: 1) planen (stamdata) på navn+adresse, 2) planen på unikt navn, 3) appen (tidligere import),
 * 4) ellers oprettes de fra ruteoversigten uden kundenr.
 */
const normS = (x) => String(x || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
function rowAgreements(row) {
  return row.agreements.map((a) => { const iv = parseInterval(a.interval); const pr = parsePrice(a.price); const du = parseDuration(a.dur);
    return { service: a.service, price: Number.isNaN(pr) || pr == null ? 0 : pr, intervalWeeks: Number.isNaN(iv) || iv == null ? 0 : iv, durationMin: du && !Number.isNaN(du) ? du : 15 }; });
}
/** Find de aftaler hos kunden, der svarer til rækkens aftaler (opgave/pris/interval). */
export function matchAgreements(cands, rowAgs, used = new Set()) {
  const out = [];
  for (const ra of rowAgs) {
    let best = null, bestScore = 0;
    for (const g of cands) {
      if (used.has(g)) continue;
      const a = normS(g.service), b = normS(ra.service);
      let sc = 0;
      if (a && a === b) sc += 3; else if (a && b && (a.includes(b) || b.includes(a))) sc += 2;
      if (Math.abs((g.price ?? 0) - ra.price) < 0.5) sc += 3;
      if ((g.intervalWeeks ?? 0) === ra.intervalWeeks) sc += 1;
      if (sc > bestScore) { best = g; bestScore = sc; }
    }
    if (best && bestScore >= 3) { out.push(best); used.add(best); }
  }
  return out;
}

export function addRouteOverviews(plan, overviews, db, { today }) {
  plan.newRoutes = []; plan.routeOrder = {}; plan.routeUpdates = [];
  const zipOf = (row) => (String(row.zipCity).match(/\d{4}/) || [])[0];
  // Kunder med SAMME navn behandles som en "familie" (fx leveringskonto + betalerkonto i SkvizBiz):
  // rækkens aftaler kan høre til hvem som helst af dem, og hver aftale følger sin egen ejer.
  const planByName = new Map(); for (const c of plan.customers) { const k = normS(c.name); planByName.set(k, [...(planByName.get(k) || []), c]); }
  const owner = new Map(); for (const c of plan.customers) for (const a of c.addresses) for (const g of a.agreements) owner.set(g, c);
  const byKey = new Map(plan.customers.map((c) => [keyOf(c.name, c.keyStreet ?? c.addresses[0].street.split(',')[0]), c]));
  // SkvizBiz forkorter lange navne med "..." – match på begyndelsen; ellers adresse + postnr. hvis entydigt
  const truncated = (name) => /(\.\.\.|…)\s*$/.test(String(name));
  const namePrefix = (name) => normS(String(name).replace(/(\.\.\.|…)\s*$/, ''));
  const nameFits = (cName, rowName) => (truncated(rowName) ? normS(cName).startsWith(namePrefix(rowName)) : normS(cName) === normS(rowName));
  const planFallback = (row) => {
    if (planByName.get(normS(row.name))?.length) return [];
    const byPrefix = truncated(row.name) ? plan.customers.filter((c) => nameFits(c.name, row.name)) : [];
    if (byPrefix.length) return byPrefix;
    const st = normS(row.street.split(',')[0]); const zip = zipOf(row); if (!st) return [];
    const at = plan.customers.filter((c) => c.addresses.some((a) => normS(a.street).startsWith(st) && (!zip || a.street.includes(zip))));
    return new Set(at.map((c) => normS(c.name))).size === 1 ? at : [];
  };
  const findExisting = (row) => {
    const n = normS(row.name), st = normS(row.street); if (!st) return null;
    const same = db.customers.filter((c) => !c.deleted && nameFits(c.name, row.name));
    for (const c of same) { const a = db.addresses.find((x) => x.customerId === c.id && normS(x.street).startsWith(st)); if (a) return { fam: same, a }; }
    if (same.length) return { fam: same, a: null };
    const zip = zipOf(row);
    const hits = db.addresses.filter((x) => normS(x.street).startsWith(st) && (!zip || x.street.includes(zip)) && !db.customers.find((c) => c.id === x.customerId)?.deleted);
    if (hits.length === 1) return { fam: [db.customers.find((c) => c.id === hits[0].customerId)], a: hits[0], byAddress: true };
    return null;
  };
  const routes = []; const apps = []; const stats = { rows: 0, matched: 0 };

  // 1) kunde(familie) og kandidat-aftaler pr. række (rækken kan vise ALLE kundens aftaler)
  for (const ov of overviews) {
    const name = ov.routeName || ov.fileName.replace(/\.pdf$/i, '');
    const existing = db.routes.find((r) => r.name.toLowerCase() === name.toLowerCase());
    const ref = existing ? existing.id : `new:${name}`;
    routes.push({ ref, name, existing, rows: ov.rows.length, matched: 0 }); plan.routeOrder[ref] = [];
    for (const row of ov.rows) {
      stats.rows++; const line = `${name} nr. ${row.nr}`; const rAgs = rowAgreements(row);
      const hit = byKey.get(keyOf(row.name, row.street)); const fam = [...new Set([hit, ...(planByName.get(normS(row.name)) || []), ...planFallback(row)].filter(Boolean))];
      if (fam.length) { apps.push({ ref, nr: row.nr, line, row, kind: 'plan', c: hit || fam[0], fam, cands: matchAgreements(fam.flatMap((c) => c.addresses.flatMap((a) => a.agreements)), rAgs) }); stats.matched++; routes.at(-1).matched++; continue; }
      const ex = findExisting(row);
      if (ex) { if (ex.byAddress) plan.issues.push({ line, msg: `"${row.name}" koblet til "${ex.fam[0].name}" på adressen`, warn: true });
        const ids = new Set(ex.fam.map((c) => c.id));
        apps.push({ ref, nr: row.nr, line, row, kind: 'ex', c: ex.a ? db.customers.find((c) => c.id === ex.a.customerId) : ex.fam[0], fam: ex.fam, exAddr: ex.a, cands: matchAgreements(db.agreements.filter((g) => ids.has(g.customerId) && g.active !== false), rAgs) }); stats.matched++; routes.at(-1).matched++; continue; }
      const c = { line, extId: null, name: row.name, phone: row.phone.replace(/\s/g, ''), email: '', notes: '', paymentMethod: 'bank', dupeOf: null, fromRoute: true,
        extra: { invoiceType: 'email', invoiceInterval: 'besoeg', paymentDays: 8, paymentTerms: 'Netto 8 dage', group: 'Privat kunder' },
        addresses: [{ street: [row.street, row.zipCity].filter(Boolean).join(', '), access: row.notes, lat: null, lng: null, agreements: rAgs.map((g) => ({ ...g, anchorDate: null })) }] };
      plan.customers.push(c); byKey.set(keyOf(row.name, row.street), c); planByName.set(normS(c.name), [...(planByName.get(normS(c.name)) || []), c]);
      for (const g of c.addresses[0].agreements) owner.set(g, c);
      apps.push({ ref, nr: row.nr, line, row, kind: 'plan', c, fam: [c], cands: c.addresses[0].agreements, isNew: true });
      plan.issues.push({ line, msg: `${row.name}: ikke fundet i stamdata – oprettes uden kundenr.; første besøg = rutens næste dato`, warn: true });
    }
  }
  const famAgreements = (a) => (a.kind === 'ex' ? db.agreements.filter((g) => a.fam.some((c) => c.id === g.customerId) && g.active !== false) : a.fam.flatMap((c) => c.addresses.flatMap((x) => x.agreements)));
  // 2) kandidat-ruter pr. fast aftale; ugenkendte faste aftaler i familien er kandidat til alle familiens ruter
  const candRefs = new Map();
  for (const a of apps) for (const g of a.cands) if (g.intervalWeeks) (candRefs.get(g) || candRefs.set(g, new Set()).get(g)).add(a.ref);
  const famRefs = new Map(); for (const a of apps) for (const g of famAgreements(a)) (famRefs.get(g) || famRefs.set(g, new Set()).get(g)).add(a.ref);
  for (const [g, refs] of famRefs) if (g.intervalWeeks && !candRefs.has(g)) candRefs.set(g, refs);
  const assign = new Map(); for (const [g, refs] of candRefs) if (refs.size === 1) assign.set(g, [...refs][0]);
  // 3) rutens rytme/dato ud fra entydige aftaler
  const rInfo = new Map();
  for (const r of routes) {
    const used = r.existing && db.agreements.some((g) => g.routeId === r.existing.id);
    const ags = [...assign].filter(([, ref]) => ref === r.ref).map(([g]) => g).filter((g) => g.intervalWeeks && g.anchorDate);
    rInfo.set(r.ref, used ? { intervalWeeks: r.existing.intervalWeeks, anchorDate: r.existing.anchorDate } : { intervalWeeks: ags.length ? Math.min(...ags.map((g) => g.intervalWeeks)) : 4, anchorDate: ags.map((g) => g.anchorDate).sort()[0] || null });
  }
  // 4) aftaler på flere ruter: dato passer → navnelighed → advarsel
  const words = (x) => normS(x).split(' ').filter((w) => w.length > 3);
  const ownerName = (g) => (g.customerId ? db.customers.find((c) => c.id === g.customerId)?.name : owner.get(g)?.name) || '';
  for (const [g, refs] of candRefs) {
    if (refs.size < 2) continue;
    const list = [...refs]; const fits = list.filter((ref) => { const ri = rInfo.get(ref); return ri.anchorDate && g.anchorDate && D.routeRuns(ri, g.anchorDate) && g.intervalWeeks % ri.intervalWeeks === 0; });
    let pick = fits.length === 1 ? fits[0] : null;
    if (!pick) { const pool = fits.length ? fits : list; const sw = words(g.service);
      const named = pool.filter((ref) => words(routes.find((r) => r.ref === ref).name).some((w) => sw.some((x) => x.startsWith(w.slice(0, 6)) || w.startsWith(x.slice(0, 6)))));
      pick = named.length === 1 ? named[0] : pool[0];
      if (named.length !== 1) plan.issues.push({ line: ownerName(g), msg: `${ownerName(g)}: aftalen "${g.service}" kan høre til ${list.map((r) => routes.find((x) => x.ref === r).name).join(' / ')} – lagt på ${routes.find((x) => x.ref === pick).name}, tjek den`, warn: true }); }
    assign.set(g, pick);
  }
  // 5) række med en adresse, som ingen i familien har → aftaler der nævner adressen eller kun står i denne række flyttes dertil
  for (const a of apps) {
    if (a.kind !== 'plan' || a.isNew) continue;
    const st = normS(a.row.street);
    if (a.fam.some((c) => c.addresses.some((x) => normS(x.street).startsWith(st)))) continue;
    const others = apps.filter((x) => x !== a && x.fam.some((c) => a.fam.includes(c)));
    const move = a.cands.filter((g) => normS(g.service).includes(st) || !others.some((o) => o.cands.includes(g)));
    if (!move.length) continue;
    const c = owner.get(move[0]); const na = { street: [a.row.street, a.row.zipCity].filter(Boolean).join(', '), access: a.row.notes, lat: null, lng: null, agreements: [] };
    for (const g of move.filter((g) => owner.get(g) === c)) for (const ad of c.addresses) { const k = ad.agreements.indexOf(g); if (k >= 0) { ad.agreements.splice(k, 1); na.agreements.push(g); } }
    c.addresses.push(na);
    plan.issues.push({ line: a.line, msg: `${c.name}: ${na.agreements.length} aftale(r) flyttet til ${a.row.street}`, warn: true });
  }
  // 6) resultat: plan-aftaler får routeRef; eksisterende får opdateringer; rækkefølge pr. (ejer, adresse)
  for (const [g, ref] of assign) if (!g.id) g.routeRef = ref;
  for (const a of apps) {
    const mine = famAgreements(a).filter((g) => assign.get(g) === a.ref);
    if (a.kind === 'plan') {
      const pick = mine.find((g) => a.cands.includes(g)) || mine[0];
      const c = pick ? owner.get(pick) : a.c;
      const idx = pick ? c.addresses.findIndex((x) => x.agreements.includes(pick)) : Math.max(0, c.addresses.findIndex((x) => normS(x.street).startsWith(normS(a.row.street))));
      if (!c.phone && a.row.phone) c.phone = a.row.phone.replace(/\s/g, '');
      if (!c.addresses[idx].access && a.row.notes) c.addresses[idx].access = a.row.notes;
      plan.routeOrder[a.ref].push({ pc: c, addrIdx: idx, nr: a.nr });
    } else {
      const byCust = new Map(); for (const g of mine) byCust.set(g.customerId, [...(byCust.get(g.customerId) || []), g]);
      if (!byCust.size) byCust.set(a.c.id, []);
      let first = true;
      for (const [cid, gs] of byCust) {
        const addrId = gs[0]?.addressId || (a.exAddr && a.exAddr.customerId === cid ? a.exAddr.id : db.addresses.find((x) => x.customerId === cid)?.id) || null;
        const knownStreet = db.addresses.some((x) => x.customerId === cid && normS(x.street).startsWith(normS(a.row.street)));
        const u = { customerId: cid, name: db.customers.find((c) => c.id === cid)?.name, ref: a.ref, nr: a.nr, agreementIds: gs.map((g) => g.id), addressId: addrId,
          newAddress: !knownStreet && gs.some((g) => normS(g.service).includes(normS(a.row.street))) ? { street: [a.row.street, a.row.zipCity].filter(Boolean).join(', '), access: a.row.notes } : null,
          anchors: gs.map((g) => ({ anchorDate: g.anchorDate, intervalWeeks: g.intervalWeeks })) };
        plan.routeUpdates.push(u); if (first) plan.routeOrder[a.ref].push({ update: u, nr: a.nr }); first = false;
      }
    }
  }
  for (const r of routes) {
    const emptyExisting = r.existing && !db.agreements.some((g) => g.routeId === r.existing.id);
    if (r.existing && !emptyExisting) continue;
    const ri = rInfo.get(r.ref);
    const info = { ref: r.ref, name: r.name, intervalWeeks: ri.intervalWeeks, anchorDate: ri.anchorDate, customers: r.rows, matched: r.matched };
    if (emptyExisting) (plan.resetRoutes ||= []).push(info); else plan.newRoutes.push(info);
  }
  plan.routeStats = stats;
  plan.errors = plan.issues.filter((i) => !i.warn).length;
  return plan;
}

/** Opret nye ruter og sæt routeId/ankerdato på aftaler. Kaldes lige før applyImportPlan. */
export function materializeRoutes(db, plan, { uid, today, employeeId, batchId }) {
  const ids = {};
  for (const nr of plan.newRoutes || []) {
    const r = { id: uid('r'), name: nr.name, employeeId, intervalWeeks: nr.intervalWeeks, anchorDate: nr.anchorDate || D.nextWorkday(today), importBatch: batchId, ...(nr.anchorDate ? {} : { anchorUnknown: true }) };
    db.routes.push(r); ids[nr.ref] = r.id;
  }
  for (const rr of plan.resetRoutes || []) { const r = db.routes.find((x) => x.id === rr.ref); if (!r) continue; r.intervalWeeks = rr.intervalWeeks; if (rr.anchorDate) { r.anchorDate = rr.anchorDate; delete r.anchorUnknown; } }
  const resolve = (ref) => (ref?.startsWith('new:') ? ids[ref] : ref) || null;
  for (const c of plan.customers) for (const g of c.addresses.flatMap((a) => a.agreements)) {
    if (g.routeRef !== undefined) g.routeId = resolve(g.routeRef);
    if (!g.anchorDate) { const r = db.routes.find((x) => x.id === g.routeId); g.anchorDate = (r && D.nextRouteDate(r, r.anchorDate > today ? r.anchorDate : today)) || today; }
  }
  return ids;
}

/** Efter import: sæt rutens faste rækkefølge ud fra Nr i ruteoversigten (kræver at applyImportPlan har sat _id). */
export function applyRouteOrder(db, plan, ids) {
  for (const [ref, es] of Object.entries(plan.routeOrder || {})) {
    const rid = ref.startsWith('new:') ? ids[ref] : ref; const r = db.routes.find((x) => x.id === rid); if (!r) continue;
    const order = [];
    for (const e of [...es].sort((a, b) => a.nr - b.nr)) {
      const aid = e.update ? e.update._addressId || e.update.addressId : e.pc?.addresses[e.addrIdx]?._id;
      if (aid && !order.includes(aid)) order.push(aid);
    }
    r.order = [...order, ...(r.order || []).filter((a) => !order.includes(a))];
  }
}

/** Sæt rute på eksisterende kunders aftaler (og deres planlagte besøg); flyt evt. aftaler til ny adresse. */
export function applyRouteUpdates(db, plan, ids, uid = (p) => p + Math.random().toString(36).slice(2, 10)) {
  let n = 0;
  for (const u of plan.routeUpdates || []) {
    const rid = u.ref.startsWith('new:') ? ids[u.ref] : u.ref; if (!rid) continue;
    let addrId = u.addressId;
    if (u.newAddress && u.agreementIds.length) {
      const ex = db.addresses.find((a) => a.customerId === u.customerId && normS(a.street).startsWith(normS(u.newAddress.street.split(',')[0])));
      if (ex) addrId = ex.id; else { const a = { id: uid('adr'), customerId: u.customerId, street: u.newAddress.street, access: u.newAddress.access || '', lat: null, lng: null }; db.addresses.push(a); addrId = a.id; }
    }
    u._addressId = addrId;
    for (const g of db.agreements.filter((x) => u.agreementIds.includes(x.id))) {
      if (g.routeId !== rid) { g.prevRouteId = g.routeId ?? null; g.routeId = rid; n++; }
      if (addrId && g.addressId !== addrId) g.addressId = addrId;
      for (const v of db.visits) if (v.agreementId === g.id && (v.status === 'planlagt' || v.status === 'udsat')) { v.routeId = rid; if (addrId) v.addressId = addrId; }
    }
  }
  return n;
}

/**
 * "Fakturér gennem anden konto" uden GDPR-zip: står faktureringsadressen i stamdata som en anden kundes
 * leveringsadresse (helst samme navn), er den kunde betaleren. Kaldes efter applyImportPlan (bruger _id).
 */
export function linkBillingFromStamdata(db, plan) {
  let n = 0;
  for (const pc of plan.customers) {
    const b = pc.extra?.billing; if (!b?.address || !pc._id) continue;
    const st = normS(String(b.address).split(',')[0]);
    const cands = plan.customers.filter((x) => x !== pc && x._id && normS(x.keyStreet || x.addresses[0].street.split(',')[0]) === st);
    const payer = cands.find((x) => normS(x.name) === normS(pc.name)) || (cands.length === 1 ? cands[0] : null);
    const c = db.customers.find((x) => x.id === pc._id);
    if (payer && c && !c.billTo) { c.billTo = payer._id; n++; }
  }
  return n;
}
