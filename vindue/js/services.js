// Applikationslag: binder domæne + data + adaptere sammen og skriver auditlog.
// Svarer til det, der i produktion kører på serveren (med server-side adgangskontrol).
import * as D from './domain.js';

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

export function emptyDb() {
  return { customers: [], addresses: [], agreements: [], routes: [], employees: [], visits: [], invoiceLinks: [],
    smsMessages: [], audit: [], closedDays: [], templates: {}, mock: { economic: {}, sms: {} }, settings: { commissionRate: 0.35, perCustomerInvoice: false } };
}

export function audit(db, by, action, ref, detail = {}) {
  db.audit.unshift({ id: uid('a'), at: now(), by, action, ref, detail });
  if (db.audit.length > 2000) db.audit.length = 2000;
}

/* --------- Rolle-tjek (i produktion: på serveren for hver handling) --------- */
export function can(user, action) {
  const admin = ['customer.edit', 'agreement.edit', 'invoice.approve', 'invoice.book', 'sms.send', 'visit.correct', 'visit.move', 'audit.view', 'economy.view', 'route.edit'];
  const employee = ['visit.complete', 'route.viewOwn', 'sms.send'];
  if (user.role === 'admin') return admin.includes(action) || employee.includes(action);
  return employee.includes(action);
}
function require_(user, action) { if (!can(user, action)) throw new Error(`Ingen adgang: ${action}`); }

/* --------- Planlægning --------- */
export function planAhead(db, untilIso, fromIso) {
  let added = 0;
  for (const ag of db.agreements) {
    const mine = db.visits.filter((v) => v.agreementId === ag.id);
    // start fra sidste eksisterende indeks for at undgå at genskabe gamle besøg
    const from = mine.length ? D.addDays(mine.reduce((m, v) => (v.rhythmDate > m ? v.rhythmDate : m), ''), 1) : (fromIso || ag.anchorDate);
    const nv = D.generateVisits(ag, from < ag.anchorDate ? ag.anchorDate : from, untilIso, mine, db.closedDays);
    db.visits.push(...nv); added += nv.length;
  }
  return added;
}

export function registerVisit(db, user, visitId, payload) {
  require_(user, 'visit.complete');
  const i = db.visits.findIndex((v) => v.id === visitId);
  if (i < 0) throw new Error('Besøg findes ikke');
  const v = db.visits[i];
  if (user.role !== 'admin' && v.routeId && !db.routes.find((r) => r.id === v.routeId && r.employeeId === user.employeeId))
    throw new Error('Ingen adgang: besøget ligger ikke på din rute');
  if (payload.price != null && payload.price !== v.price && user.role !== 'admin') {
    const maxPct = 0.2; // prisjustering > 20 % kræver admin-godkendelse
    if (Math.abs(payload.price - v.price) / v.price > maxPct) payload = { ...payload, price: v.price, note: (payload.note || '') + ` [Prisforslag ${payload.price} kr afventer godkendelse]` };
  }
  const r = D.completeVisit(v, { ...payload, by: user.employeeId || user.id, at: payload.at || now() });
  if (r.changed) {
    db.visits[i] = r.visit; audit(db, user.id, 'visit.' + payload.result, visitId, { opId: payload.opId, price: r.visit.price });
    const c = db.customers.find((x) => x.id === v.customerId); // "Husk næste gang" er engangsnote
    if (c?.rememberNext && payload.result !== 'udsat') { r.visit.history.push({ at: payload.at || now(), action: 'husk', note: c.rememberNext }); c.rememberNext = ''; }
  }
  return r;
}

/**
 * Færdigmelding af en hel rute (som i SkvizBiz). entries: [{ visitId, result, cashAmount, service, note, split }]
 * result 'aaben' = ikke udført endnu (røres ikke). opId er fast pr. besøg → gentagelse giver ingen dobbeltregistrering.
 */
export function finishRoute(db, user, entries) {
  const out = { done: 0, skipped: 0, conflicts: [] };
  for (const e of entries) {
    if (!e.result || e.result === 'aaben') { out.skipped++; continue; }
    const r = registerVisit(db, user, e.visitId, { result: e.result, opId: 'fm:' + e.visitId, cashAmount: Number(e.cashAmount) || 0, payMethod: e.payMethod, service: e.service, note: e.note, split: e.split, extras: e.extras });
    if (r.conflict) out.conflicts.push(r.conflict); else if (r.changed) out.done++;
  }
  audit(db, user.id, 'route.finish', '-', out);
  return out;
}

