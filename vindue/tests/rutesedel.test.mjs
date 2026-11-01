import test from 'node:test';
import assert from 'node:assert/strict';
import * as RS from '../js/rutesedel.js';
import { seedDb } from '../js/seed.js';
import { uid } from '../js/services.js';

// Opdigtet rutesedel med samme kolonnepositioner som SkvizBiz (liggende A4)
const t = (page, y, x, str, w) => ({ str, x, y, w: w ?? str.length * 4.4, page });
const H = [['Nr', 33.6], ['Kl.', 48.2], ['Adresse', 104.9], ['By', 218.3], ['Navn', 289.1], ['Tlf.', 402.5], ['Kont.', 447.9], ['Beløb', 479.5], ['Bemærkninger', 507.4], ['Opgaver', 635], ['Tid', 798.7]];
const ITEMS = [t(1, 544, 31.2, '27/09-2026 søndag uge 39 - Rute: Erhverv'), t(1, 526, 31.2, 'Udskrevet den 20/09-2026 kl. 21:10:20'), ...H.map(([s, x]) => t(1, 504.5, x, s)),
  t(1, 493, 38.1, '1'), t(1, 493, 104.9, 'Torvet 1'), t(1, 493, 218.3, '9800 Hjørring'), t(1, 493, 289.1, 'Fiktiv Tandklinik ApS'), t(1, 493, 477.3, '390,00', 24.5), t(1, 493, 635, 'Butiksruder (2u)'), t(1, 493, 790.7, '00:30', 20),
  t(1, 481, 38.1, '2'), t(1, 481, 104.9, 'Havnen 2'), t(1, 481, 218.3, '9850 Hirtshals Café Prøvehavn', 139), t(1, 481, 470.6, '1.280,00', 31.1), t(1, 481, 507.4, 'Husk stige'), t(1, 481, 635, 'Butiksruder (2u)'), t(1, 481, 790.7, '00:20', 20),
  t(1, 469.5, 635, 'Tagrender renses på bagsiden og'), t(1, 469.5, 790.7, '01:00', 20), t(1, 458, 635, 'ved skuret (engangsopgave)'),
  t(1, 446, 38.1, '3'), t(1, 446, 104.9, 'Ukendtvej 1'), t(1, 446, 218.3, '9999 Intetsteds'), t(1, 446, 289.1, 'Findes Ikke'), t(1, 446, 477.3, '100,00', 24.5), t(1, 446, 635, 'Vinduesvask (4u)'), t(1, 446, 790.7, '00:10', 20),
  t(1, 30, 400, 'Side 1 af 1')];

test('rutesedel: titel, rækker, flerlinjede opgaver, engangsopgave, by+navn i ét stykke', () => {
  const r = RS.parseRouteSheetItems(ITEMS);
  assert.equal(r.date, '2026-09-27'); assert.equal(r.routeName, 'Erhverv'); assert.equal(r.rows.length, 3);
  assert.deepEqual([r.rows[1].city, r.rows[1].name], ['9850 Hirtshals', 'Café Prøvehavn']);
  assert.equal(r.rows[1].totalNum, 1280);
  assert.deepEqual(r.rows[1].tasks.map((x) => [x.service, x.intervalWeeks, x.once, x.durationMin]), [['Butiksruder', 2, false, 20], ['Tagrender renses på bagsiden og ved skuret', 0, true, 60]]);
});

test('rutesedel → besøg på rutesedlens dato; ukendte kunder springes over; ingen dobbelt-besøg', () => {
  const db = seedDb('2026-11-02'); db.visits = db.visits.filter((v) => v.plannedDate >= '2026-11-02'); // som i virkeligheden: næste besøg ligger efter den åbne rute
  const sh = { ...RS.parseRouteSheetItems(ITEMS), fileName: 'x.pdf' }; sh.targetDate = sh.date;
  const plan = RS.buildSheetPlan(db, [sh], { today: '2026-11-02' });
  assert.deepEqual(plan.items.map((x) => x.action), ['visit', 'visit', 'oneoff']);
  assert.ok(plan.issues.some((i) => !i.warn && /Findes Ikke/.test(i.msg)));
  const n = RS.applySheetPlan(db, plan, { uid }); assert.equal(n, 3);
  const vs = db.visits.filter((v) => v.fromSheet && v.plannedDate === '2026-09-27');
  assert.equal(vs.length, 3); assert.ok(vs.every((v) => db.routes.find((r) => r.id === v.routeId)?.name === 'Erhverv'));
  const one = db.agreements.find((g) => g.fromSheet); assert.equal(one.intervalWeeks, 0); assert.equal(one.price, 0, 'ukendt pris når rækken har flere opgaver');
  // samme rutesedel igen giver ingen nye besøg på faste aftaler
  const again = RS.buildSheetPlan(db, [sh], { today: '2026-11-02' });
  assert.deepEqual(again.items.slice(0, 2).map((x) => x.action), ['skip', 'skip']);
});
