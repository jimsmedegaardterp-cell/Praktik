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
        group: g?.customer_group_id != null ? `Gruppe ${g.customer_group_id}` : 'Privat kunder', blocked: !!g?.timestamp_blocked,
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
    for (const it of its) { const center = it.x + (it.w || 0) / 2; let k = cols[0].key; for (const c of cols) if (c.x <= center + 2) k = c.key; cell[k] = cell[k] ? cell[k] + ' ' + it.str : it.str; }
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
  const findExisting = (row) => {
    const n = normS(row.name), st = normS(row.street); if (!st) return null;
    for (const c of db.customers) { if (c.deleted || normS(c.name) !== n) continue;
      const a = db.addresses.find((x) => x.customerId === c.id && normS(x.street).startsWith(st)); if (a) return { c, a }; }
    const zip = zipOf(row);
    const hits = db.addresses.filter((x) => normS(x.street).startsWith(st) && (!zip || x.street.includes(zip)) && !db.customers.find((c) => c.id === x.customerId)?.deleted);
    if (hits.length === 1) return { c: db.customers.find((c) => c.id === hits[0].customerId), a: hits[0], byAddress: true };
    const byName = db.customers.filter((c) => !c.deleted && normS(c.name) === n);
    if (byName.length === 1) return { c: byName[0], a: null }; // samme kunde, anden adresse
    return null;
  };
  const byKey = new Map(plan.customers.map((c) => [keyOf(c.name, c.keyStreet ?? c.addresses[0].street.split(',')[0]), c]));
  const byName = new Map(); for (const c of plan.customers) { const k = normS(c.name); byName.set(k, byName.has(k) ? null : c); }
  const usedPlan = new Map(); // plan-kunde → Set af brugte aftaler
  const exState = new Map(); // eksisterende kunde-id → { used:Set, refs:Set }
  const pcRefs = new Map();  // plan-kunde → Set af rute-refs
  const stats = { rows: 0, matched: 0 };

  for (const ov of overviews) {
    const name = ov.routeName || ov.fileName.replace(/\.pdf$/i, '');
    const existing = db.routes.find((r) => r.name.toLowerCase() === name.toLowerCase());
    const ref = existing ? existing.id : `new:${name}`;
    plan.routeOrder[ref] = []; let matched = 0;
    for (const row of ov.rows) {
      stats.rows++; const line = `${name} nr. ${row.nr}`; const rAgs = rowAgreements(row);
      let c = byKey.get(keyOf(row.name, row.street)); let addrIdx = 0;
      if (!c) { const cn = byName.get(normS(row.name)); if (cn) { c = cn; addrIdx = -1; } }
      if (c) {
        matched++; stats.matched++;
        const used = usedPlan.get(c) || new Set(); usedPlan.set(c, used);
        if (addrIdx === -1) addrIdx = c.addresses.findIndex((a) => normS(a.street).startsWith(normS(row.street)));
        const all = c.addresses.flatMap((a) => a.agreements);
        const hit = matchAgreements(all.filter((g) => g.intervalWeeks || rAgs.some((r) => !r.intervalWeeks)), rAgs, used);
        if (addrIdx === -1) { // rækken har en anden adresse end kunden i stamdata → flyt de matchede aftaler dertil
          const na = { street: [row.street, row.zipCity].filter(Boolean).join(', '), access: row.notes, lat: null, lng: null, agreements: [] };
          for (const g of hit) for (const a of c.addresses) { const k = a.agreements.indexOf(g); if (k >= 0) { a.agreements.splice(k, 1); na.agreements.push(g); } }
          c.addresses.push(na); addrIdx = c.addresses.length - 1;
          plan.issues.push({ line, msg: `${c.name}: ${hit.length} aftale(r) flyttet til ${row.street}`, warn: true });
        }
        if (!hit.length && rAgs.length) plan.issues.push({ line, msg: `${c.name}: rutens aftale "${rAgs[0].service}" (${rAgs[0].price} kr) blev ikke genkendt blandt kundens aftaler`, warn: true });
        for (const g of hit) if (g.intervalWeeks) g.routeRef = ref;
        if (!c.phone && row.phone) c.phone = row.phone.replace(/\s/g, '');
        if (!c.addresses[addrIdx].access && row.notes) c.addresses[addrIdx].access = row.notes;
        (pcRefs.get(c) || pcRefs.set(c, new Set()).get(c)).add(ref);
        plan.routeOrder[ref].push({ pc: c, addrIdx, nr: row.nr });
        continue;
      }
      const ex = findExisting(row);
      if (ex) {
        matched++; stats.matched++;
        if (ex.byAddress) plan.issues.push({ line, msg: `"${row.name}" koblet til "${ex.c.name}" på adressen`, warn: true });
        const st = exState.get(ex.c.id) || { used: new Set(), refs: new Set() }; exState.set(ex.c.id, st); st.refs.add(ref);
        const cands = db.agreements.filter((g) => g.customerId === ex.c.id && g.active !== false);
        const hit = matchAgreements(cands, rAgs, st.used);
        const u = { customerId: ex.c.id, name: ex.c.name, ref, nr: row.nr, agreementIds: hit.filter((g) => g.intervalWeeks).map((g) => g.id), addressId: ex.a?.id || null,
          newAddress: ex.a ? null : { street: [row.street, row.zipCity].filter(Boolean).join(', '), access: row.notes },
          anchors: hit.filter((g) => g.intervalWeeks).map((g) => ({ anchorDate: g.anchorDate, intervalWeeks: g.intervalWeeks })) };
        if (!hit.length && rAgs.length) plan.issues.push({ line, msg: `${ex.c.name}: rutens aftale "${rAgs[0].service}" blev ikke genkendt`, warn: true });
        plan.routeUpdates.push(u); plan.routeOrder[ref].push({ update: u, nr: row.nr });
        continue;
      }
      // kun i ruteoversigten → ny kunde
      c = { line, extId: null, name: row.name, phone: row.phone.replace(/\s/g, ''), email: '', notes: '', paymentMethod: 'bank', dupeOf: null, fromRoute: true,
        extra: { invoiceType: 'email', invoiceInterval: 'besoeg', paymentDays: 8, paymentTerms: 'Netto 8 dage', group: 'Privat kunder' },
        addresses: [{ street: [row.street, row.zipCity].filter(Boolean).join(', '), access: row.notes, lat: null, lng: null, agreements: rAgs.map((g) => ({ ...g, anchorDate: null, routeRef: g.intervalWeeks ? ref : null })) }] };
      plan.customers.push(c); byKey.set(keyOf(row.name, row.street), c); pcRefs.set(c, new Set([ref]));
      plan.routeOrder[ref].push({ pc: c, addrIdx: 0, nr: row.nr });
      plan.issues.push({ line, msg: `${row.name}: ikke fundet i stamdata – oprettes uden kundenr.; første besøg = rutens næste dato`, warn: true });
    }
    // rutens rytme og dato
    const emptyExisting = existing && !db.agreements.some((g) => g.routeId === existing.id);
    if (!existing || emptyExisting) {
      const ags = [...plan.customers.flatMap((c) => c.addresses.flatMap((a) => a.agreements)).filter((g) => g.routeRef === ref), ...plan.routeUpdates.filter((u) => u.ref === ref).flatMap((u) => u.anchors)].filter((g) => g.intervalWeeks);
      const anchor = ags.map((g) => g.anchorDate).filter(Boolean).sort()[0] || null;
      const info = { ref, name, intervalWeeks: ags.length ? Math.min(...ags.map((g) => g.intervalWeeks)) : 4, anchorDate: anchor, customers: ov.rows.length, matched };
      if (emptyExisting) (plan.resetRoutes ||= []).push(info); else plan.newRoutes.push(info);
    }
  }
  // Faste aftaler uden rute: står kunden kun på én rute, hører de til den
  for (const [c, refs] of pcRefs) for (const g of c.addresses.flatMap((a) => a.agreements)) {
    if (!g.intervalWeeks || g.routeRef !== undefined) continue;
    if (refs.size === 1) g.routeRef = [...refs][0];
    else plan.issues.push({ line: c.line, msg: `${c.name}: aftalen "${g.service}" står ikke på nogen af kundens ruter – tildel rute manuelt`, warn: true });
  }
  for (const [cid, st] of exState) {
    if (st.refs.size !== 1) continue;
    const u = plan.routeUpdates.find((x) => x.customerId === cid);
    for (const g of db.agreements.filter((x) => x.customerId === cid && x.intervalWeeks && !st.used.has(x))) if (!u.agreementIds.includes(g.id)) u.agreementIds.push(g.id);
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
