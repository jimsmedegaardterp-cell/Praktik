// Import af SkvizBiz' GDPR-udtræk: en zip med én mappe pr. kunde ("Kunde 00000002/data.json" + PDF'er).
// Alt foregår i browseren. Kun data.json læses; fakturaer/kontoudtog ignoreres (de ligger i e-conomic/arkivet).
// Feltnavne er set i ét udtræk (1/11-2026). Aftale-felter er gættet bredt – SKAL VERIFICERES med flere kunder.
import * as D from './domain.js';
import { parsePrice, parseDate, parseInterval, parseDuration } from './import.js';

/* ---------------- Minimal zip-læser (ingen afhængigheder) ---------------- */
export async function unzip(buf, wanted = () => true) {
  const u8 = new Uint8Array(buf); const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Filen er ikke en gyldig zip');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Zip-indholdsfortegnelsen er beskadiget');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nl);
    const name = flags & 0x800 ? new TextDecoder('utf-8').decode(nameBytes) : decodeCp437(nameBytes);
    p += 46 + nl + el + cl;
    if (name.endsWith('/') || !wanted(name)) continue;
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
    const data = u8.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    if (flags & 1) throw new Error('Zip-filen er krypteret – udpak den først og vælg mappen i stedet');
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error(`Ukendt komprimering (${method}) – udpak zip-filen først og vælg mappen i stedet`);
    out.push({ name, bytes });
  }
  return out;
}
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const decodeCp437 = (b) => Array.from(b, (c) => (c < 128 ? String.fromCharCode(c) : CP437[c - 128])).join('');

