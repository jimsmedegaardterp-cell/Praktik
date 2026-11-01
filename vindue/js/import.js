// Import fra SkvizBiz (eller andet) via CSV/Excel-eksport.
// Flow: parse → gæt kolonner → forhåndsvisning med problemer/dubletter → anvend (batch) → evt. fortryd.
// Kolonnenavne i SkvizBiz' eksport er ukendte (SKAL VERIFICERES) – derfor manuel kolonnetilknytning.
import * as D from './domain.js';

export const FIELDS = {
  extId: 'Kundenr. (SkvizBiz)', name: 'Navn *', phone: 'Telefon/mobil', email: 'E-mail',
  street: 'Adresse *', zip: 'Postnr.', city: 'By', service: 'Ydelse', price: 'Pris', intervalWeeks: 'Interval (uger)',
  nextDate: 'Næste besøg', durationMin: 'Tid pr. besøg', route: 'Rute', access: 'Adgang/nøgle', notes: 'Bemærkning', paymentMethod: 'Betalingsform',
};
const GUESS = {
  extId: /kunde.?n|kundenummer|^id$|^nr\.?$/i, name: /^navn|kundenavn|^name/i, phone: /tlf|telefon|mobil|phone/i, email: /mail/i,
  street: /adresse|vej|gade|street|address/i, zip: /post.?n|zip/i, city: /^by$|city|bynavn/i, service: /ydelse|opgave|service|produkt/i,
  price: /pris|beløb|price|amount/i, intervalWeeks: /interval|frekvens|hver/i, nextDate: /næste|next|dato|date/i,
  route: /rute|route|område/i, durationMin: /^tid$|varighed|minutter|tidsforbrug/i, access: /adgang|nøgle|kode/i, notes: /bemærk|note|kommentar/i, paymentMethod: /betaling|payment/i,
};

/** CSV-parser: håndterer ; , eller tab, citationstegn og linjeskift i felter. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim()));
  const [headers = [], ...data] = nonEmpty;
  return { headers: headers.map((h) => h.trim()), rows: data };
}

export function guessMapping(headers) {
  const m = {}; const used = new Set();
  for (const f of Object.keys(FIELDS)) {
    const i = headers.findIndex((h, j) => !used.has(j) && GUESS[f].test(h));
    if (i >= 0) { m[f] = i; used.add(i); }
  }
  return m;
}

export function parsePrice(s) {
  if (s == null || String(s).trim() === '') return null;
  let t = String(s).replace(/kr\.?|dkk|\s/gi, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, '');
  const n = Number(t); return Number.isFinite(n) ? n : NaN;
}
export function parseDate(s) {
  if (!s) return null; s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/); if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if (/^\d{5}$/.test(s)) return D.addDays('1899-12-30', +s); // Excel-serienummer
  return NaN;
}
const iso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : NaN);
export function parseInterval(s) {
  if (s == null || String(s).trim() === '') return null; s = String(s).toLowerCase();
  if (/ikke fast|efter aftale|ring|tilkald/.test(s)) return 0;
  if (/måned|mdr/.test(s)) { const n = Number((s.match(/\d+/) || [1])[0]); return n * 4; } // tilnærmet: 1 md ≈ 4 uger (markeres)
  const n = Number((s.match(/\d+/) || [])[0]); return Number.isFinite(n) && n > 0 ? n : NaN;
}
export function parseDuration(s) {
  if (s == null || String(s).trim() === '') return null; s = String(s).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})/); if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+)\s*(min|m)?$/i); if (m) return +m[1];
  return NaN;
}
export function parsePaymentMethod(s) {
  s = String(s || '').toLowerCase();
  if (/mobile/.test(s)) return 'mobilepay'; if (/pbs|betalingsservice|bs\b/.test(s)) return 'betalingsservice';
  if (/kontant|cash/.test(s)) return 'kontant'; if (s) return 'bank'; return null;
}

/**
 * Lav en importplan uden at ændre db. Rækker med samme kundenr. (eller samme navn+telefon) samles til én kunde
 * med flere adresser/aftaler. Eksisterende kunder (samme SkvizBiz-nr. eller telefon) markeres som dubletter.
 */
