import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/import.js';
import { seedDb } from '../js/seed.js';
import { uid } from '../js/services.js';

const CSV = '﻿Kundenr;Navn;Mobil;Adresse;Postnr;By;Ydelse;Pris;Interval;Næste besøg;Betaling\n' +
  '101;Ny Kunde;20 30 40 50;Testvej 1;8600;Silkeborg;Vinduer ude;"1.250,50";8 uger;15-11-2026;MobilePay\n' +
  '101;Ny Kunde;20 30 40 50;Sommerhus 2;8680;Ry;Vinduer;400;12;01.04.2027;MobilePay\n' +
  '102;Peter Demo;21445566;Vestergade 12;8600;Silkeborg;Ude;275;4;2026-11-10;\n' +
  '103;Fejl Fido;123;Fejlvej;;;;abc;hver anden måned;32-13-2026;kontant\n;;;;;;;;;;\n';

test('parse + gæt kolonner', () => {
  const p = I.parseCsv(CSV);
  assert.equal(p.headers.length, 11); assert.equal(p.rows.length, 4);
  const m = I.guessMapping(p.headers);
  for (const f of ['extId', 'name', 'phone', 'street', 'zip', 'city', 'service', 'price', 'intervalWeeks', 'nextDate', 'paymentMethod']) assert.ok(m[f] != null, f);
});

test('parsere', () => {
  assert.equal(I.parsePrice('1.250,50'), 1250.5); assert.equal(I.parsePrice('300 kr'), 300); assert.ok(Number.isNaN(I.parsePrice('abc')));
  assert.equal(I.parseDate('15-11-2026'), '2026-11-15'); assert.equal(I.parseDate('1.4.27'), '2027-04-01'); assert.equal(I.parseDate('46341'), '2026-11-15');
  assert.equal(I.parseInterval('8 uger'), 8); assert.equal(I.parseInterval('hver 2. måned'), 8); assert.equal(I.parseInterval('Hver 4. uge'), 4); assert.equal(I.parseInterval('Ikke fast'), 0);
  assert.equal(I.parseDuration('00:25'), 25); assert.equal(I.parseDuration('1:05'), 65); assert.equal(I.parseDuration('20'), 20);
});

test('plan: samler adresser, finder dubletter og fejl; import kan fortrydes', () => {
  const db = seedDb('2026-11-02'); const before = JSON.stringify(db);
  const p = I.parseCsv(CSV); const plan = I.buildImportPlan(p, I.guessMapping(p.headers), db, { defaultRouteId: 'r1', today: '2026-11-02' });
  assert.equal(JSON.stringify(db), before, 'plan ændrer ikke data');
  assert.equal(plan.customers.length, 3);
  assert.equal(plan.customers[0].addresses.length, 2);
  assert.equal(plan.customers[0].paymentMethod, 'mobilepay');
  assert.equal(plan.duplicates.length, 1); assert.equal(plan.duplicates[0].existing, 'Peter Demo');
  assert.ok(plan.errors >= 3);
  const n = db.customers.length;
  const counts = I.applyImportPlan(db, plan, { batchId: 'b1', uid, horizon: '2027-12-31', today: '2026-11-02' });
  assert.equal(counts.customers, 2); assert.equal(db.customers.length, n + 2);
  assert.ok(db.visits.some((v) => v.importBatch === 'b1' && v.plannedDate === '2026-11-16')); // 15/11 er søndag → mandag
  assert.ok(plan.issues.some((i) => /passer ikke med ruten/.test(i.msg)));
  I.rollbackImport(db, 'b1');
  assert.equal(db.customers.length, n); assert.ok(!db.visits.some((v) => v.importBatch === 'b1'));
});

test('PDF-tekst → tabel (overskrift, flere sider, ombrudte celler, sidetal)', () => {
  const H = [['Kundenr.', 40], ['Navn / firma', 110], ['Adresse', 260], ['Postnr. / by', 420], ['Interval', 540], ['Mobil', 620]];
  const it = (page, y, row) => row.map(([str, x]) => ({ str, x, y, w: str.length * 4.5, page }));
  const items = [
    ...it(1, 800, [['Kundekartotek 2026-11-01', 40]]),
    ...it(1, 760, H),
    ...it(1, 740, [['00000002', 40], ['Testfirma', 110], ['Prøvevej 391', 260], ['9800 Hjørring', 420], ['Ikke fast', 540], ['20112233', 620]]),
    ...it(1, 728, [['ApS', 110]]),
    ...it(1, 715, [['00000003', 40], ['Hans', 110], ['Dahl', 133], ['Parken 28, st. th', 260], ['9850 Hirtshals', 420], ['Hver 8. uge', 540]]),
    ...it(1, 30, [['Side 1 af 2', 300]]),
    ...it(2, 760, H),
    ...it(2, 740, [['00000005', 40], ['Eva Prøve', 110], ['Bakken 38', 260], ['9881 Bindslev', 420], ['Hver 4. uge', 540], ['40 58 99 76', 620]]),
  ];
  const t = I.pdfItemsToTable(items);
  assert.deepEqual(t.headers, H.map((h) => h[0]));
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0][1], 'Testfirma ApS');
  assert.equal(t.rows[1][1], 'Hans Dahl');
  assert.equal(t.rows[2][5], '40 58 99 76');
  const m = I.guessMapping(t.headers); assert.equal(m.zip, 3); assert.equal(m.intervalWeeks, 4); assert.equal(m.name, 1);
});
