import test from 'node:test';
import assert from 'node:assert/strict';
import * as SD from '../js/stamdata.js';
import * as G from '../js/gdpr.js';
import * as I from '../js/import.js';
import { seedDb } from '../js/seed.js';
import { uid } from '../js/services.js';

// Opdigtede kunder, men samme positioner som SkvizBiz' stamdata-PDF
const L = 59.5, R = 314.6;
const t = (page, y, x, str) => ({ str, x, y, w: str.length * 4.6, page });
const kunde = (page, y0, no, name, extra, notes, agr) => {
  const it = [t(page, y0, L, `Kundenr. ${no} - ${name}`), t(page, y0 - 12.5, L, 'Leveringsadresse:'), t(page, y0 - 12.5, R, 'Faktureringsadresse:')];
  const addr = [name, ...extra]; addr.forEach((a, i) => { it.push(t(page, y0 - 23.8 - i * 11.3, L, a), t(page, y0 - 23.8 - i * 11.3, R, a)); });
  let y = y0 - 23.8 - addr.length * 11.3 - 11.3;
  it.push(t(page, y, L, 'Tlf.: 20 11 22 33'), t(page, y, R, 'Betalingsbetingelser: d.d. + 14 dage')); y -= 11.3;
  it.push(t(page, y, L, 'Email: test@example.dk'), t(page, y, R, 'CVR-nummer: ikke oplyst')); y -= 22.7;
  notes.forEach((n, i) => { it.push(t(page, y, L, (i ? '' : 'Noter: ') + n)); y -= 11.3; });
  if (agr.length) { y -= 11.4; it.push(t(page, y, L, 'Aftaler med kunden'), t(page, y, 286.3, 'Interval'), t(page, y, 357.2, 'Næste gang'), t(page, y, 428.2, 'Pris ex moms'), t(page, y, 520.7, 'Tid')); y -= 11.2;
    for (const [s, iv, nx, pr, ti] of agr) { it.push(t(page, y, L, s), t(page, y, 286.3, iv), t(page, y, 357.2, nx), t(page, y, 493 - pr.length * 4.4, pr), t(page, y, 516.3, ti)); y -= 11.2; } }
  return it;
};
const ITEMS = [t(1, 802.7, 116, 'Eksporteret fra SkvizBiz kundekartotek den 01/11-2026'),
  ...kunde(1, 763, '00000003', 'Hans Prøvesen', ['Prøveparken 28, st. th', '9850 Hirtshals'], ['Minus gavl. Ét vindue efter altan.', 'Nøgle under krukken.'], [['Vinduesvask', 'Hver 8. uge', '15/12-2026', 'kr. 96,00', '0:05']]),
  ...kunde(1, 560, '00000004', 'Karin Test', ['Testvej 7', 'Tornby', '9850 Hirtshals'], ['Alt på huset'], [['Vinduesvask', 'Hver 4. uge', '29/12-2026', 'kr. 1.320,00', '1:21'], ['Vinduesvask Sommerhus 5', 'Ikke fast', '', 'kr. 232,00', '0:13']]),
  t(1, 24.8, 263.4, 'Side 1 af 2'),
  ...kunde(2, 763, '00000007', 'Test Kommune', ['Torvet 5', '9800 Hjørring'], [], []),
  t(2, 1.2, 2.8, 'Powered by TCPDF (www.tcpdf.org)')];

test('stamdata-PDF: kunder, adresser, noter, aftaler', () => {
  const cs = SD.parseStamdataItems(ITEMS);
  assert.equal(cs.length, 3);
  assert.equal(cs[0].extId, '00000003'); assert.equal(cs[0].phone, '20 11 22 33'); assert.equal(cs[0].paymentDays, 14); assert.equal(cs[0].cvr, '');
  assert.deepEqual(cs[0].notes, ['Minus gavl. Ét vindue efter altan.', 'Nøgle under krukken.']);
  assert.deepEqual(SD.splitAddress(cs[1].delivery, cs[1].name), { street: 'Testvej 7', address2: 'Tornby', zipCity: '9850 Hirtshals' });
  assert.equal(cs[1].agreements.length, 2); assert.equal(cs[1].agreements[0].price, 'kr. 1.320,00'); assert.equal(cs[1].agreements[1].interval, 'Ikke fast');
  assert.equal(cs[2].agreements.length, 0);
});

test('stamdata + GDPR → plan → import', () => {
  const db = seedDb('2026-11-02');
  const gdpr = { '00000004': G.normalize({ Number: 4, 'Invoice media': 'EAN', 'Sms first': 'yes', 'Cash payment': 'yes', Lat: '57.5', Lon: '9.9', Deleted: 'no', 'Portal password': 'x' }), '00000007': G.normalize({ number: 7, deleted: 'yes' }) };
  const plan = SD.buildSkvizPlan([{ fileName: 'rute.pdf', routeId: 'r1', customers: SD.parseStamdataItems(ITEMS) }], gdpr, db, { today: '2026-11-02' });
  assert.equal(plan.customers.length, 2); assert.equal(plan.skipped, 1);
  const k = plan.customers[1];
  assert.equal(k.addresses[0].street, 'Testvej 7, Tornby, 9850 Hirtshals'); assert.equal(k.addresses[0].access, 'Alt på huset'); assert.equal(k.addresses[0].lat, 57.5);
  assert.equal(k.extra.invoiceType, 'ean'); assert.equal(k.extra.smsBefore, true); assert.equal(k.paymentMethod, 'kontant');
  const [a1, a2] = k.addresses[0].agreements;
  assert.deepEqual([a1.price, a1.intervalWeeks, a1.anchorDate, a1.durationMin, a1.routeId], [1320, 4, '2026-12-29', 81, 'r1']);
  assert.deepEqual([a2.intervalWeeks, a2.routeId], [0, null]);
  const n = db.customers.length; I.applyImportPlan(db, plan, { batchId: 's1', uid, horizon: '2027-03-01', today: '2026-11-02' });
  assert.equal(db.customers.length, n + 2);
  assert.ok(db.visits.some((v) => v.importBatch === 's1' && v.plannedDate === '2026-12-15'));
});