export function moveVisit(db, user, visitId, newDate, mode) {
  require_(user, 'visit.move');
  const v = db.visits.find((x) => x.id === visitId);
  const ai = db.agreements.findIndex((a) => a.id === v.agreementId);
  const r = D.moveVisit(db.visits, db.agreements[ai], visitId, newDate, mode, { by: user.id, at: now() }, db.closedDays);
  db.visits = r.visits; db.agreements[ai] = r.agreement;
  audit(db, user.id, 'visit.move', visitId, { newDate, mode });
}

/* --------- Fakturering --------- */
/**
 * Godkend & opret kladder. Rækkefølge for at undgå dobbeltfakturering:
 *  1) InvoiceLink oprettes LOKALT med status 'afventer' + idempotensnøgle (lås)
 *  2) kald e-conomic
 *  3) ved succes → 'kladde'; ved fejl → 'fejl' (kan genforsøges med SAMME nøgle)
 * Et besøg med et link i 'afventer'/'kladde'/'bogført' kan ikke komme i køen igen.
 */
export async function approveInvoices(db, user, visitIds, economic, { perCustomer } = {}) {
  require_(user, 'invoice.approve');
  const queue = D.invoiceQueue(db.visits, db.invoiceLinks).filter((v) => visitIds.includes(v.id));
  // betaler = den kunde der faktureres (kan være en anden konto end leveringskunden)
  const payerOf = (v) => db.customers.find((c) => c.id === v.customerId)?.billTo || v.customerId;
  const groups = D.groupForInvoicing(queue.map((v) => ({ ...v, customerId: payerOf(v), deliveryCustomerId: v.customerId })), { perCustomer: perCustomer ?? db.settings.perCustomerInvoice });
  const results = [];
  for (const g of groups) {
    const key = D.idempotencyKey(g.map((v) => v.id));
    let link = db.invoiceLinks.find((l) => l.idempotencyKey === key);
    if (link && link.status !== 'fejl') { results.push(link); continue; }
    if (!link) { link = { id: 'inv_' + fnv(key), idempotencyKey: key, customerId: g[0].customerId, visitIds: g.map((v) => v.id), status: 'afventer', createdAt: now(), attempts: 0 }; db.invoiceLinks.push(link); }
    else link.status = 'afventer';
    results.push(await pushDraft(db, user, link, economic));
  }
  return results;
}

async function pushDraft(db, user, link, economic) {
  const c = db.customers.find((x) => x.id === link.customerId);
  link.attempts++;
  try {
    const addr = splitAddr(db.addresses.find((a) => a.customerId === c.id && a.billing) || db.addresses.find((a) => a.customerId === c.id));
    if (!c.economicNumber || (economic.real && !c.economicSynced)) { const { externalId } = await economic.upsertCustomer(c, { address: addr }); c.economicNumber = externalId; if (economic.real) c.economicSynced = true; audit(db, user.id, 'economic.customer', c.id, { externalId }); }
    const lines = link.visitIds.map((id) => { const v = db.visits.find((x) => x.id === id); const a = db.addresses.find((x) => x.id === v.addressId);
      const dc = v.customerId !== c.id ? db.customers.find((x) => x.id === v.customerId)?.name + ', ' : '';
      return [{ description: `${v.service} – ${dc}${a?.street ?? ''} (${v.completion.at.slice(0, 10)})`, quantity: 1, unitNetPrice: v.price },
        ...(v.extras || []).filter((x) => x.text).map((x) => ({ description: `Ekstra: ${x.text} – ${a?.street ?? ''}`, quantity: 1, unitNetPrice: Number(x.price) || 0 }))]; }).flat();
    if (economic.findBooked) { const f = await economic.findBooked('SV-' + link.id);
      if (f) { Object.assign(link, { status: 'bogført', invoiceNumber: f.invoiceNumber, gross: f.gross, payment: 'åben', error: null }); audit(db, user.id, 'invoice.found', link.id, { invoiceNumber: f.invoiceNumber }); return link; } }
    const dates = link.visitIds.map((id) => db.visits.find((x) => x.id === id)?.completion?.at?.slice(0, 10)).filter(Boolean).sort();
    const { draftNumber, gross } = await economic.createDraftInvoice({ idempotencyKey: link.idempotencyKey, customerExternalId: c.economicNumber, lines,
      reference: 'SV-' + link.id, recipient: { name: c.name, ...addr }, date: dates[dates.length - 1] || now().slice(0, 10) });
    Object.assign(link, { status: 'kladde', draftNumber, error: null, total: lines.reduce((s, l) => s + l.unitNetPrice * (l.quantity || 1), 0), ...(gross ? { gross } : {}) });
    audit(db, user.id, 'invoice.draft', link.id, { draftNumber });
  } catch (e) {
    Object.assign(link, { status: 'fejl', error: e.message });
    audit(db, user.id, 'invoice.error', link.id, { error: e.message });
  }
  return link;
}

