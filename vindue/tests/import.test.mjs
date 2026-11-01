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
