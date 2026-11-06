// Kør: node --test vindue/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/domain.js';
import * as S from '../js/services.js';
import { MockEconomic, MockSms } from '../js/adapters.js';
import { seedDb } from '../js/seed.js';

const admin = { id: 'u1', role: 'admin', employeeId: 'e1' };
const mads = { id: 'u2', role: 'medarbejder', employeeId: 'e2' };
const ag = { id: 'ag1', customerId: 'c1', addressId: 'a1', routeId: 'r1', service: 'Pudsning', price: 300, intervalWeeks: 4, anchorDate: '2026-01-05', seasonMonths: [], active: true };

test('helligdage 2026 og 2027', () => {
  const h = D.danishHolidays(2026);
  for (const d of ['2026-04-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-05-14', '2026-05-24', '2026-05-25', '2026-12-25']) assert.ok(h.has(d), d);
  assert.ok(!h.has('2026-05-01'));
  assert.ok(D.danishHolidays(2027).has('2027-03-29')); // 2. påskedag 2027
  assert.ok(!D.danishHolidays(2026).has(D.addDays('2026-04-05', 26)), 'store bededag afskaffet');
});

test('serie over flere år: deterministiske id, ingen dubletter, helligdag → næste arbejdsdag', () => {
  const v = D.generateVisits(ag, '2026-01-01', '2028-12-31');
  assert.equal(new Set(v.map((x) => x.id)).size, v.length);
  for (const x of v) assert.ok(!D.isClosedDay(x.plannedDate), x.plannedDate);
  const easterMon = v.find((x) => x.rhythmDate === '2026-04-06');
  if (easterMon) assert.equal(easterMon.plannedDate, '2026-04-07');
  // Genkørsel med eksisterende besøg giver intet nyt
  assert.equal(D.generateVisits(ag, '2026-01-01', '2028-12-31', v).length, 0);
  // Grundrytmen er stabil på mandage
  for (const x of v) assert.equal(D.weekday(x.rhythmDate), 0);
});

test('sæson: ingen besøg i vintermånederne', () => {
  const v = D.generateVisits({ ...ag, seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10] }, '2026-01-01', '2027-12-31');
  assert.ok(v.every((x) => [3, 4, 5, 6, 7, 8, 9, 10].includes(D.month(x.rhythmDate))));
});

test('accepttest 1: besøg afsluttes én gang ved dobbelttryk / genforsøg', () => {
  const [v] = D.generateVisits(ag, '2026-01-01', '2026-01-31');
  const a = D.completeVisit(v, { result: 'udfoert', opId: 'op1', by: 'e2', at: '2026-01-05T10:00:00Z' });
  const b = D.completeVisit(a.visit, { result: 'udfoert', opId: 'op1', by: 'e2', at: '2026-01-05T10:00:05Z' });
  const c = D.completeVisit(b.visit, { result: 'aflyst', opId: 'op2', by: 'e2', at: '2026-01-05T10:01:00Z' });
  assert.ok(a.changed); assert.ok(!b.changed); assert.ok(!c.changed); assert.ok(c.conflict);
  assert.equal(c.visit.history.length, 1);
});

test('accepttest 2: flyt med "behold rytme" vs. "forskyd serie"', () => {
  const vs = D.generateVisits(ag, '2026-01-01', '2026-06-30');
  const second = vs[1]; // 2026-02-02
  const keep = D.moveVisit(vs, ag, second.id, '2026-02-04', 'keep', { by: 'x', at: 'now' });
  assert.equal(keep.visits[1].plannedDate, '2026-02-04');
  assert.equal(keep.visits[2].plannedDate, vs[2].plannedDate);
  assert.equal(keep.agreement.anchorDate, ag.anchorDate);
  const shift = D.moveVisit(vs, ag, second.id, '2026-02-04', 'shift', { by: 'x', at: 'now' });
  assert.equal(shift.visits[1].plannedDate, '2026-02-04');
  assert.equal(shift.visits[2].rhythmDate, '2026-03-04');
  assert.equal(shift.visits[0].plannedDate, vs[0].plannedDate, 'tidligere besøg uberørt');
  assert.equal(shift.agreement.anchorDate, '2026-01-07');
  // nye besøg genereret efter forskydning følger den nye rytme
  const more = D.generateVisits(shift.agreement, '2026-07-01', '2026-08-31', shift.visits);
  assert.ok(more.every((x) => D.weekday(x.rhythmDate) === 2));
});

