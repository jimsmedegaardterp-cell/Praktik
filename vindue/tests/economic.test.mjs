import test from 'node:test';
import assert from 'node:assert/strict';
import { EconomicApi, splitAddress } from '../js/adapters.js';
import * as S from '../js/services.js';
import { seedDb } from '../js/seed.js';

const admin = { id: 'u1', role: 'admin', employeeId: 'e1' };
const cfg = { layout: 21, paymentTerms: 1, vatZone: 1, customerGroup: 1, product: '1', journal: 1, cashAccount: 5800, mobilepayAccount: 5820, enabled: true };
function fakeServer() {
  const st = { calls: [], customers: {}, drafts: {}, booked: {}, seq: { d: 1, i: 100 }, payments: [], loseBookReply: false };
  const call = async (op, p) => {
    st.calls.push([op, p]);
    switch (op) {
      case 'upsertCustomer': { const n = p.number || (Number(p.customer.customerNo) || 5000 + Object.keys(st.customers).length); st.customers[n] = p.customer; return { customerNumber: n }; }
      case 'createDraft': { const d = st.seq.d++; const net = p.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0); st.drafts[d] = { ...p, net }; return { draftNumber: d, net, gross: net * 1.25 }; }
      case 'book': { const d = st.drafts[p.draftNumber]; if (!d) return { alreadyBooked: true }; const n = st.seq.i++; st.booked[n] = { ...d, sendBy: p.sendBy, gross: d.net * 1.25, remainder: d.net * 1.25 }; delete st.drafts[p.draftNumber];
        if (st.loseBookReply) { st.loseBookReply = false; throw new Error('timeout'); } return { invoiceNumber: n, gross: d.net * 1.25 }; }
      case 'findBooked': { const e = Object.entries(st.booked).find(([, b]) => b.reference === p.reference); return e ? { invoiceNumber: +e[0], gross: e[1].gross } : null; }
      case 'payment': st.payments.push(p); { const b = st.booked[p.invoiceNumber]; b.remainder -= p.amount; } return { voucher: st.payments.length };
      case 'status': return Object.fromEntries(p.numbers.map((n) => [n, { gross: st.booked[n].gross, remainder: st.booked[n].remainder }]));
    }
  };
  return { st, api: new EconomicApi(call, cfg) };
}
function doneVisits(db, n, extra = {}) {
  const vs = db.visits.filter((v) => v.status === 'planlagt').slice(0, n);
  for (const v of vs) S.registerVisit(db, admin, v.id, { result: 'udfoert', opId: 'o' + v.id, ...extra });
  return vs.map((v) => v.id);
}

test('splitAddress', () => {
  assert.deepEqual(splitAddress('Prøvevej 4, 9870 Sindal'), { address: 'Prøvevej 4', zip: '9870', city: 'Sindal' });
  assert.deepEqual(splitAddress('Uden postnr'), { address: 'Uden postnr' });
});

test('godkend → kunde, kladde, bogført og sendt pr. mail; ingen dobbeltfakturering', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer();
  const ids = doneVisits(db, 1); const v = db.visits.find((x) => x.id === ids[0]); const c = db.customers.find((x) => x.id === v.customerId); c.email = 'kunde@test.dk'; c.customerNo = '1234';
  const [l] = await S.approveAndBook(db, admin, ids, api);
  assert.equal(l.status, 'bogført'); assert.equal(l.sentBy, 'Email'); assert.equal(c.economicNumber, 1234);
  const cust = st.customers[1234]; assert.equal(cust.zip, '9870'); assert.equal(cust.city, 'Sindal');
  const draft = st.calls.find(([op]) => op === 'createDraft')[1]; assert.equal(draft.reference, 'SV-' + l.id); assert.equal(draft.lines[0].productNumber, '1'); assert.match(draft.lines[0].description, /Sindal|vej|gade/i);
  assert.equal(st.booked[l.invoiceNumber].sendBy, 'Email');
  // samme besøg igen → intet nyt
  const again = await S.approveAndBook(db, admin, ids, api); assert.equal(again.length, 0);
  assert.equal(st.calls.filter(([op]) => op === 'createDraft').length, 1);
});

test('uden e-mail → bogføres uden afsendelse; mail slået fra i opsætning respekteres', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer();
  const ids = doneVisits(db, 2); for (const id of ids) db.customers.find((x) => x.id === db.visits.find((v) => v.id === id).customerId).email = '';
  const ls = await S.approveAndBook(db, admin, ids, api); assert.ok(ls.every((l) => l.status === 'bogført' && l.sentBy === 'none'));
  const db2 = seedDb('2026-11-02'); db2.settings.economic = { ...cfg, sendEmail: false }; const f2 = fakeServer();
  const ids2 = doneVisits(db2, 1); db2.customers.find((x) => x.id === db2.visits.find((v) => v.id === ids2[0]).customerId).email = 'a@b.dk';
  const [l2] = await S.approveAndBook(db2, admin, ids2, f2.api); assert.equal(l2.sentBy, 'none');
});

test('betalt med MobilePay på stedet → indbetaling på MobilePay-kontoen og fakturaen står betalt', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer();
  const ids = doneVisits(db, 1, { cashAmount: 285, payMethod: 'mobilepay' });
  const [l] = await S.approveAndBook(db, admin, ids, api);
  assert.equal(st.payments.length, 1); assert.equal(st.payments[0].account, 5820); assert.equal(st.payments[0].amount, 285); assert.equal(st.payments[0].invoiceNumber, l.invoiceNumber);
  assert.deepEqual(l.paymentRegistered.method, 'mobilepay');
  await S.syncPayments(db, api, admin); assert.equal(st.payments.length, 1, 'ikke registreret to gange');
});

test('kontant går på kassekontoen', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer();
  await S.approveAndBook(db, admin, doneVisits(db, 1, { cashAmount: 200, payMethod: 'kontant' }), api);
  assert.equal(st.payments[0].account, 5800);
});

test('svaret på bogføring går tabt → genoptages uden dobbelt faktura (findes via reference)', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer(); st.loseBookReply = true;
  const [l] = await S.approveAndBook(db, admin, doneVisits(db, 1), api);
  assert.equal(l.status, 'kladde'); assert.match(l.error, /timeout/);
  await S.bookInvoice(db, admin, l.id, api);
  assert.equal(l.status, 'bogført'); assert.equal(Object.keys(st.booked).length, 1);
});

test('fejl ved kladde (fx manglende opsætning) → kan genforsøges', async () => {
  const db = seedDb('2026-11-02'); db.settings.economic = cfg; const { st, api } = fakeServer();
  let fail = true; const orig = api.call; api.call = async (op, p) => { if (op === 'createDraft' && fail) { fail = false; throw new Error('e-conomic 400: Ugyldig layout'); } return orig(op, p); };
  const [l] = await S.approveAndBook(db, admin, doneVisits(db, 1), api);
  assert.equal(l.status, 'fejl'); assert.match(l.error, /layout/);
  await S.retryInvoice(db, admin, l.id, api); await S.bookInvoice(db, admin, l.id, api);
  assert.equal(l.status, 'bogført');
});

test('færdigmelding af ruten bevarer betalingsmåde', () => {
  const db = seedDb('2026-11-02'); const v = db.visits.find((x) => x.status === 'planlagt');
  S.finishRoute(db, admin, [{ visitId: v.id, result: 'udfoert', cashAmount: 300, payMethod: 'mobilepay' }]);
  const c = db.visits.find((x) => x.id === v.id).completion; assert.equal(c.cashPaid, true); assert.equal(c.payMethod, 'mobilepay');
});
