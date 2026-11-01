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
  if (r.changed) { db.visits[i] = r.visit; audit(db, user.id, 'visit.' + payload.result, visitId, { opId: payload.opId, price: r.visit.price }); }
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
    const r = registerVisit(db, user, e.visitId, { result: e.result, opId: 'fm:' + e.visitId, cashAmount: Number(e.cashAmount) || 0, service: e.service, note: e.note, split: e.split });
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
export async function approveInvoices(db, user, visitIds, economic) {
  require_(user, 'invoice.approve');
  const queue = D.invoiceQueue(db.visits, db.invoiceLinks).filter((v) => visitIds.includes(v.id));
  const groups = D.groupForInvoicing(queue, { perCustomer: db.settings.perCustomerInvoice });
  const results = [];
  for (const g of groups) {
    const key = D.idempotencyKey(g.map((v) => v.id));
    let link = db.invoiceLinks.find((l) => l.idempotencyKey === key);
    if (link && link.status !== 'fejl') { results.push(link); continue; }
    if (!link) { link = { id: uid('inv'), idempotencyKey: key, customerId: g[0].customerId, visitIds: g.map((v) => v.id), status: 'afventer', createdAt: now(), attempts: 0 }; db.invoiceLinks.push(link); }
    else link.status = 'afventer';
    results.push(await pushDraft(db, user, link, economic));
  }
  return results;
}

async function pushDraft(db, user, link, economic) {
  const c = db.customers.find((x) => x.id === link.customerId);
  link.attempts++;
  try {
    if (!c.economicNumber) { const { externalId } = await economic.upsertCustomer(c); c.economicNumber = externalId; audit(db, user.id, 'economic.customer', c.id, { externalId }); }
    const lines = link.visitIds.map((id) => { const v = db.visits.find((x) => x.id === id); const a = db.addresses.find((x) => x.id === v.addressId);
      return { description: `${v.service} – ${a?.street ?? ''} (${v.completion.at.slice(0, 10)})`, quantity: 1, unitNetPrice: v.price }; });
    const { draftNumber } = await economic.createDraftInvoice({ idempotencyKey: link.idempotencyKey, customerExternalId: c.economicNumber, lines });
    Object.assign(link, { status: 'kladde', draftNumber, error: null, total: lines.reduce((s, l) => s + l.unitNetPrice, 0) });
    audit(db, user.id, 'invoice.draft', link.id, { draftNumber });
  } catch (e) {
    Object.assign(link, { status: 'fejl', error: e.message });
    audit(db, user.id, 'invoice.error', link.id, { error: e.message });
  }
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
    const { invoiceNumber } = await economic.bookInvoice(link.draftNumber);
    Object.assign(link, { status: 'bogført', invoiceNumber, payment: 'åben' });
    audit(db, user.id, 'invoice.booked', link.id, { invoiceNumber });
  } catch (e) { link.error = e.message; audit(db, user.id, 'invoice.error', link.id, { error: e.message }); }
  finally { delete link.booking; }
  return link;
}

export async function syncPayments(db, economic) {
  for (const l of db.invoiceLinks.filter((x) => x.status === 'bogført' && x.payment !== 'betalt')) {
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