test('accepttest 3: to adresser hos samme kunde forveksles ikke', () => {
  const db = seedDb('2026-11-02');
  const c = db.customers[0];
  const ags = db.agreements.filter((a) => a.customerId === c.id);
  assert.equal(ags.length, 2);
  assert.notEqual(ags[0].addressId, ags[1].addressId);
  for (const v of db.visits.filter((x) => x.customerId === c.id)) assert.equal(v.addressId, ags.find((a) => a.id === v.agreementId).addressId);
});

test('accepttest 4+5: fakturakladde kun én gang, også ved timeout og genforsøg', async () => {
  const db = seedDb('2026-11-02');
  const eco = new MockEconomic(db.mock.economic);
  const v = db.visits.find((x) => x.plannedDate >= '2026-11-02' && x.routeId === 'r1');
  S.registerVisit(db, mads, v.id, { result: 'udfoert', opId: 'o1' });
  assert.equal(D.invoiceQueue(db.visits, db.invoiceLinks).length, 1);
  eco.failNext = 1;
  const [l1] = await S.approveInvoices(db, admin, [v.id], eco);
  assert.equal(l1.status, 'fejl');
  // samtidigt dobbeltklik
  const [r1, r2] = await Promise.all([S.retryInvoice(db, admin, l1.id, eco), S.approveInvoices(db, admin, [v.id], eco)]);
  assert.equal(r1.status, 'kladde');
  assert.equal(db.invoiceLinks.length, 1);
  assert.equal(Object.keys(db.mock.economic.drafts).length, 1);
  assert.equal(D.invoiceQueue(db.visits, db.invoiceLinks).length, 0, 'faktureret besøg kan ikke komme i kø igen');
  // gen-registrering af samme besøg giver ikke ny faktura
  S.registerVisit(db, mads, v.id, { result: 'udfoert', opId: 'o1' });
  assert.equal(D.invoiceQueue(db.visits, db.invoiceLinks).length, 0);
  // bogføring + dobbeltklik
  await Promise.all([S.bookInvoice(db, admin, l1.id, eco), S.bookInvoice(db, admin, l1.id, eco).catch(() => null)]);
  assert.equal(Object.keys(db.mock.economic.booked).length, 1);
  assert.equal(db.invoiceLinks[0].status, 'bogført');
  eco.simulatePayment(db.invoiceLinks[0].invoiceNumber);
  await S.syncPayments(db, eco);
  assert.equal(db.invoiceLinks[0].payment, 'betalt');
});

test('accepttest 6: faktureret besøg kan ikke rettes lokalt', async () => {
  const db = seedDb('2026-11-02'); const eco = new MockEconomic(db.mock.economic);
  const v = db.visits.find((x) => x.routeId === 'r1' && x.plannedDate >= '2026-11-02');
  S.registerVisit(db, mads, v.id, { result: 'udfoert', opId: 'o1' });
  await S.approveInvoices(db, admin, [v.id], eco);
  assert.throws(() => D.correctVisit(db.visits.find((x) => x.id === v.id), { by: 'u1', at: 'x', price: 1, reason: 'test' }, db.invoiceLinks), /kreditnota/);
});

