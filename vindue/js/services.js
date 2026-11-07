// Applikationslag: binder domæne + data + adaptere sammen og skriver auditlog.
// Svarer til det, der i produktion kører på serveren (med server-side adgangskontrol).
import * as D from './domain.js';
import { localOptimal } from './dayplan.js';

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

export function emptyDb() {
  return { customers: [], addresses: [], agreements: [], routes: [], employees: [], visits: [], invoiceLinks: [], customerNotes: [],
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
      return [{ description: `${invoiceTextFor(db, v)} – ${dc}${a?.street ?? ''} (${v.completion.at.slice(0, 10)})`, quantity: 1, unitNetPrice: v.price },
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
    && (filter.type === 'all' || (filter.type === 'customers' && (filter.ids || []).includes(a.customerId)) || (filter.type === 'group' && (custOf(a).group || 'Privat kunder') === filter.value) || (filter.type === 'route' && a.routeId === filter.value)));
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

/* --------- Flyt aftaler til en anden rute --------- */
/**
 * Aftalerne flyttes til ruten; fremtidige planlagte besøg planlægges om på rutens dage fra næste gang ruten kører.
 * Udførte og tidligere besøg røres ikke. Adresserne sættes sidst i rutens faste rækkefølge.
 */
export function moveToRoute(db, user, agreementIds, routeId, todayIso, untilIso) {
  require_(user, 'agreement.edit');
  const r = db.routes.find((x) => x.id === routeId); if (!r) throw new Error('Ukendt rute');
  const anchor = D.nextRouteDate(r, todayIso); if (!anchor) throw new Error('Ruten har ingen næste dato');
  let moved = 0, visits = 0;
  for (const a of db.agreements.filter((x) => agreementIds.includes(x.id))) {
    if (a.routeId === routeId) continue;
    a.routeId = routeId;
    if (a.intervalWeeks) {
      a.anchorDate = anchor; a.idPrefix = `${a.id}~${anchor}`;
      db.visits = db.visits.filter((v) => !(v.agreementId === a.id && v.status === 'planlagt' && !v.manual && v.plannedDate >= todayIso));
      const nv = D.generateVisits(a, anchor, untilIso, db.visits.filter((v) => v.agreementId === a.id), db.closedDays); db.visits.push(...nv); visits += nv.length;
    }
    for (const v of db.visits) if (v.agreementId === a.id && v.status === 'planlagt' && v.manual && v.plannedDate >= todayIso) v.routeId = routeId;
    r.order = [...(r.order || []).filter((x) => x !== a.addressId), a.addressId];
    moved++;
  }
  audit(db, user.id, 'agreements.moveRoute', routeId, { n: moved, visits });
  return { moved, visits, anchor };
}

/**
 * Ruteoptimering: flyt kunder til ny rute + ny dato (moves fra optimizer.runOptimizer).
 * Fremtidige planlagte (ikke-manuelle) besøg fra startIso fjernes og dannes igen ud fra den nye ankerdato.
 * Adressen sættes ind i den nye rutes faste rækkefølge der, hvor den giver mindst omvej (luftlinje).
 */
export function applyRouteMoves(db, user, moves, startIso, untilIso, routeAnchors = {}) {
  require_(user, 'agreement.edit');
  const addrOf = (id) => db.addresses.find((a) => a.id === id);
  const dist = (x, y) => { const a = addrOf(x), b = addrOf(y); if (a?.lat == null || b?.lat == null) return 0; const dx = (a.lng - b.lng) * Math.cos(a.lat * Math.PI / 180), dy = a.lat - b.lat; return Math.hypot(dx, dy); };
  let moved = 0, visits = 0;
  for (const m of moves) {
    const r = db.routes.find((x) => x.id === m.toRoute); if (!r) continue;
    const ags = db.agreements.filter((a) => m.agreementIds.includes(a.id)); if (!ags.length) continue;
    const oldRoute = ags[0].routeId;
    for (const a of ags) {
      const anchor = m.anchors[a.id]; if (!anchor) continue;
      a.routeId = r.id; a.anchorDate = anchor; a.idPrefix = `${a.id}~${anchor}`;
      db.visits = db.visits.filter((v) => !(v.agreementId === a.id && v.status === 'planlagt' && !v.manual && v.plannedDate >= startIso));
      const nv = D.generateVisits(a, startIso, untilIso, db.visits.filter((v) => v.agreementId === a.id), db.closedDays); db.visits.push(...nv); visits += nv.length;
      for (const v of db.visits) if (v.agreementId === a.id && v.manual && v.status === 'planlagt' && v.plannedDate >= startIso) v.routeId = r.id;
    }
    if (oldRoute === r.id) { moved++; continue; } // samme rute, ny dato – rækkefølgen er uændret
    const o = (r.order || []).filter((x) => x !== m.addressId); let at = o.length, best = Infinity;
    for (let i = 0; i <= o.length; i++) { const c = (i ? dist(o[i - 1], m.addressId) : 0) + (i < o.length ? dist(m.addressId, o[i]) : 0) - (i && i < o.length ? dist(o[i - 1], o[i]) : 0); if (c < best) { best = c; at = i; } }
    o.splice(at, 0, m.addressId); r.order = o;
    const or = db.routes.find((x) => x.id === oldRoute);
    if (or?.order && !db.agreements.some((a) => a.routeId === or.id && a.addressId === m.addressId)) or.order = or.order.filter((x) => x !== m.addressId);
    moved++;
  }
  for (const [rid, d] of Object.entries(routeAnchors)) { const r = db.routes.find((x) => x.id === rid); if (r) { r.anchorDate = d; delete r.anchorUnknown; } }
  audit(db, user.id, 'routes.optimize', '-', { moved, visits, start: startIso, routes: Object.keys(routeAnchors).length });
  return { moved, visits };
}

/** Slet en aftale: fremtidige planlagte besøg fjernes; udførte besøg (historik, provision, fakturaer) bevares. */
export function deleteAgreement(db, user, agreementId, todayIso) {
  require_(user, 'agreement.edit');
  const a = db.agreements.find((x) => x.id === agreementId); if (!a) throw new Error('Aftalen findes ikke');
  const before = db.visits.length;
  db.visits = db.visits.filter((v) => !(v.agreementId === a.id && (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate >= todayIso));
  db.agreements = db.agreements.filter((x) => x.id !== a.id);
  const r = db.routes.find((x) => x.id === a.routeId);
  if (r?.order && !db.agreements.some((x) => x.routeId === r.id && x.addressId === a.addressId)) r.order = r.order.filter((x) => x !== a.addressId);
  audit(db, user.id, 'agreement.delete', a.id, { service: a.service, removedVisits: before - db.visits.length });
  return { removedVisits: before - db.visits.length };
}

/** Tekst på fakturaen for et besøg: aftalens fakturatekst (eller en anden af kundens aftaler, hvis opgaven er skiftet); ellers opgaven. */
export function invoiceTextFor(db, v) {
  const ag = db.agreements.find((a) => a.id === v.agreementId);
  if (ag && (!v.service || v.service === ag.service)) return ag.invoiceText || ag.service || v.service;
  const other = db.agreements.find((a) => a.customerId === v.customerId && a.service === v.service);
  return other?.invoiceText || v.service || ag?.invoiceText || '';
}

/* --------- Find og fjern en tekst i beskrivelser (fx "opkøb Bjergby") --------- */
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex for en frase: ordene i rækkefølge, endelser tilladt (opkøb → opkøbt), op til 15 tegn imellem (fx "opkøbt fra"). */
export function phraseRegex(phrase) {
  const ws = String(phrase || '').trim().split(/\s+/).filter(Boolean).map(reEsc); if (!ws.length) return null;
  return new RegExp(`[\\s,;:/–-]*\\(?\\s*${ws.join('[\\p{L}\\d]*[^\\n]{0,15}?')}[\\p{L}\\d]*\\s*\\)?`, 'giu');
}
export function stripPhrase(text, re) {
  if (!text || !re) return text; re.lastIndex = 0; if (!re.test(text)) return text; re.lastIndex = 0;
  return text.replace(re, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1').replace(/^[\s,.;:–-]+|[\s,;:–-]+$/g, '').replace(/^[ \t,.;:–-]+|[ \t,;:–-]+$/gm, '');
}
const PHRASE_FIELDS = [['addresses', 'access', 'Beskrivelse'], ['addresses', 'obs', 'Særlig opmærksomhed'], ['customers', 'notes', 'Kundenote'], ['customers', 'rememberNext', 'Kun denne gang'],
  ['agreements', 'service', 'Opgave'], ['agreements', 'invoiceText', 'Fakturatekst'], ['customerNotes', 'text', 'Note']];
/** Alle steder frasen findes: [{col, id, field, label, customerId, before, after}] – ændrer intet. */
export function findPhrase(db, phrase) {
  const re = phraseRegex(phrase); if (!re) return []; const out = [];
  for (const [col, field, label] of PHRASE_FIELDS) for (const x of db[col] || []) { const t = x[field]; if (typeof t !== 'string' || !t) continue;
    const after = stripPhrase(t, re); if (after !== t) out.push({ col, id: x.id, field, label, customerId: col === 'customers' ? x.id : x.customerId, before: t, after }); }
  return out;
}
export function removePhrase(db, user, phrase, onlyIds) {
  require_(user, 'customer.edit'); const hits = findPhrase(db, phrase).filter((h) => !onlyIds || onlyIds.has(h.col + '/' + h.id + '/' + h.field));
  for (const h of hits) { const x = db[h.col].find((y) => y.id === h.id); if (x) x[h.field] = h.after; }
  audit(db, user.id, 'text.removePhrase', '-', { phrase, n: hits.length });
  return hits.length;
}

/* --------- Byg nye faste ruter ud fra kalenderen (efter ruteoptimering) ---------
 * Hver kunde hører til den "rutedag" hendes næste besøg ligger på: samme ugedag i samme uge af rytmen (4 uger for 4/8/12 …-ugers kunder).
 * Én rute pr. rutedag. Eksisterende ruter genbruges, hvor de fleste kunder kommer fra (navn og historik bevares); ellers ny rute med områdenavn.
 * Datoerne ændres ikke – kun hvilken rute kunderne står på, rutens rytme/dato og rækkefølge.
 */
const cityOf = (street) => ((String(street || '').match(/\b\d{4}\s+([^,]+)$/) || [])[1] || '').trim();
export function cycleFor(intervalWeeks) { const i = intervalWeeks; return i % 4 === 0 ? 4 : i % 2 === 0 ? 2 : i; }
export function planRoutesFromCalendar(db, { fromIso, excludeRouteIds = [], startPoint = null } = {}) {
  const excl = new Set(excludeRouteIds); const BASE = '2000-01-03';
  const addrOf = (id) => db.addresses.find((a) => a.id === id);
  const groups = new Map(); let untouched = 0;
  for (const a of db.agreements) {
    if (!a.active || !a.intervalWeeks || !a.routeId || excl.has(a.routeId)) continue;
    const v = db.visits.filter((x) => x.agreementId === a.id && !x.manual && (x.status === 'planlagt' || x.status === 'udsat') && x.plannedDate >= fromIso).sort((x, y) => (x.plannedDate < y.plannedDate ? -1 : 1))[0];
    if (!v) { untouched++; continue; }
    const C = cycleFor(a.intervalWeeks); const P = C * 7; const slot = ((D.diffDays(BASE, v.rhythmDate) % P) + P) % P;
    const k = C + '@' + slot; if (!groups.has(k)) groups.set(k, { key: k, C, anchor: v.rhythmDate, agreementIds: [], from: {} });
    const g = groups.get(k); g.agreementIds.push(a.id); if (v.rhythmDate < g.anchor) g.anchor = v.rhythmDate; g.from[a.routeId] = (g.from[a.routeId] || 0) + 1;
  }
  const list = [...groups.values()].sort((x, y) => (x.anchor < y.anchor ? -1 : x.anchor > y.anchor ? 1 : x.C - y.C));
  // genbrug ruter: størst overlap først
  const pairs = list.flatMap((g) => Object.entries(g.from).map(([rid, n]) => ({ g, rid, n }))).sort((x, y) => y.n - x.n);
  const usedR = new Set();
  for (const { g, rid, n } of pairs) { if (g.reuse || usedR.has(rid) || !db.routes.some((r) => r.id === rid)) continue; g.reuse = rid; g.keepName = n * 2 >= g.agreementIds.length; usedR.add(rid); }
  const taken = new Set(db.routes.filter((r) => excl.has(r.id) || list.some((g) => g.reuse === r.id && g.keepName)).map((r) => r.name));
  for (const g of list) {
    const ags = g.agreementIds.map((id) => db.agreements.find((a) => a.id === id));
    const addrIds = [...new Set(ags.map((a) => a.addressId))];
    const cnt = {}; for (const id of addrIds) { const c = cityOf(addrOf(id)?.street); if (c) cnt[c] = (cnt[c] || 0) + 1; }
    const top = Object.entries(cnt).sort((x, y) => y[1] - x[1]); g.towns = top.map(([c, n]) => `${c} (${n})`).join(', ');
    if (g.keepName) g.name = db.routes.find((r) => r.id === g.reuse).name;
    else { let base = top.length ? top[0][0] + (top[1] && top[1][1] * 4 >= addrIds.length ? '/' + top[1][0] : '') : 'Rute'; let nm = base, i = 2; while (taken.has(nm)) nm = `${base} ${i++}`; g.name = nm; }
    taken.add(g.name);
    const pts = addrIds.map((id) => ({ id, a: addrOf(id) })); const withLL = pts.filter((p) => p.a?.lat != null);
    g.order = [...localOptimal(withLL, (p) => p.a, startPoint), ...pts.filter((p) => p.a?.lat == null).map((p) => p.id)];
    const emp = {}; for (const a of ags) { const e = db.routes.find((r) => r.id === a.routeId)?.employeeId; if (e) emp[e] = (emp[e] || 0) + 1; }
    g.employeeId = g.reuse ? db.routes.find((r) => r.id === g.reuse).employeeId : Object.entries(emp).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    g.n = addrIds.length; g.min = ags.reduce((s, a) => s + (a.durationMin ?? 15), 0);
  }
  const involved = new Set(list.flatMap((g) => Object.keys(g.from)));
  const emptied = db.routes.filter((r) => involved.has(r.id) && !usedR.has(r.id)).map((r) => r.id);
  return { groups: list, untouched, emptied };
}
export function applyRouteRebuild(db, user, plan, todayIso) {
  require_(user, 'route.edit');
  const newIds = [];
  for (const g of plan.groups) {
    let r = g.reuse && db.routes.find((x) => x.id === g.reuse);
    if (!r) { r = { id: uid('r') }; db.routes.push(r); newIds.push(r.id); }
    Object.assign(r, { name: g.name, intervalWeeks: g.C, anchorDate: g.anchor, order: [...g.order], employeeId: g.employeeId ?? r.employeeId ?? null }); delete r.anchorUnknown;
    const ids = new Set(g.agreementIds);
    for (const a of db.agreements) if (ids.has(a.id)) a.routeId = r.id;
    for (const v of db.visits) if (ids.has(v.agreementId) && (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate >= todayIso) v.routeId = r.id;
  }
  audit(db, user.id, 'routes.rebuild', '-', { routes: plan.groups.length, created: newIds.length, emptied: plan.emptied.length });
  return { routes: plan.groups.length, created: newIds.length };
}

/* --------- Lønafregning: provision siden sidste afregning ---------
 * Hvert besøg stemples, når det afregnes (v.payroll = { run, at, amounts }). Næste afregning tager alle fakturerbare besøg,
 * der ikke er afregnet endnu (også sent registrerede), plus rettelser: er et afregnet besøg siden ændret (pris, ekstra opgaver,
 * aflyst, andet fordelingsforhold), kommer forskellen med som en rettelseslinje. Intet afregnes to gange.
 */
export function visitCommission(db, v) {
  if (!D.isBillable(v) || !v.completion) return {};
  const rate = (id) => db.employees.find((e) => e.id === id)?.commissionRate ?? db.settings.commissionRate ?? 0;
  const base = D.visitTotal(v) * (db.settings.commissionInclVat ? 1.25 : 1); const out = {};
  const split = v.split?.length ? v.split : [{ employeeId: v.completion.by, pct: rate(v.completion.by) * 100 }];
  for (const sp of split) { if (!sp.pct || !sp.employeeId) continue; const o = (out[sp.employeeId] ||= { base: 0, com: 0, pct: 0 }); o.base += base; o.com += base * sp.pct / 100; o.pct += sp.pct; }
  for (const k in out) { out[k].base = Math.round(out[k].base * 100) / 100; out[k].com = Math.round(out[k].com * 100) / 100; }
  return out;
}
export function payrollPending(db, toIso) {
  const from = db.settings.payrollFrom || '0000'; const lines = [];
  for (const v of db.visits) {
    const d = v.completion?.at?.slice(0, 10); const cur = visitCommission(db, v);
    if (!v.payroll) { if (!d || d < from || d > toIso) continue; for (const [e, x] of Object.entries(cur)) lines.push({ visitId: v.id, e, base: x.base, com: x.com, pct: x.pct, kind: 'ny', date: d }); continue; }
    const prev = v.payroll.amounts || {};
    for (const e of new Set([...Object.keys(cur), ...Object.keys(prev)])) { const db_ = Math.round(((cur[e]?.base || 0) - (prev[e]?.base || 0)) * 100) / 100; const dc = Math.round(((cur[e]?.com || 0) - (prev[e]?.com || 0)) * 100) / 100;
      if (Math.abs(dc) >= 0.01) lines.push({ visitId: v.id, e, base: db_, com: dc, pct: cur[e]?.pct || 0, kind: 'rettelse', date: d || v.payroll.at.slice(0, 10) }); }
  }
  return lines;
}
export function payrollTotals(lines) {
  const t = {}; for (const l of lines) { const o = (t[l.e] ||= { n: 0, base: 0, com: 0, fix: 0 }); if (l.kind === 'ny') o.n++; else o.fix += l.com; o.base += l.base; o.com += l.com; }
  for (const k in t) for (const f of ['base', 'com', 'fix']) t[k][f] = Math.round(t[k][f] * 100) / 100;
  return t;
}
export function settlePayroll(db, user, toIso) {
  require_(user, 'economy.view');
  const lines = payrollPending(db, toIso); if (!lines.length) throw new Error('Intet at afregne');
  const run = { run: uid('pay'), at: now(), to: toIso, by: user.id };
  // stemplet ligger på besøgene (ingen ny posttype) – tidligere stempler gemmes i payrollHist, så historikken kan genskabes
  for (const id of new Set(lines.map((l) => l.visitId))) { const v = db.visits.find((x) => x.id === id); if (v.payroll) (v.payrollHist ||= []).push(v.payroll); v.payroll = { ...run, amounts: visitCommission(db, v) }; }
  audit(db, user.id, 'payroll.settle', run.run, { to: toIso, lines: lines.length });
  return { id: run.run, at: run.at, to: toIso, lines, totals: payrollTotals(lines) };
}
/** Tidligere afregninger, genskabt fra stemplerne på besøgene (nyeste først). */
export function payrollRuns(db) {
  const runs = new Map();
  for (const v of db.visits) { const st = [...(v.payrollHist || []), ...(v.payroll ? [v.payroll] : [])]; let prev = {};
    for (const e of st) { const r = runs.get(e.run) || { id: e.run, at: e.at, to: e.to, lines: [] }; runs.set(e.run, r);
      for (const k of new Set([...Object.keys(e.amounts || {}), ...Object.keys(prev)])) { const c = Math.round(((e.amounts?.[k]?.com || 0) - (prev[k]?.com || 0)) * 100) / 100; if (Math.abs(c) < 0.01) continue;
        r.lines.push({ visitId: v.id, e: k, base: Math.round(((e.amounts?.[k]?.base || 0) - (prev[k]?.base || 0)) * 100) / 100, com: c, pct: e.amounts?.[k]?.pct || 0, kind: Object.keys(prev).length ? 'rettelse' : 'ny', date: v.completion?.at?.slice(0, 10) || e.at.slice(0, 10) }); }
      prev = e.amounts || {}; } }
  return [...runs.values()].map((r) => ({ ...r, totals: payrollTotals(r.lines) })).sort((a, b) => (a.at < b.at ? 1 : -1));
}