const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const splitAddr = (a) => { const m = String(a?.street || '').match(/^(.*?),\s*(\d{4})\s+(.+)$/); return m ? { address: m[1].trim(), zip: m[2], city: m[3].trim() } : a?.street ? { address: a.street } : {}; };

/**
 * Automatisk fakturering: alt færdigmeldt (ældre end graceMin minutter, så fejl kan nå at rettes) faktureres.
 * Kunder med "samlet pr. måned" faktureres samlet, når måneden er slut.
 */
export async function autoInvoice(db, user, economic, { nowMs = Date.now(), graceMin = 5, from } = {}) {
  if (!from) return []; // kun besøg færdigmeldt efter automatikken blev slået til (gamle/importerede er faktureret andetsteds)
  const cutoff = nowMs - graceMin * 60000; const month = new Date(nowMs).toISOString().slice(0, 7);
  const payer = (v) => db.customers.find((c) => c.id === (db.customers.find((x) => x.id === v.customerId)?.billTo || v.customerId));
  const q = D.invoiceQueue(db.visits, db.invoiceLinks).filter((v) => Date.parse(v.completion.at) <= cutoff && v.completion.at >= from);
  const monthly = q.filter((v) => payer(v)?.invoiceInterval === 'maaned');
  const each = q.filter((v) => payer(v)?.invoiceInterval !== 'maaned').map((v) => v.id);
  const dueMonthly = monthly.filter((v) => v.completion.at.slice(0, 7) < month).map((v) => v.id);
  const out = [];
  if (each.length) out.push(...(await approveAndBook(db, user, each, economic, { perCustomer: false })));
  if (dueMonthly.length) out.push(...(await approveAndBook(db, user, dueMonthly, economic, { perCustomer: true })));
  // fejlede kladder/bogføringer prøves igen (højst hvert 10. minut pr. faktura)
  const fresh = new Set(out.map((l) => l.id)); out.forEach((l) => { if (l.status !== 'bogført') l.lastTry = nowMs; });
  for (const l of db.invoiceLinks) {
    if (!fresh.has(l.id) && (l.status === 'fejl' || l.status === 'kladde') && (!l.lastTry || nowMs - l.lastTry > 600000) && (l.attempts || 0) < 6) {
      l.lastTry = nowMs; if (l.status === 'fejl') await retryInvoice(db, user, l.id, economic); if (l.status === 'kladde') await bookInvoice(db, user, l.id, economic); out.push(l);
    }
  }
  return out;
}

/** Godkend → kladde → (bogfør og send) → registrér betaling på stedet. Hvert trin kan genoptages ved fejl. */
export async function approveAndBook(db, user, visitIds, economic, { book = true, perCustomer } = {}) {
  const links = await approveInvoices(db, user, visitIds, economic, { perCustomer });
  if (book) for (const l of links) { if (l.status === 'kladde') await bookInvoice(db, user, l.id, economic); }
  return links;
}

/** Fakturaen sendes pr. mail, hvis kunden vil have mail og har en adresse. */
export const sendByFor = (c) => ((c?.invoiceType || 'email') === 'email' && c?.email ? 'Email' : 'none');

/** Betalt på stedet (kontant/MobilePay) → indbetaling i e-conomic, så fakturaen ikke står åben. */
export async function registerOnSitePayment(db, user, link, economic) {
  if (link.status !== 'bogført' || link.paymentRegistered || !economic.registerPayment) return link;
  // kun kontant – MobilePay/bank afstemmes af e-conomic (Betalingslink/bankafstemning)
  const vs = link.visitIds.map((id) => db.visits.find((v) => v.id === id)).filter((v) => v?.completion?.cashPaid && v.completion.payMethod !== 'mobilepay');
  if (!vs.length) return link;
  const c = db.customers.find((x) => x.id === link.customerId);
  const all = vs.length === link.visitIds.length;
  const amount = vs.reduce((s, v) => s + (Number(v.completion.cashAmount) || 0), 0) || (all ? link.gross : 0);
  if (!amount) { link.error = 'Betalt på stedet, men beløbet kendes ikke – registrér i e-conomic'; return link; }
  const method = vs.some((v) => v.completion.payMethod === 'mobilepay') ? 'mobilepay' : 'kontant';
  try {
    await economic.registerPayment({ customerNumber: c.economicNumber, invoiceNumber: link.invoiceNumber, amount, date: vs.map((v) => v.completion.at.slice(0, 10)).sort().pop(),
      text: `${method === 'mobilepay' ? 'MobilePay' : 'Kontant'} faktura ${link.invoiceNumber}`, method, key: link.id });
    Object.assign(link, { paymentRegistered: { amount, method, at: now() }, error: null });
    audit(db, user.id, 'invoice.payment', link.id, { amount, method });
  } catch (e) { link.error = 'Betaling ikke registreret: ' + e.message; audit(db, user.id, 'invoice.error', link.id, { error: e.message }); }
  return link;
}