test('accepttest 7: SMS-svar i rigtig tråd, ukendt nummer manuelt, dubletter ignoreres', async () => {
  const db = seedDb('2026-11-02'); const sms = new MockSms(db.mock.sms);
  const c = db.customers[1];
  const m = await S.sendSms(db, admin, { customerId: c.id, text: 'Hej', clientRef: 'x1' }, sms);
  await S.sendSms(db, admin, { customerId: c.id, text: 'Hej', clientRef: 'x1' }, sms);
  assert.equal(db.smsMessages.filter((x) => x.dir === 'ud').length, 1);
  assert.equal(m.phone, '+4521445566');
  const r = S.receiveSms(db, { providerId: 'in1', from: '004521445566', text: 'Det passer fint' });
  assert.equal(r.message.customerId, c.id);
  assert.ok(S.receiveSms(db, { providerId: 'in1', from: '+4521445566', text: 'Det passer fint' }).duplicate);
  assert.equal(S.receiveSms(db, { providerId: 'in2', from: '+4599999999', text: '?' }).message.customerId, null);
  await assert.rejects(S.sendSms(db, admin, { customerId: c.id, text: 'Tilbud!', kind: 'marketing' }, sms), /samtykke/);
});

test('accepttest 8: medarbejder har ikke admin-/regnskabsadgang og kun egne ruter', async () => {
  const db = seedDb('2026-11-02'); const eco = new MockEconomic(db.mock.economic);
  assert.ok(!S.can(mads, 'invoice.approve')); assert.ok(!S.can(mads, 'economy.view')); assert.ok(S.can(mads, 'visit.complete'));
  await assert.rejects(S.approveInvoices(db, mads, [], eco), /Ingen adgang/);
  const r3 = db.visits.find((v) => v.routeId === 'r3');
  assert.throws(() => S.registerVisit(db, mads, r3.id, { result: 'udfoert', opId: 'z' }), /din rute/);
});

test('medarbejders store prisændring kræver godkendelse', () => {
  const db = seedDb('2026-11-02'); const v = db.visits.find((x) => x.routeId === 'r1');
  const r = S.registerVisit(db, mads, v.id, { result: 'udfoert', opId: 'p', price: v.price * 2 });
  assert.equal(r.visit.price, v.price); assert.match(r.visit.completion.note, /afventer godkendelse/);
});

test('SMS-dele og tegnsæt', () => {
  assert.deepEqual(D.smsParts('a'.repeat(160)), { encoding: 'GSM-7', parts: 1, chars: 160 });
  assert.equal(D.smsParts('a'.repeat(161)).parts, 2);
  assert.equal(D.smsParts('Hej æøå ÆØÅ').encoding, 'GSM-7');
  assert.equal(D.smsParts('Hej 😀').encoding, 'UCS-2');
  assert.equal(D.smsParts('Pris 300 €').chars, 11);
});

test('telefonnumre', () => {
  for (const x of ['20112233', '+45 20 11 22 33', '0045-20112233', '4520112233']) assert.equal(D.normalizePhone(x), '+4520112233');
  assert.equal(D.normalizePhone('123'), null);
});

test('provision 35 % ekskl. moms', () => {
  const v = [{ status: 'udfoert', price: 400, completion: { by: 'e2', at: '2026-11-02T10:00:00Z' } }, { status: 'aflyst', price: 999, completion: { by: 'e2', at: '2026-11-02' } }];
  assert.equal(D.commission(v).e2.commission, 140);
});

test('dobbeltbooking: kun samme opgave to gange eller to ruter samme dag', () => {
  const v = (id, service, routeId) => ({ id, addressId: 'a', plannedDate: 'd', status: 'planlagt', service, routeId });
  assert.equal(D.findDoubleBookings([v(1, 'Vinduesvask', 'r'), v(2, 'Vinduesvask', 'r')]).length, 1);
  assert.equal(D.findDoubleBookings([v(1, 'Vinduesvask', 'r'), v(2, '+ Orangeriet', 'r')]).length, 0, 'to forskellige opgaver på samme rute er normalt');
  assert.equal(D.findDoubleBookings([v(1, 'Vinduesvask', 'r1'), v(2, 'Tagrender', 'r2')]).length, 1, 'to ruter samme dag er mistænkeligt');
});