/* ---------------- Felter ---------------- */
const IGNORE = /password|passwd|hash|token|secret|^cache_|portal/; // følsomt eller uinteressant – læses aldrig
export const normKey = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9æøå]+/g, '_').replace(/^_|_$/g, '');
export function normalize(o) {
  if (Array.isArray(o)) return o.map(normalize);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) { const nk = normKey(k); if (!IGNORE.test(nk)) r[nk] = normalize(v); } return r; }
  return o;
}
const pick = (o, ...keys) => { for (const k of keys) { const v = o[k]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
const yes = (v) => v === true || v === 1 || /^(yes|ja|true|1)$/i.test(String(v ?? ''));
const tsToIso = (v) => { if (v == null || v === '') return null; if (typeof v === 'number' || /^\d{9,11}$/.test(String(v))) return new Date(Number(v) * 1000).toISOString().slice(0, 10); const d = parseDate(v); return Number.isNaN(d) ? null : d; };
const INVOICE_MEDIA = { ean: 'ean', email: 'email', mail: 'email', pdf: 'email', sms: 'sms', print: 'print', post: 'print', paper: 'print' };
export const USED_KEYS = new Set(['id', 'number', 'name', 'address', 'address_2', 'zipcode', 'city', 'lat', 'lon', 'email_address', 'email', 'ean_number', 'invoice_media', 'call_first', 'sms_first', 'sms_after', 'sms_invoice',
  'cash_payment', 'payment_1', 'payment_2', 'billing_frequency_1', 'billing_frequency_2', 'customer_group_id', 'deleted', 'timestamp_blocked', 'timestamp_created', 'cvr', 'cvr_number', 'vat_number', 'contact', 'contact_person',
  'mobile', 'mobile_number', 'mobilnr', 'cellphone', 'phone', 'phone_number', 'telephone', 'landline', 'billing_address', 'billing_address_2', 'billing_city', 'billing_zipcode', 'billing_name', 'billing_contact', 'note', 'notes', 'comment', 'internal_note', 'remember', 'remember_always', 'remember_next']);

/** Find aftaler: alle arrays af objekter med noget der ligner interval/pris/næste gang. */
function findAgreements(o, path = '') {
  const out = [];
  if (Array.isArray(o)) { if (o.some((x) => x && typeof x === 'object' && Object.keys(x).some((k) => /interval|price|pris|next|naeste|næste|route|rute/.test(k)))) return o.map((x) => ({ path, obj: x })); o.forEach((x, i) => out.push(...findAgreements(x, `${path}[${i}]`))); }
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'object') out.push(...findAgreements(v, path ? `${path}.${k}` : k));
  return out;
}
function toAgreement(a, routes, today) {
  const service = pick(a, 'description', 'name', 'title', 'task', 'beskrivelse', 'text') || 'Vinduesvask';
  const priceRaw = pick(a, 'price', 'price_ex_vat', 'price_excl_vat', 'amount', 'pris', 'total');
  const price = typeof priceRaw === 'number' ? priceRaw : parsePrice(priceRaw) ?? 0;
  let interval = pick(a, 'interval', 'interval_weeks', 'frequency', 'interval_1');
  const unit = String(pick(a, 'interval_unit', 'interval_2', 'unit', 'interval_type') || 'week').toLowerCase();
  interval = interval == null ? 0 : typeof interval === 'number' ? interval : parseInterval(interval) || 0;
  if (/month|måned|maaned/.test(unit)) interval *= 4; // tilnærmet
  const next = tsToIso(pick(a, 'next', 'nexttime', 'next_time', 'next_date', 'næste_gang', 'naeste_gang', 'timestamp_next'));
  const dur = pick(a, 'duration', 'time', 'minutes', 'tidsforbrug', 'time_usage');
  const durationMin = typeof dur === 'number' ? (dur > 600 ? Math.round(dur / 60) : dur) : parseDuration(dur) || 15;
  const routeRaw = pick(a, 'route_name', 'route', 'rute', 'route_id');
  const route = routeRaw == null ? null : routes.find((r) => r.name.toLowerCase() === String(routeRaw).toLowerCase() || r.skvizId === String(routeRaw)) || null;
  return { service: String(service), price: Number.isFinite(price) ? price : 0, intervalWeeks: Number.isFinite(interval) ? interval : 0, durationMin: Number.isFinite(durationMin) ? durationMin : 15,
    anchorDate: next || today, routeId: route?.id || null, routeRaw: routeRaw == null ? null : String(routeRaw), deleted: yes(pick(a, 'deleted')) };
}

/** Byg importplan (samme format som CSV/PDF-importen) ud fra GDPR-filer [{name, json}]. */
export function buildGdprPlan(files, db, { today }) {
  const plan = { customers: [], issues: [], duplicates: [], skipped: 0, unknownKeys: new Map(), agreementPaths: new Set(), source: 'gdpr', unmatchedRoutes: new Map() };
  files.forEach(({ name, json }, idx) => {
    const line = name; let o;
    try { o = normalize(typeof json === 'string' ? JSON.parse(json) : json); } catch { plan.issues.push({ line, msg: 'Kunne ikke læse JSON' }); return; }
    if (o.customer && typeof o.customer === 'object') o = { ...o, ...o.customer };
    if (yes(o.deleted)) { plan.skipped++; return; }
    for (const [k, v] of Object.entries(o)) if (!USED_KEYS.has(k) && (v === null || typeof v !== 'object')) plan.unknownKeys.set(k, (plan.unknownKeys.get(k) || 0) + 1);
    const no = pick(o, 'number'); const extId = no == null ? null : String(no).padStart(8, '0');
    const nameV = pick(o, 'name'); if (!nameV) plan.issues.push({ line, msg: 'Mangler navn' });
    const phone = pick(o, 'mobile', 'mobile_number', 'mobilnr', 'cellphone', 'phone', 'phone_number', 'telephone');
    const zipcity = [pick(o, 'zipcode'), pick(o, 'city')].filter(Boolean).join(' ');
    const street = [pick(o, 'address'), pick(o, 'address_2'), zipcity].filter(Boolean).join(', ');
    if (!pick(o, 'address')) plan.issues.push({ line, msg: 'Mangler adresse', warn: true });
    const media = INVOICE_MEDIA[String(pick(o, 'invoice_media') || '').toLowerCase()] || (yes(o.sms_invoice) ? 'sms' : 'email');
    const freq = String(pick(o, 'billing_frequency_2') || 'visit').toLowerCase();
    const dupe = db.customers.find((c) => !c.deleted && ((extId && (c.customerNo === extId || c.skvizbizId === extId)) || (phone && D.normalizePhone(c.phone) && D.normalizePhone(c.phone) === D.normalizePhone(phone))));
    const ags = findAgreements(o).map(({ path, obj }) => { plan.agreementPaths.add(path.replace(/\[\d+\]/g, '[]')); return toAgreement(obj, db.routes, today); }).filter((a) => !a.deleted);
    for (const a of ags) if (a.routeRaw && !a.routeId) plan.unmatchedRoutes.set(a.routeRaw, (plan.unmatchedRoutes.get(a.routeRaw) || 0) + 1);
    const lat = Number(pick(o, 'lat')), lng = Number(pick(o, 'lon', 'lng'));
    const c = { line, extId, name: nameV || '', phone: phone ? String(phone) : '', email: pick(o, 'email_address', 'email') || '', notes: pick(o, 'internal_note', 'note', 'notes', 'comment') || '',
      paymentMethod: yes(o.cash_payment) ? 'kontant' : 'bank', dupeOf: dupe?.id || null,
      extra: { customerNo: extId, skvizbizId: extId, skvizId: pick(o, 'id'), billingSkvizId: pick(o, 'billing_id'), group: `Gruppe ${pick(o, 'customer_group_id') ?? '?'}`, ean: pick(o, 'ean_number'), invoiceType: media,
        invoiceInterval: /month|maaned|måned/.test(freq) ? 'maaned' : 'besoeg', paymentDays: Number(pick(o, 'payment_2')) || 8, paymentTerms: `Netto ${Number(pick(o, 'payment_2')) || 8} dage`,
        callBefore: yes(o.call_first), smsBefore: yes(o.sms_first), smsAfter: yes(o.sms_after), cvr: pick(o, 'cvr', 'cvr_number', 'vat_number') || '', contact: pick(o, 'contact', 'contact_person') || '',
        blocked: !!pick(o, 'timestamp_blocked'), createdAt: tsToIso(pick(o, 'timestamp_created')), rememberNext: pick(o, 'remember_next') || '',
        billing: pick(o, 'billing_address') ? { name: pick(o, 'billing_name'), address: pick(o, 'billing_address'), zip: pick(o, 'billing_zipcode'), city: pick(o, 'billing_city') } : null },
      addresses: [{ street, access: pick(o, 'remember_always', 'remember') || '', lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, agreements: ags }] };
    if (c.extra.blocked) plan.issues.push({ line, msg: `${c.name} er spærret i SkvizBiz`, warn: true });
    if (!ags.length) plan.issues.push({ line, msg: `${c.name || 'Kunde'}: ingen aftaler fundet i data.json`, warn: true });
    plan.customers.push(c); if (dupe) plan.duplicates.push({ line, name: c.name, existing: dupe.name });
  });
  plan.errors = plan.issues.filter((i) => !i.warn).length;
  return plan;
}

/**
 * Opdatering af kunder, der allerede er i appen (match på kundenr.). Kun felter fra GDPR-udtrækket,
 * som stamdata/ruteoversigt ikke har; navn, adresse, aftaler og ruter røres ikke.
 * Tomme felter i appen udfyldes (tlf., e-mail, koordinater); flag (SMS før/efter, ring før, fakturatype, EAN, kontant) sættes fra SkvizBiz.
 */
export function gdprUpdates(plan, db) {
  const byNo = new Map(db.customers.filter((c) => !c.deleted).map((c) => [String(c.customerNo || c.skvizbizId || ''), c]));
  const ups = [];
  for (const pc of plan.customers) {
    const c = pc.extId && byNo.get(pc.extId); if (!c) continue;
    const set = {}; const x = pc.extra;
    const want = { billingSkvizId: x.billingSkvizId ?? undefined, invoiceType: x.invoiceType, invoiceInterval: x.invoiceInterval, smsBefore: x.smsBefore, smsAfter: x.smsAfter, callBefore: x.callBefore, paymentDays: x.paymentDays, paymentTerms: x.paymentTerms, blocked: x.blocked, skvizId: x.skvizId };
    if (x.ean) want.ean = x.ean; if (x.cvr) want.cvr = x.cvr; if (x.createdAt) want.createdAt = x.createdAt;
    if (pc.paymentMethod === 'kontant') want.paymentMethod = 'kontant';
    if (!c.phone && pc.phone) want.phone = pc.phone; if (!c.email && pc.email) want.email = pc.email;
    for (const [k, v] of Object.entries(want)) if (v !== undefined && v !== null && c[k] !== v) set[k] = v;
    const ad = db.addresses.find((a) => a.customerId === c.id);
    const geo = ad && ad.lat == null && pc.addresses[0].lat != null ? { addressId: ad.id, lat: pc.addresses[0].lat, lng: pc.addresses[0].lng } : null;
    if (Object.keys(set).length || geo) ups.push({ customerId: c.id, name: c.name, set, geo });
  }
  return ups;
}
export function applyGdprUpdates(db, ups) {
  for (const u of ups) {
    const c = db.customers.find((x) => x.id === u.customerId); if (!c) continue;
    Object.assign(c, u.set);
    if (u.geo) { const a = db.addresses.find((x) => x.id === u.geo.addressId); if (a) Object.assign(a, { lat: u.geo.lat, lng: u.geo.lng }); }
  }
  return ups.length;
}

/**
 * "Faktureres gennem en anden konto": SkvizBiz' billing_id peger på betalerens interne id.
 * Sætter c.billTo = betalerens kunde-id i appen. Returnerer { linked, missing }.
 */
export function resolveBillTo(db) {
  const bySkviz = new Map(db.customers.filter((c) => c.skvizId != null).map((c) => [String(c.skvizId), c]));
  let linked = 0; const missing = [];
  for (const c of db.customers) {
    if (c.billingSkvizId == null || c.billingSkvizId === '' || String(c.billingSkvizId) === String(c.skvizId)) { delete c.billTo; continue; }
    const payer = bySkviz.get(String(c.billingSkvizId));
    if (payer && payer.id !== c.id) { c.billTo = payer.id; linked++; } else { delete c.billTo; missing.push(c.name); }
  }
  return { linked, missing };
}
