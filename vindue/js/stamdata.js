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
    const c = { line, extId: s.extId, name: s.name, phone, email: s.email, notes: '', paymentMethod: g && yes(g.cash_payment) ? 'kontant' : 'bank', dupeOf: dupe?.id || null,
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