export async function retryInvoice(db, user, linkId, economic) {
  require_(user, 'invoice.approve');
  const link = db.invoiceLinks.find((l) => l.id === linkId);
  if (link.status !== 'fejl') return link;
  link.status = 'afventer';
  return pushDraft(db, user, link, economic);
}

export async function bookInvoice(db, user, linkId, economic) {
  require_(user, 'invoice.book');
  const link = db.invoiceLinks.find((l) => l.id === linkId);
  if (link.status !== 'kladde') throw new Error('Kun kladder kan bogføres');
  if (link.booking) return link; // lås mod dobbeltklik
  link.booking = true;
  try {
    const c = db.customers.find((x) => x.id === link.customerId); const sendBy = db.settings.economic?.sendEmail === false ? 'none' : sendByFor(c);
    const { invoiceNumber, gross } = await economic.bookInvoice(link.draftNumber, { sendBy, reference: 'SV-' + link.id });
    Object.assign(link, { status: 'bogført', invoiceNumber, payment: 'åben', sentBy: sendBy, error: null, ...(gross ? { gross } : {}) });
    audit(db, user.id, 'invoice.booked', link.id, { invoiceNumber, sendBy });
  } catch (e) { link.error = e.message; audit(db, user.id, 'invoice.error', link.id, { error: e.message }); }
  finally { delete link.booking; }
  if (link.status === 'bogført') await registerOnSitePayment(db, user, link, economic);
  return link;
}

export async function syncPayments(db, economic, user) {
  const open = db.invoiceLinks.filter((x) => x.status === 'bogført' && x.payment !== 'betalt');
  if (user) for (const l of open) if (!l.paymentRegistered) await registerOnSitePayment(db, user, l, economic);
  if (economic.getStatuses && open.length) {
    for (let i = 0; i < open.length; i += 100) { const part = open.slice(i, i + 100); const st = await economic.getStatuses(part.map((l) => l.invoiceNumber));
      for (const l of part) { const s = st[l.invoiceNumber]; if (!s || s.error) { l.error = s?.error || 'Ukendt faktura'; continue; }
        Object.assign(l, { remainder: s.remainder, gross: s.gross, dueDate: s.dueDate || l.dueDate, payment: s.remainder <= 0 ? 'betalt' : s.remainder < s.gross ? 'delvis' : 'åben' }); } }
    return;
  }
  for (const l of open) {
    try { const s = await economic.getInvoiceStatus(l.invoiceNumber); l.payment = s.status; l.remainder = s.remainder; l.gross = s.gross; } catch (e) { l.error = e.message; }
  }
}

/* --------- SMS --------- */
export async function sendSms(db, user, { customerId, text, kind = 'service', clientRef }, sms) {
  require_(user, 'sms.send');
  const c = db.customers.find((x) => x.id === customerId);
  if (kind === 'marketing' && !c.marketingConsent) throw new Error('Kunden har ikke givet samtykke til markedsføring');
  const to = D.normalizePhone(c.phone);
  if (!to) throw new Error('Kunden har intet gyldigt mobilnummer');
  clientRef ||= uid('sms');
  let m = db.smsMessages.find((x) => x.clientRef === clientRef);
  if (m && m.status !== 'fejlet') return m;
  const parts = D.smsParts(text);
  if (!m) { m = { id: uid('m'), clientRef, dir: 'ud', customerId, phone: to, text, kind, status: 'klargjort', at: now(), by: user.id, ...parts }; db.smsMessages.push(m); }
  try { const r = await sms.send({ to, text, clientRef }); Object.assign(m, { providerId: r.providerId, status: r.status, error: null }); }
  catch (e) { Object.assign(m, { status: 'fejlet', error: e.message }); }
  audit(db, user.id, 'sms.' + m.status, m.id, { customerId, parts: m.parts });
  return m;
}