test('GDPR-sletning bevarer fakturalinks men fjerner persondata', async () => {
  const db = seedDb('2026-11-02'); const c = db.customers[2];
  S.deleteCustomer(db, admin, c.id);
  assert.equal(c.name, 'Slettet kunde'); assert.equal(c.phone, '');
  assert.ok(!db.visits.some((v) => v.customerId === c.id && v.status === 'planlagt'));
});

test('provision med individuel sats og periode', () => {
  const v = [{ status: 'udfoert', price: 400, completion: { by: 'e1', at: '2026-11-02T10:00:00Z' } }, { status: 'delvis', price: 200, completion: { by: 'e2', at: '2026-11-03T10:00:00Z' } }, { status: 'udfoert', price: 999, completion: { by: 'e2', at: '2026-12-01T10:00:00Z' } }];
  const r = D.commission(v, { rates: { e2: 0.4 }, from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.e1.commission, 140); assert.equal(r.e2.commission, 80);
});

test('ruter med egen rytme + Ikke fast', () => {
  const r = { anchorDate: '2026-11-11', intervalWeeks: 4 };
  assert.ok(D.routeRuns(r, '2026-12-09')); assert.ok(D.routeRuns(r, '2026-10-14')); assert.ok(!D.routeRuns(r, '2026-11-18'));
  assert.equal(D.nextRouteDate(r, '2026-11-12'), '2026-12-09'); assert.equal(D.nextRouteDate(r, '2026-11-11'), '2026-11-11'); assert.equal(D.nextRouteDate(r, '2026-10-01'), '2026-10-14');
  assert.ok(D.agreementFitsRoute({ anchorDate: '2026-12-09', intervalWeeks: 8 }, r));
  assert.ok(!D.agreementFitsRoute({ anchorDate: '2026-12-09', intervalWeeks: 6 }, r));
  const ag0 = { ...ag, intervalWeeks: 0, durationMin: 45 };
  assert.equal(D.generateVisits(ag0, '2026-01-01', '2027-01-01').length, 0);
  const mv = D.manualVisit(ag0, '2026-11-20'); assert.equal(mv.durationMin, 45);
  assert.throws(() => D.manualVisit(ag0, '2026-11-20', [mv]), /allerede/);
  assert.equal(D.hm(252), '4:12');
});

test('provision med fordeling pr. besøg', () => {
  const v = [{ status: 'udfoert', price: 176, completion: { by: 'e1', at: '2026-11-02T10:00:00Z' }, split: [{ employeeId: 'e2', pct: 35 }] },
    { status: 'udfoert', price: 100, completion: { by: 'e2', at: '2026-11-02T10:00:00Z' }, split: [{ employeeId: 'e2', pct: 20 }, { employeeId: 'e3', pct: 20 }] }];
  const r = D.commission(v);
  assert.equal(r.e2.commission, 81.6); assert.equal(r.e3.commission, 20); assert.equal(r.e1, undefined);
});

test('færdigmelding af rute: idempotent, kontant og fordeling', () => {
  const db = seedDb('2026-11-02');
  const vs = db.visits.filter((v) => v.routeId === 'r1' && v.status === 'planlagt').slice(0, 3);
  const entries = [{ visitId: vs[0].id, result: 'udfoert', cashAmount: 285, split: [{ employeeId: 'e2', pct: 35 }] }, { visitId: vs[1].id, result: 'forgaeves' }, { visitId: vs[2].id, result: 'aaben' }];
  const r1 = S.finishRoute(db, admin, entries); const r2 = S.finishRoute(db, admin, entries);
  assert.equal(r1.done, 2); assert.equal(r2.done, 0); assert.equal(r2.conflicts.length, 0);
  const v0 = db.visits.find((v) => v.id === vs[0].id);
  assert.ok(v0.completion.cashPaid); assert.equal(v0.completion.cashAmount, 285); assert.equal(v0.split[0].pct, 35);
  assert.equal(db.visits.find((v) => v.id === vs[2].id).status, 'planlagt');
});

test('"Husk næste gang" slettes ved færdigmelding', () => {
  const db = seedDb('2026-11-02'); const c = db.customers[1]; assert.ok(c.rememberNext);
  const v = db.visits.find((x) => x.customerId === c.id && x.status === 'planlagt');
  S.registerVisit(db, admin, v.id, { result: 'udfoert', opId: 'h1' });
  assert.equal(c.rememberNext, ''); assert.ok(db.visits.find((x) => x.id === v.id).history.some((h) => h.action === 'husk'));
});

test('ekstra opgaver: med på faktura og i provisionsgrundlag', async () => {
  const { MockEconomic } = await import('../js/adapters.js');
  const db = seedDb('2026-11-02'); const v = db.visits.find((x) => x.routeId === 'r1' && x.status === 'planlagt');
  S.finishRoute(db, admin, [{ visitId: v.id, result: 'udfoert', extras: [{ text: 'Kælderruder', price: 150 }], split: [{ employeeId: 'e2', pct: 35 }] }]);
  const done = db.visits.find((x) => x.id === v.id); assert.equal(D.visitTotal(done), done.price + 150);
  const [l] = await S.approveInvoices(db, admin, [v.id], new MockEconomic(db.mock.economic));
  assert.equal(l.total, done.price + 150);
  assert.ok(Object.values(db.mock.economic.drafts)[0].lines.some((x) => /Ekstra: Kælderruder/.test(x.description)));
  assert.equal(D.commission([done]).e2.commission, Math.round((done.price + 150) * 0.35 * 100) / 100);
});

test('prisregulering: +3 % med afrunding, kun gruppe, planlagte besøg fra dato', async () => {
  const { seedDb } = await import('../js/seed.js'); const S = await import('../js/services.js');
  const db = seedDb('2026-11-02'); const admin = { id: 'u1', role: 'admin' };
  const erh = db.agreements.filter((a) => db.customers.find((c) => c.id === a.customerId).group === 'Erhverv');
  const pv = S.priceAdjust(db, admin, { mode: 'pct', value: 3, filter: { type: 'group', value: 'Erhverv' }, from: '2027-01-01', round: 5 });
  assert.equal(pv.rows.length, erh.length); assert.equal(pv.rows[0].new % 5, 0); assert.ok(pv.sum.newYear > pv.sum.oldYear);
  assert.equal(erh[0].price, pv.rows[0].old, 'forhåndsvisning ændrer intet');
  const before = db.visits.filter((v) => v.agreementId === erh[0].id && v.plannedDate < '2027-01-01' && v.status === 'planlagt').map((v) => v.price);
  const r = S.priceAdjust(db, admin, { mode: 'pct', value: 3, filter: { type: 'group', value: 'Erhverv' }, from: '2027-01-01', round: 5, apply: true });
  assert.equal(erh[0].price, pv.rows[0].new); assert.equal(erh[0].priceHistory.length, 1);
  assert.ok(db.visits.filter((v) => v.agreementId === erh[0].id && v.plannedDate >= '2027-01-01' && v.status === 'planlagt').every((v) => v.price === erh[0].price));
  assert.deepEqual(db.visits.filter((v) => v.agreementId === erh[0].id && v.plannedDate < '2027-01-01' && v.status === 'planlagt').map((v) => v.price), before, 'besøg før datoen uændret');
  assert.throws(() => S.priceAdjust(db, { id: 'u2', role: 'medarbejder' }, { value: 1, apply: true, from: '2027-01-01' }));
});

test('flyt aftaler til anden rute: nye datoer på rutens dage, ingen id-kollision, historik bevaret', async () => {
  const { seedDb } = await import('../js/seed.js'); const S = await import('../js/services.js');
  const db = seedDb('2026-11-02'); const admin = { id: 'u1', role: 'admin', employeeId: 'e1' };
  const ag = db.agreements.find((a) => a.routeId === 'r1' && a.intervalWeeks === 4);
  const done = db.visits.find((v) => v.agreementId === ag.id && v.status === 'planlagt'); S.registerVisit(db, admin, done.id, { result: 'udfoert', opId: 'x' });
  const r = S.moveToRoute(db, admin, [ag.id], 'r2', '2026-11-03', '2027-03-01');
  assert.equal(r.moved, 1); assert.equal(ag.routeId, 'r2');
  const fut = db.visits.filter((v) => v.agreementId === ag.id && v.status === 'planlagt' && v.plannedDate >= '2026-11-03');
  assert.ok(fut.length >= 3); assert.ok(fut.every((v) => v.routeId === 'r2' && D.routeRuns(db.routes.find((x) => x.id === 'r2'), v.rhythmDate)), 'på rutens dage');
  assert.equal(new Set(db.visits.map((v) => v.id)).size, db.visits.length, 'unikke id');
  assert.equal(db.visits.find((v) => v.id === done.id).status, 'udfoert', 'udført besøg bevaret');
  assert.equal(db.routes.find((x) => x.id === 'r2').order.slice(-1)[0], ag.addressId);
});

test('slet aftale: fremtidige besøg væk, udførte bevaret', async () => {
  const { seedDb } = await import('../js/seed.js'); const S = await import('../js/services.js');
  const db = seedDb('2026-11-02'); const admin = { id: 'u1', role: 'admin', employeeId: 'e1' };
  const ag = db.agreements[0]; const v0 = db.visits.find((v) => v.agreementId === ag.id); S.registerVisit(db, admin, v0.id, { result: 'udfoert', opId: 'z' });
  const r = S.deleteAgreement(db, admin, ag.id, '2026-11-01');
  assert.ok(r.removedVisits > 0); assert.ok(!db.agreements.includes(ag));
  assert.ok(db.visits.some((v) => v.id === v0.id && v.status === 'udfoert'), 'udført bevaret');
  assert.ok(!db.visits.some((v) => v.agreementId === ag.id && v.status === 'planlagt'));
});

test('fjern frase fra beskrivelser – resten bliver', () => {
  const db = S.emptyDb();
  db.customers = [{ id: 'c1', name: 'A', notes: 'Opkøb Bjergby. Ring før' }];
  db.addresses = [{ id: 'a1', customerId: 'c1', street: 'V 1', access: 'Alt på huset - opkøbt fra Bjergby' }, { id: 'a2', customerId: 'c1', street: 'V 2', access: '(Opkøb Bjergby) Kun forside' }, { id: 'a3', customerId: 'c1', street: 'V 3', access: 'Bjergby kirke, nøgle i skur' }];
  db.agreements = [{ id: 'g1', customerId: 'c1', service: 'Vinduesvask opkøb bjergby' }];
  const hits = S.findPhrase(db, 'opkøb Bjergby');
  assert.equal(hits.length, 4);
  assert.equal(hits.find((h) => h.id === 'a1').after, 'Alt på huset');
  assert.equal(hits.find((h) => h.id === 'a2').after, 'Kun forside');
  assert.equal(hits.find((h) => h.id === 'c1').after, 'Ring før');
  assert.equal(S.removePhrase(db, admin, 'opkøb Bjergby'), 4);
  assert.equal(db.addresses[2].access, 'Bjergby kirke, nøgle i skur', 'uden "opkøb" røres ikke');
  assert.equal(db.agreements[0].service, 'Vinduesvask');
});