export function buildImportPlan(parsed, mapping, db, { defaultRouteId, today }) {
  const get = (r, f) => (mapping[f] != null ? String(r[mapping[f]] ?? '').trim() : '');
  const plan = { customers: [], issues: [], duplicates: [], skipped: 0 };
  const byKey = new Map();
  parsed.rows.forEach((r, idx) => {
    const line = idx + 2; const name = get(r, 'name'); const streetRaw = get(r, 'street');
    if (!name && !streetRaw) { plan.skipped++; return; }
    if (!name) plan.issues.push({ line, msg: 'Mangler navn' });
    if (!streetRaw) plan.issues.push({ line, msg: 'Mangler adresse' });
    const phoneRaw = get(r, 'phone'); const phone = D.normalizePhone(phoneRaw);
    if (phoneRaw && !phone) plan.issues.push({ line, msg: `Ugyldigt telefonnr. "${phoneRaw}"` });
    const extId = get(r, 'extId');
    const key = extId ? 'x:' + extId : 'n:' + name.toLowerCase() + '|' + (phone || '');
    const dupe = db.customers.find((c) => !c.deleted && ((extId && c.skvizbizId === extId) || (phone && D.normalizePhone(c.phone) === phone)));
    let c = byKey.get(key);
    if (!c) {
      c = { line, extId, name, phone: phoneRaw, email: get(r, 'email'), notes: get(r, 'notes'), paymentMethod: parsePaymentMethod(get(r, 'paymentMethod')) || 'bank', addresses: [], dupeOf: dupe?.id || null };
      byKey.set(key, c); plan.customers.push(c);
      if (dupe) plan.duplicates.push({ line, name, existing: dupe.name });
    }
    const zip = get(r, 'zip'), city = get(r, 'city');
    const street = [streetRaw, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const price = parsePrice(get(r, 'price')); if (Number.isNaN(price)) plan.issues.push({ line, msg: `Ukendt pris "${get(r, 'price')}"` });
    const intRaw = get(r, 'intervalWeeks'); const interval = parseInterval(intRaw) ?? 0;
    if (!intRaw) plan.issues.push({ line, msg: 'Intet interval – oprettes som "Ikke fast"', warn: true });
    if (Number.isNaN(interval)) plan.issues.push({ line, msg: `Ukendt interval "${intRaw}"` });
    else if (/måned|mdr/i.test(intRaw)) plan.issues.push({ line, msg: `"${intRaw}" omregnet til ${interval} uger – kontrollér`, warn: true });
    const next = parseDate(get(r, 'nextDate')); if (Number.isNaN(next)) plan.issues.push({ line, msg: `Ukendt dato "${get(r, 'nextDate')}"` });
    const routeName = get(r, 'route'); const rn = routeName.toLowerCase();
    const route = routeName ? (db.routes.find((x) => x.name.toLowerCase() === rn) || db.routes.find((x) => x.name.toLowerCase().split(' – ')[0] === rn)) : null;
    if (routeName && !route) plan.issues.push({ line, msg: `Rute "${routeName}" findes ikke – bruger standardrute`, warn: true });
    const ad = c.addresses.find((a) => a.street.toLowerCase() === street.toLowerCase()) || (() => { const a = { street, access: get(r, 'access'), agreements: [] }; c.addresses.push(a); return a; })();
    const dur = parseDuration(get(r, 'durationMin')); if (Number.isNaN(dur)) plan.issues.push({ line, msg: `Ukendt tid "${get(r, 'durationMin')}"`, warn: true });
    if (interval != null && !Number.isNaN(interval)) {
      const rt = route || db.routes.find((x) => x.id === defaultRouteId);
      ad.agreements.push({ service: get(r, 'service') || 'Vinduespudsning', price: Number.isNaN(price) ? 0 : price ?? 0, intervalWeeks: interval, durationMin: dur && !Number.isNaN(dur) ? dur : 15,
        anchorDate: next && !Number.isNaN(next) ? next : (D.nextRouteDate(rt, today) || today), routeId: interval ? rt?.id || null : route?.id || null, line });
      if (interval && rt && next && !Number.isNaN(next) && !D.agreementFitsRoute({ anchorDate: next, intervalWeeks: interval }, rt)) plan.issues.push({ line, msg: `Næste besøg/interval passer ikke med ruten "${rt.name}"`, warn: true });
    }
  });
  plan.errors = plan.issues.filter((i) => !i.warn).length;
  return plan;
}

/** Anvend plan. Dubletter springes over medmindre includeDuplicates. Alt mærkes med batchId → kan fortrydes. */
export function applyImportPlan(db, plan, { batchId, uid, includeDuplicates = false, horizon, today }) {
  const counts = { customers: 0, addresses: 0, agreements: 0, visits: 0 };
  for (const pc of plan.customers) {
    if (pc.dupeOf && !includeDuplicates) continue;
    if (!pc.name) continue;
    const c = { id: uid('c'), name: pc.name, phone: pc.phone, email: pc.email, notes: pc.notes, paymentTerms: 'Netto 8 dage', paymentMethod: pc.paymentMethod,
      vatLiable: true, marketingConsent: false, skvizbizId: pc.extId || null, ...(pc.extra || {}), importBatch: batchId };
    db.customers.push(c); counts.customers++;
    for (const pa of pc.addresses) {
      const a = { id: uid('adr'), customerId: c.id, street: pa.street, access: pa.access, lat: pa.lat ?? null, lng: pa.lng ?? null, importBatch: batchId };
      db.addresses.push(a); counts.addresses++;
      for (const g of pa.agreements) {
        const ag = { id: uid('ag'), customerId: c.id, addressId: a.id, routeId: g.routeId, service: g.service, price: g.price, intervalWeeks: g.intervalWeeks, durationMin: g.durationMin,
          anchorDate: g.anchorDate, seasonMonths: [], active: true, importBatch: batchId };
        db.agreements.push(ag); counts.agreements++;
        const vs = D.generateVisits(ag, today && today > g.anchorDate ? today : g.anchorDate, horizon, [], db.closedDays); vs.forEach((v) => (v.importBatch = batchId));
        db.visits.push(...vs); counts.visits += vs.length;
      }
    }
  }
  (db.imports ||= []).push({ batchId, at: new Date().toISOString(), counts });
  return counts;
}

/** Fortryd import: kun muligt hvis ingen besøg fra batchen er registreret/faktureret. */
export function rollbackImport(db, batchId) {
  const touched = db.visits.filter((v) => v.importBatch === batchId && v.status !== 'planlagt');
  if (touched.length) throw new Error(`${touched.length} besøg fra importen er allerede registreret – kan ikke fortrydes automatisk`);
  const cids = new Set(db.customers.filter((c) => c.importBatch === batchId).map((c) => c.id));
  if (db.smsMessages.some((m) => cids.has(m.customerId)) || db.invoiceLinks.some((l) => cids.has(l.customerId)))
    throw new Error('Der er SMS/fakturaer på importerede kunder – kan ikke fortrydes automatisk');
  db.visits = db.visits.filter((v) => v.importBatch !== batchId);
  db.agreements = db.agreements.filter((a) => a.importBatch !== batchId);
  db.addresses = db.addresses.filter((a) => a.importBatch !== batchId);
  db.customers = db.customers.filter((c) => c.importBatch !== batchId);
  const b = db.imports.find((x) => x.batchId === batchId); if (b) b.rolledBack = new Date().toISOString();
}

/* ---------------- PDF-import ----------------
 * SkvizBiz kan kun eksportere kundekartoteket som PDF. pdf.js giver tekststykker med position;
 * her samles de til rækker (y) og kolonner (x ud fra overskriftsrækken). Kører i browseren – intet sendes ud.
 * items: [{ str, x, y, w, page }]  (y = PDF-koordinat, stiger opad)
 */
const HEADER_WORDS = /kunde.?n|navn|adresse|post.?n|interval|mobil|telefon|tlf|e-?mail|rute|pris|næste/i;
export function pdfItemsToTable(items, { yTol = 2.5, gap = 4 } = {}) {
  const clean = items.filter((i) => i.str && i.str.trim());
  // 1) linjer pr. side
  const lines = [];
  for (const it of [...clean].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const l = lines.find((L) => L.page === it.page && Math.abs(L.y - it.y) <= yTol);
    if (l) l.items.push(it); else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  // 2) slå tætliggende stykker sammen til celler
  const cellsOf = (l) => {
    const its = [...l.items].sort((a, b) => a.x - b.x); const cells = [];
    for (const it of its) {
      const c = cells[cells.length - 1];
      if (c && it.x - c.end < gap) { c.str += (it.x - c.end > 0.8 ? ' ' : '') + it.str; c.end = it.x + (it.w || it.str.length * 4); }
      else cells.push({ x: it.x, end: it.x + (it.w || it.str.length * 4), str: it.str });
    }
    return cells.map((c) => ({ ...c, str: c.str.replace(/\s+/g, ' ').trim() })).filter((c) => c.str);
  };
  // 3) find overskrift
  const hi = lines.findIndex((l) => cellsOf(l).filter((c) => HEADER_WORDS.test(c.str)).length >= 3);
  if (hi < 0) throw new Error('Kunne ikke finde en overskriftsrække (fx "Kundenr. / Navn / Adresse") i PDF\'en');
  const head = cellsOf(lines[hi]); const headers = head.map((c) => c.str); const headerKey = headers.join('|');
  const colOf = (x) => { let k = 0; for (let i = 0; i < head.length; i++) if (head[i].x <= x + 3) k = i; return k; };
  // 4) rækker
  const rows = []; const firstIsId = /kunde.?n|^nr/i.test(headers[0]);
  // gentagne overskrifter: alt over overskriften på en side (titel, dato) springes over
  const headY = new Map(); lines.forEach((l) => { if (cellsOf(l).map((c) => c.str).join('|') === headerKey && !headY.has(l.page)) headY.set(l.page, l.y); });
  for (const l of lines.slice(hi + 1)) {
    if (headY.has(l.page) && l.y >= headY.get(l.page) - 0.5) continue;
    const cells = cellsOf(l);
    if (cells.length === 1 && /^(side|page)?\s*\d+(\s*(af|\/|of)\s*\d+)?$/i.test(cells[0].str)) continue; // sidetal
    const row = Array(headers.length).fill('');
    for (const c of cells) { const k = colOf(c.x); row[k] = row[k] ? row[k] + ' ' + c.str : c.str; }
    const startsNew = firstIsId ? /\d/.test(row[0]) : row[0] !== '';
    if (!startsNew && rows.length) { const prev = rows[rows.length - 1]; row.forEach((v, k) => { if (v) prev[k] = prev[k] ? prev[k] + ' ' + v : v; }); }
    else if (row.some(Boolean)) rows.push(row);
  }
  return { headers, rows };
}
