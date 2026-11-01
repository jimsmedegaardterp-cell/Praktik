import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as G from '../js/gdpr.js';
import * as I from '../js/import.js';
import { seedDb } from '../js/seed.js';
import { uid } from '../js/services.js';

// Lille zip-skriver til test (stored + deflate, UTF-8-navne)
function makeZip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, text, deflate] of entries) {
    const nb = Buffer.from(name, 'utf8'); const raw = Buffer.from(text, 'utf8'); const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

// Fiktiv kunde i samme feltformat som SkvizBiz' GDPR-udtræk
const K1 = { id: 1, number: 2, name: 'Testcenter Prøvegården', address: 'Prøvevej 391', zipcode: '9800', city: 'Hjørring', lat: '57.48', lon: '9.99',
  email_address: 'test@example.dk', ean_number: '5790000000000', invoice_media: 'EAN', call_first: 'no', sms_first: 'yes', sms_after: 'no', sms_invoice: 'no', cash_payment: 'no',
  payment_1: 'dd', payment_2: 8, billing_frequency_1: 1, billing_frequency_2: 'visit', customer_group_id: 3, deleted: 'no', portal_password: 'skal-ignoreres', timestamp_created: 1693504537,
  deals: [{ description: 'Vinduesvask', price: '276.00', interval: 4, interval_unit: 'week', next: '2026-11-11', route: 'Sindal', duration: 13 }] };
const K2 = { 'Number': 3, 'Name': 'Eva Prøve', 'Address': 'Bakken 38', 'Zipcode': 9881, 'City': 'Bindslev', 'Mobile': '40112233', 'Cash payment': 'yes', 'Call first': 'yes', 'Deleted': 'no' };
const K3 = { number: 4, name: 'Slettet Kunde', deleted: 'yes' };

test('zip-læser: stored + deflate, kun data.json', async () => {
  const z = makeZip([['GDPR-udtræk/Kunde 00000002/data.json', JSON.stringify(K1), true], ['GDPR-udtræk/Kunde 00000002/Faktura 000591.pdf', '%PDF-fake', false], ['GDPR-udtræk/Kunde 00000003/data.json', JSON.stringify(K2), false]]);
  const files = await G.unzip(z, (n) => /data\.json$/i.test(n));
  assert.equal(files.length, 2);
  assert.equal(JSON.parse(new TextDecoder().decode(files[0].bytes)).name, 'Testcenter Prøvegården');
});

test('GDPR-plan: felter, aftaler, slettede, følsomme felter ignoreres', () => {
  const db = seedDb('2026-11-02');
  const plan = G.buildGdprPlan([{ name: 'a', json: K1 }, { name: 'b', json: K2 }, { name: 'c', json: K3 }], db, { today: '2026-11-02' });
  assert.equal(plan.customers.length, 2); assert.equal(plan.skipped, 1);
  const [a, b] = plan.customers;
  assert.equal(a.extId, '00000002'); assert.equal(a.extra.invoiceType, 'ean'); assert.equal(a.extra.smsBefore, true); assert.equal(a.extra.paymentDays, 8);
  assert.equal(a.addresses[0].street, 'Prøvevej 391, 9800 Hjørring'); assert.equal(a.addresses[0].lat, 57.48);
  const ag = a.addresses[0].agreements[0]; assert.equal(ag.price, 276); assert.equal(ag.intervalWeeks, 4); assert.equal(ag.anchorDate, '2026-11-11'); assert.equal(ag.routeId, 'r1'); assert.equal(ag.durationMin, 13);
  assert.equal(b.paymentMethod, 'kontant'); assert.equal(b.extra.callBefore, true); assert.equal(b.phone, '40112233');
  assert.ok(!JSON.stringify(plan.customers).includes('skal-ignoreres'));
  assert.ok(plan.issues.some((i) => /ingen aftaler/.test(i.msg)));
  const n = db.customers.length;
  I.applyImportPlan(db, plan, { batchId: 'g1', uid, horizon: '2027-03-01', today: '2026-11-02' });
  const imp = db.customers.find((c) => c.customerNo === '00000002');
  assert.equal(db.customers.length, n + 2); assert.equal(imp.invoiceType, 'ean'); assert.equal(imp.ean, '5790000000000');
  assert.ok(db.visits.some((v) => v.importBatch === 'g1' && v.plannedDate === '2026-11-11'));
  I.rollbackImport(db, 'g1'); assert.equal(db.customers.length, n);
});
