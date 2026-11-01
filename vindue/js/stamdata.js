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
      for (const it of its) { const center = it.x + (it.w || 0) / 2; let k = cols[0].key; for (const col of cols) if (col.x <= center + 2) k = col.key; row[k] = row[k] ? row[k] + ' ' + it.str : it.str; }
      if (!row.interval && !row.next && !row.price && c.agreements.length) c.agreements[c.agreements.length - 1].service += ' ' + (row.service || '');
      else c.agreements.push({ service: (row.service || 'Vinduesvask').trim(), interval: row.interval || '', next: row.next || '', price: row.price || '', dur: row.dur || '' });
    }
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
 * Tilføjer rute + rækkefølge fra ruteoversigter til en stamdata-plan (match på navn + adresse).
 * Kunder der kun findes i en ruteoversigt tilføjes uden kundenr. Nye ruter beskrives i plan.newRoutes
 * (rytme = mindste interval på ruten, dato = tidligste "næste gang" blandt rutens kunder).
 */
export function addRouteOverviews(plan, overviews, db, { today }) {
  plan.newRoutes = []; plan.routeOrder = {};
  const byKey = new Map(plan.customers.map((c) => [keyOf(c.name, c.keyStreet ?? c.addresses[0].street.split(',')[0]), c]));
  for (const ov of overviews) {
    const name = ov.routeName || ov.fileName.replace(/\.pdf$/i, '');
    const existing = db.routes.find((r) => r.name.toLowerCase() === name.toLowerCase());
    const ref = existing ? existing.id : `new:${name}`;
    plan.routeOrder[ref] = [];
    let matched = 0;
    for (const row of ov.rows) {
      let c = byKey.get(keyOf(row.name, row.street));
      if (!c) {
        c = { line: `${name} nr. ${row.nr}`, extId: null, name: row.name, phone: row.phone.replace(/\s/g, ''), email: '', notes: '', paymentMethod: 'bank', dupeOf: null, fromRoute: true,
          extra: { invoiceType: 'email', invoiceInterval: 'besoeg', paymentDays: 8, paymentTerms: 'Netto 8 dage', group: 'Privat kunder' },
          addresses: [{ street: [row.street, row.zipCity].filter(Boolean).join(', '), access: row.notes, lat: null, lng: null, agreements: row.agreements.map((a) => {
            const iv = parseInterval(a.interval); const pr = parsePrice(a.price); const du = parseDuration(a.dur);
            return { service: a.service, price: Number.isNaN(pr) || pr == null ? 0 : pr, intervalWeeks: Number.isNaN(iv) || iv == null ? 0 : iv, durationMin: du && !Number.isNaN(du) ? du : 15, anchorDate: null }; }) }] };
        const dupe = db.customers.find((x) => !x.deleted && keyOf(x.name, (db.addresses.find((a) => a.customerId === x.id)?.street || '').split(',')[0]) === keyOf(row.name, row.street));
        if (dupe) { c.dupeOf = dupe.id; plan.duplicates.push({ line: c.line, name: c.name, existing: dupe.name }); }
        plan.customers.push(c); byKey.set(keyOf(row.name, row.street), c);
        plan.issues.push({ line: c.line, msg: `${row.name}: ikke fundet i stamdata – oprettes uden kundenr.; første besøg = rutens næste dato`, warn: true });
      } else matched++;
      if (!c.phone && row.phone) c.phone = row.phone.replace(/\s/g, '');
      if (!c.addresses[0].access && row.notes) c.addresses[0].access = row.notes;
      c.routeRef = ref; c.routeNr = row.nr; plan.routeOrder[ref].push(c);
      for (const g of c.addresses[0].agreements) g.routeRef = g.intervalWeeks ? ref : null;
    }
    if (!existing) {
      const ags = plan.routeOrder[ref].flatMap((c) => c.addresses[0].agreements).filter((g) => g.intervalWeeks);
      const anchor = ags.map((g) => g.anchorDate).filter(Boolean).sort()[0] || null;
      plan.newRoutes.push({ ref, name, intervalWeeks: ags.length ? Math.min(...ags.map((g) => g.intervalWeeks)) : 4, anchorDate: anchor, customers: ov.rows.length, matched });
    }
  }
  plan.errors = plan.issues.filter((i) => !i.warn).length;
  return plan;
}

/** Opret nye ruter og sæt routeId/ankerdato på aftaler. Kaldes lige før applyImportPlan. */
export function materializeRoutes(db, plan, { uid, today, employeeId, batchId }) {
  const ids = {};
  for (const nr of plan.newRoutes || []) {
    const r = { id: uid('r'), name: nr.name, employeeId, intervalWeeks: nr.intervalWeeks, anchorDate: nr.anchorDate || D.nextWorkday(today), importBatch: batchId };
    db.routes.push(r); ids[nr.ref] = r.id;
  }
  const resolve = (ref) => (ref?.startsWith('new:') ? ids[ref] : ref) || null;
  for (const c of plan.customers) for (const g of c.addresses[0].agreements) {
    if (g.routeRef !== undefined) g.routeId = resolve(g.routeRef);
    if (!g.anchorDate) { const r = db.routes.find((x) => x.id === g.routeId); g.anchorDate = (r && D.nextRouteDate(r, r.anchorDate > today ? r.anchorDate : today)) || today; }
  }
  return ids;
}

/** Efter import: sæt rutens faste rækkefølge ud fra Nr i ruteoversigten. */
export function applyRouteOrder(db, plan, ids, batchId) {
  for (const [ref, cs] of Object.entries(plan.routeOrder || {})) {
    const rid = ref.startsWith('new:') ? ids[ref] : ref; const r = db.routes.find((x) => x.id === rid); if (!r) continue;
    const order = [];
    for (const pc of [...cs].sort((a, b) => a.routeNr - b.routeNr)) {
      const cust = db.customers.find((c) => c.importBatch === batchId && c.name === pc.name && (pc.extId ? c.customerNo === pc.extId : true));
      const ad = cust && db.addresses.find((a) => a.customerId === cust.id);
      if (ad) order.push(ad.id);
    }
    r.order = [...order, ...(r.order || []).filter((a) => !order.includes(a))];
  }
}