/** Webhook-handler (i produktion: verificér signatur før dette kaldes). Dubletter ignoreres på providerId. */
export function receiveSms(db, { providerId, from, text, at }) {
  if (db.smsMessages.some((m) => m.providerId === providerId)) return { duplicate: true };
  const customerId = D.matchInbound(from, db.customers);
  const m = { id: uid('m'), providerId, dir: 'ind', customerId, phone: D.normalizePhone(from) || from, text, at: at || now(), status: 'modtaget', read: false };
  db.smsMessages.push(m);
  audit(db, 'system', 'sms.inbound', m.id, { matched: !!customerId });
  return { message: m };
}

export function attachInbound(db, user, messageId, customerId) {
  require_(user, 'customer.edit');
  const m = db.smsMessages.find((x) => x.id === messageId); m.customerId = customerId;
  audit(db, user.id, 'sms.attach', messageId, { customerId });
}

export function markDelivered(db, providerId, status) {
  const m = db.smsMessages.find((x) => x.providerId === providerId);
  if (m && m.status !== 'leveret') m.status = status;
}

/* --------- GDPR --------- */
export function exportCustomer(db, customerId) {
  return {
    customer: db.customers.find((c) => c.id === customerId),
    addresses: db.addresses.filter((a) => a.customerId === customerId),
    agreements: db.agreements.filter((a) => a.customerId === customerId),
    visits: db.visits.filter((v) => v.customerId === customerId),
    sms: db.smsMessages.filter((m) => m.customerId === customerId),
    invoiceLinks: db.invoiceLinks.filter((l) => l.customerId === customerId),
  };
}
/** Sletning: persondata fjernes; fakturalinks bevares anonymiseret (bogføringsloven – faktura ligger i e-conomic). */
export function deleteCustomer(db, user, customerId) {
  require_(user, 'customer.edit');
  const c = db.customers.find((x) => x.id === customerId);
  Object.assign(c, { name: 'Slettet kunde', phone: '', email: '', notes: '', deleted: true });
  db.addresses.filter((a) => a.customerId === customerId).forEach((a) => Object.assign(a, { street: 'Slettet', access: '', lat: null, lng: null }));
  db.agreements.filter((a) => a.customerId === customerId).forEach((a) => (a.active = false));
  db.visits = db.visits.filter((v) => v.customerId !== customerId || v.status !== 'planlagt');
  db.smsMessages = db.smsMessages.filter((m) => m.customerId !== customerId);
  audit(db, user.id, 'customer.delete', customerId);
}

/* --------- Prisregulering --------- */
/**
 * Beregn (og evt. gennemfør) en prisregulering af aktive aftaler.
 *   mode 'pct' (fx 3 = +3 %) eller 'kr' (fx 10 = +10 kr), filter { type: 'all'|'group'|'route', value }, from (dato), round 1|5|0 (0 = ingen afrunding)
 * Ved apply: aftalens pris ændres, historik gemmes, og planlagte besøg fra datoen får den nye pris.
 */
export function priceAdjust(db, user, { mode = 'pct', value = 0, filter = { type: 'all' }, from, round = 1, apply = false }) {
  if (apply) require_(user, 'agreement.edit');
  const custOf = (a) => db.customers.find((c) => c.id === a.customerId);
  const hit = db.agreements.filter((a) => a.active !== false && custOf(a) && !custOf(a).deleted
    && (filter.type === 'all' || (filter.type === 'group' && (custOf(a).group || 'Privat kunder') === filter.value) || (filter.type === 'route' && a.routeId === filter.value)));
  const rnd = (x) => (round ? Math.round(x / round) * round : Math.round(x * 100) / 100);
  const rows = hit.map((a) => { const nw = Math.max(0, rnd(mode === 'pct' ? a.price * (1 + value / 100) : a.price + value)); return { a, c: custOf(a), old: a.price, new: nw }; }).filter((r) => r.new !== r.old);
  const yearly = (r, p) => D.annualRevenue({ ...r.a, price: p });
  const sum = { n: rows.length, oldYear: rows.reduce((s, r) => s + yearly(r, r.old), 0), newYear: rows.reduce((s, r) => s + yearly(r, r.new), 0) };
  if (apply) {
    let visits = 0;
    for (const r of rows) {
      (r.a.priceHistory ||= []).push({ from, old: r.old, new: r.new, at: now(), by: user.id });
      r.a.price = r.new;
      for (const v of db.visits) if (v.agreementId === r.a.id && v.status === 'planlagt' && v.plannedDate >= from && v.price === r.old) { v.price = r.new; visits++; }
    }
    audit(db, user.id, 'price.adjust', '-', { mode, value, filter, from, n: rows.length, visits });
    sum.visits = visits;
  }
  return { rows, sum };
}
