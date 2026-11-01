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

// Opdigtet ruteoversigt med samme kolonnepositioner som SkvizBiz (liggende A4)
const RH = [['Nr', 35.4], ['Kundenavn', 51], ['Adresse', 164.4], ['Postnr. / by', 277.8], ['Tlf', 377], ['Noter', 433.7], ['Aftaler', 532.9], ['Interval', 660.5], ['Ex. moms', 731.3], ['Tid', 797.2]];
const ov = (page, y0, rows) => { const it = [t(page, 556, 168.8, 'Komplet ruteoversigt for "Bindslev 2" (udskrevet fra SkvizBiz den 01/11-2026)'), ...RH.map(([s, x]) => t(page, 529.6, x, s))]; let y = 515.9;
  for (const r of rows) { it.push(t(page, y, 40.9, String(r.nr)), t(page, y, 51, r.name), t(page, y, 164.4, r.street), t(page, y, 277.8, r.zip), t(page, y, 377, r.tlf));
    r.notes.forEach((n, i) => it.push(t(page, y - 0.3 - i * 11.3, 433.7, n)));
    r.agr.forEach(([s, iv, pr, ti], i) => { const yy = y - 0.3 - i * 11.6; if (s) it.push(t(page, yy, 532.9, s)); if (iv) it.push(t(page, yy, 660.5, iv)); if (pr) it.push({ str: pr, x: 773.9 - pr.length * 4.1, y: yy, w: pr.length * 4.1, page }); if (ti) it.push({ str: ti, x: 790.7, y: yy, w: 20, page }); });
    y -= 11.3 * Math.max(r.notes.length, r.agr.length, 1); }
  return it; };
const OV = [...ov(1, 0, [{ nr: 1, name: 'Karin Test', street: 'Testvej 7', zip: '9850 Hirtshals', tlf: '20112233', notes: ['Alt på huset'], agr: [['Vinduesvask', 'Hver 4. uge', '1.320,00', '01:21']] },
  { nr: 2, name: 'Ny Rutekunde', street: 'Rutevej 1', zip: '9881 Bindslev', tlf: '30112233', notes: ['Alt udv. på stuehuset i', 'stueplan'], agr: [['Udvendig vinduespolering iflg.', 'Hver 8. uge', '160,00', '00:15'], ['aftale', '', '', ''], ['+ Orangeriet', 'Hver 8. uge', '96,00', '00:09']] }]),
  ...ov(2, 0, [{ nr: 3, name: 'Hans Prøvesen', street: 'Prøveparken 28, st. th', zip: '9850 Hirtshals', tlf: '', notes: [], agr: [['Vinduesvask', 'Hver 8. uge', '96,00', '00:05']] }])];

test('ruteoversigt: rækker, ombrudte noter/aftaler, flere sider', () => {
  const r = SD.parseRouteOverviewItems(OV);
  assert.equal(r.routeName, 'Bindslev 2'); assert.equal(r.rows.length, 3);
  assert.equal(r.rows[1].notes, 'Alt udv. på stuehuset i stueplan');
  assert.deepEqual(r.rows[1].agreements.map((a) => [a.service, a.interval, a.price, a.dur]), [['Udvendig vinduespolering iflg. aftale', 'Hver 8. uge', '160,00', '00:15'], ['+ Orangeriet', 'Hver 8. uge', '96,00', '00:09']]);
  assert.equal(r.rows[0].agreements[0].price, '1.320,00');
});

test('stamdata + ruteoversigt → ny rute, rækkefølge, kunder kun i ruteoversigt', () => {
  const db = seedDb('2026-11-02');
  const plan = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(ITEMS) }], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(plan, [{ ...SD.parseRouteOverviewItems(OV), fileName: 'r.pdf' }], db, { today: '2026-11-02' });
  assert.equal(plan.newRoutes.length, 1); const nr = plan.newRoutes[0];
  assert.deepEqual([nr.name, nr.intervalWeeks, nr.anchorDate, nr.matched], ['Bindslev 2', 4, '2026-12-15', 2]);
  assert.equal(plan.customers.length, 4); // 3 fra stamdata + 1 kun i ruteoversigt
  const ids = SD.materializeRoutes(db, plan, { uid, today: '2026-11-02', employeeId: 'e2', batchId: 'b' });
  const rid = ids['new:Bindslev 2']; const route = db.routes.find((r) => r.id === rid);
  const ny = plan.customers.find((c) => c.name === 'Ny Rutekunde'); assert.equal(ny.addresses[0].agreements[0].routeId, rid); assert.equal(ny.addresses[0].agreements[0].anchorDate, '2026-12-15');
  const karin = plan.customers.find((c) => c.name === 'Karin Test'); assert.equal(karin.addresses[0].agreements[1].routeId, null, '"Ikke fast" får ingen rute');
  I.applyImportPlan(db, plan, { batchId: 'b', uid, horizon: '2027-03-01', today: '2026-11-02' });
  SD.applyRouteOrder(db, plan, ids);
  const order = route.order.map((aid) => db.customers.find((c) => c.id === db.addresses.find((a) => a.id === aid).customerId).name);
  assert.deepEqual(order, ['Karin Test', 'Ny Rutekunde', 'Hans Prøvesen']);
  I.rollbackImport(db, 'b'); assert.ok(!db.routes.some((r) => r.id === rid), 'ruten fjernes ved fortryd');
});

test('ruteoversigt importeret EFTER kunderne sætter rute + rækkefølge på eksisterende kunder', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = []; db.routes = [];
  const p1 = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(ITEMS) }], null, db, { today: '2026-11-02' });
  I.applyImportPlan(db, p1, { batchId: 'a', uid, horizon: '2027-03-01', today: '2026-11-02' });
  assert.ok(db.agreements.every((g) => !g.routeId));
  const p2 = SD.buildSkvizPlan([], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(p2, [{ ...SD.parseRouteOverviewItems(OV), fileName: 'r.pdf' }], db, { today: '2026-11-02' });
  assert.equal(p2.routeUpdates.length, 2, 'Karin + Hans findes allerede'); assert.equal(p2.customers.length, 1, 'kun den nye rutekunde');
  assert.equal(p2.newRoutes[0].anchorDate, '2026-12-15');
  const ids = SD.materializeRoutes(db, p2, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'b' });
  I.applyImportPlan(db, p2, { batchId: 'b', uid, horizon: '2027-03-01', today: '2026-11-02' });
  assert.equal(SD.applyRouteUpdates(db, p2, ids), 2); SD.applyRouteOrder(db, p2, ids);
  const rid = ids['new:Bindslev 2']; const r = db.routes.find((x) => x.id === rid);
  const karin = db.customers.find((c) => c.name === 'Karin Test');
  assert.equal(db.agreements.filter((g) => g.customerId === karin.id && g.intervalWeeks).every((g) => g.routeId === rid), true);
  assert.ok(db.visits.filter((v) => v.customerId === karin.id && v.status === 'planlagt' && v.agreementId === db.agreements.find((g) => g.customerId === karin.id && g.intervalWeeks).id).every((v) => v.routeId === rid));
  assert.deepEqual(r.order.map((aid) => db.customers.find((c) => c.id === db.addresses.find((a) => a.id === aid).customerId).name), ['Karin Test', 'Ny Rutekunde', 'Hans Prøvesen']);
});

test('reparation: tomme ruter fra tidligere import får rytme, dato og kunder; reserve-match på adresse', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = [];
  db.routes = [{ id: 'old', name: 'Bindslev 2', employeeId: 'e1', intervalWeeks: 4, anchorDate: '2026-11-02' }]; // tom rute med forkert dato
  const p1 = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(ITEMS) }], null, db, { today: '2026-11-02' });
  I.applyImportPlan(db, p1, { batchId: 'a', uid, horizon: '2027-03-01', today: '2026-11-02' });
  db.customers.find((c) => c.name === 'Hans Prøvesen').name = 'Hans J. Prøvesen'; // navn stavet anderledes
  const p2 = SD.buildSkvizPlan([], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(p2, [{ ...SD.parseRouteOverviewItems(OV), fileName: 'r.pdf' }], db, { today: '2026-11-02' });
  assert.equal(p2.newRoutes.length, 0); assert.equal(p2.resetRoutes.length, 1); assert.equal(p2.routeUpdates.length, 2);
  assert.ok(p2.issues.some((i) => /koblet til "Hans J. Prøvesen" på adressen/.test(i.msg)));
  const ids = SD.materializeRoutes(db, p2, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'b' });
  assert.equal(db.routes[0].anchorDate, '2026-12-15');
  I.applyImportPlan(db, p2, { batchId: 'b', uid, horizon: '2027-03-01', today: '2026-11-02' });
  SD.applyRouteUpdates(db, p2, ids); SD.applyRouteOrder(db, p2, ids);
  assert.equal(db.routes[0].order.length, 3);
  assert.equal(db.agreements.filter((g) => g.routeId === 'old').length, 4); // Karin 1 + Hans 1 + ny rutekunde 2
});

test('kunde uden telefon: e-mail havner ikke i telefonfeltet', () => {
  const it = [t(1, 763, L, 'Kundenr. 00000010 - Testfirma'), t(1, 750, L, 'Leveringsadresse:'), t(1, 750, R, 'Faktureringsadresse:'), t(1, 739, L, 'Testfirma'), t(1, 728, L, 'Vej 1'), t(1, 717, L, '9800 Hjørring'),
    t(1, 694, L, 'Tlf.: post@example.dk'), t(1, 694, R, 'Betalingsbetingelser: d.d. + 8 dage')];
  const [c] = SD.parseStamdataItems(it); assert.equal(c.phone, ''); assert.equal(c.email, 'post@example.dk');
});

test('lang aftalebeskrivelse lander ikke i interval-kolonnen', () => {
  const base = [t(1, 763, L, 'Kundenr. 00000050 - Test Lade'), t(1, 750, L, 'Leveringsadresse:'), t(1, 750, R, 'Faktureringsadresse:'), t(1, 739, L, 'Test Lade'), t(1, 728, L, 'Vej 2'), t(1, 717, L, '9870 Sindal'),
    t(1, 694, L, 'Tlf.: 20112233'), t(1, 694, R, 'Betalingsbetingelser: d.d. + 8 dage'),
    t(1, 660, L, 'Aftaler med kunden'), t(1, 660, 286.3, 'Interval'), t(1, 660, 357.2, 'Næste gang'), t(1, 660, 428.2, 'Pris ex moms'), t(1, 660, 520.7, 'Tid'),
    { str: 'Den ene side af laden, som vender ud mod vejen. På huset er taget tæt på tagrenden og', x: 59.5, y: 648, w: 420, page: 1 },
    t(1, 648, 286.3, 'Hver 8. uge'), t(1, 648, 357.2, '15/12-2026'), { str: 'kr. 400,00', x: 448.8, y: 648, w: 44.5, page: 1 }, t(1, 648, 516.3, '0:30'),
    { str: 'skal derfor gøres med stige', x: 59.5, y: 637, w: 120, page: 1 }];
  const [c] = SD.parseStamdataItems(base);
  assert.equal(c.agreements.length, 1); assert.equal(c.agreements[0].interval, 'Hver 8. uge');
  assert.match(c.agreements[0].service, /^Den ene side af laden.*stige$/);
});

// En kunde med aftaler på to ruter (som Inge Sørensen) og en kunde med aftale på anden adresse (som Esther Volhøj)
const ovT = (title, rows) => { const it = [t(1, 556, 168.8, `Komplet ruteoversigt for "${title}" (udskrevet fra SkvizBiz den 01/11-2026)`), ...RH.map(([s, x]) => t(1, 529.6, x, s))]; let y = 515.9;
  for (const r of rows) { it.push(t(1, y, 40.9, String(r.nr)), t(1, y, 51, r.name), t(1, y, 164.4, r.street), t(1, y, 277.8, r.zip), t(1, y, 377, '20112233'));
    r.agr.forEach(([s, iv, pr, ti], i) => { const yy = y - 0.3 - i * 11.6; it.push(t(1, yy, 532.9, s), t(1, yy, 660.5, iv), { str: pr, x: 773.9 - pr.length * 4.1, y: yy, w: pr.length * 4.1, page: 1 }, { str: ti, x: 790.7, y: yy, w: 20, page: 1 }); });
    y -= 11.6 * Math.max(r.agr.length, 1); }
  return { ...SD.parseRouteOverviewItems(it), fileName: title + '.pdf' }; };
const STAM2 = [...kunde(2, 763, '00000020', 'Hjørring Fast', ['Fastvej 1', '9800 Hjørring'], [], [['Vinduesvask', 'Hver 4. uge', '07/12-2026', 'kr. 150,00', '0:10']]),
  ...kunde(2, 560, '00000021', 'Tag Fast', ['Tagvej 2', '9800 Hjørring'], [], [['Tagrender', 'Hver 52. uge', '08/12-2026', 'kr. 300,00', '0:30']]),...kunde(1, 763, '00000009', 'Inge Prøve', ['Skovvej 31', '9800 Hjørring'], ['Alt på huset'], [['Vinduesvask', 'Hver 4. uge', '07/12-2026', 'kr. 180,00', '0:15'], ['Tagrenderens', 'Hver 52. uge', '08/12-2026', 'kr. 200,00', '0:20']]),
  ...kunde(1, 560, '00000005', 'Esther Test', ['Bakken 38', '9881 Bindslev'], [], [['Vinduesvask', 'Hver 4. uge', '09/12-2026', 'kr. 276,00', '0:13'], ['Vinduesvask Doravej 5', 'Hver 4. uge', '09/12-2026', 'kr. 232,00', '0:13']])];
// Rækkerne viser ALLE kundens aftaler – ruten afgøres af datoerne. Andre kunder fastlægger rutedagene.
const INGE_AGR = [['Vinduesvask', 'Hver 4. uge', '180,00', '00:15'], ['Tagrenderens', 'Hver 52. uge', '200,00', '00:20']];
const OV_H = ovT('Hjørring', [{ nr: 1, name: 'Inge Prøve', street: 'Skovvej 31', zip: '9800 Hjørring', agr: INGE_AGR }, { nr: 2, name: 'Hjørring Fast', street: 'Fastvej 1', zip: '9800 Hjørring', agr: [['Vinduesvask', 'Hver 4. uge', '150,00', '00:10']] }]);
const OV_T = ovT('Tagrenderens', [{ nr: 1, name: 'Inge Prøve', street: 'Skovvej 31', zip: '9800 Hjørring', agr: INGE_AGR }, { nr: 2, name: 'Tag Fast', street: 'Tagvej 2', zip: '9800 Hjørring', agr: [['Tagrender', 'Hver 52. uge', '300,00', '00:30']] }]);
const OV_B = ovT('Bindslev 2', [{ nr: 1, name: 'Esther Test', street: 'Bakken 38', zip: '9881 Bindslev', agr: [['Vinduesvask', 'Hver 4. uge', '276,00', '00:13']] },
  { nr: 2, name: 'Esther Test', street: 'Doravej 5', zip: '9881 Bindslev', agr: [['Vinduesvask Doravej 5', 'Hver 4. uge', '232,00', '00:13']] }]);

test('aftaler kobles til hver sin rute; aftale på anden adresse flyttes dertil', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = []; db.routes = [];
  const plan = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(STAM2) }], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(plan, [OV_T, OV_H, OV_B], db, { today: '2026-11-02' }); // bemærk: Tagrenderens læses før Hjørring
  assert.equal(plan.customers.length, 4, 'ingen dubletter');
  const ids = SD.materializeRoutes(db, plan, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'x' });
  I.applyImportPlan(db, plan, { batchId: 'x', uid, horizon: '2027-03-01', today: '2026-11-02' }); SD.applyRouteOrder(db, plan, ids);
  const rn = (id) => db.routes.find((r) => r.id === id)?.name;
  const inge = db.customers.find((c) => c.name === 'Inge Prøve'); const ia = db.agreements.filter((g) => g.customerId === inge.id);
  assert.deepEqual(ia.map((g) => [g.service, rn(g.routeId)]), [['Vinduesvask', 'Hjørring'], ['Tagrenderens', 'Tagrenderens']]);
  const est = db.customers.find((c) => c.name === 'Esther Test'); const ads = db.addresses.filter((a) => a.customerId === est.id);
  assert.equal(ads.length, 2); assert.match(ads[1].street, /^Doravej 5/);
  const dora = db.agreements.find((g) => g.service === 'Vinduesvask Doravej 5'); assert.equal(dora.addressId, ads[1].id); assert.equal(rn(dora.routeId), 'Bindslev 2');
  assert.ok(db.visits.filter((v) => v.agreementId === dora.id).every((v) => v.addressId === ads[1].id));
  const b2 = db.routes.find((r) => r.name === 'Bindslev 2'); assert.deepEqual(b2.order, [ads[0].id, ads[1].id]);
  assert.ok(db.visits.some((v) => v.customerId === inge.id && v.plannedDate === '2026-12-07' && rn(v.routeId) === 'Hjørring'));
});

test('samme rettelse når ruteoversigter importeres efter kunderne', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = []; db.routes = [];
  const p1 = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(STAM2) }], null, db, { today: '2026-11-02' });
  I.applyImportPlan(db, p1, { batchId: 'a', uid, horizon: '2027-03-01', today: '2026-11-02' });
  const p2 = SD.buildSkvizPlan([], null, db, { today: '2026-11-02' }); SD.addRouteOverviews(p2, [OV_T, OV_H, OV_B], db, { today: '2026-11-02' });
  assert.equal(p2.customers.length, 0);
  const ids = SD.materializeRoutes(db, p2, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'b' });
  SD.applyRouteUpdates(db, p2, ids, uid); SD.applyRouteOrder(db, p2, ids);
  const rn = (id) => db.routes.find((r) => r.id === id)?.name;
  assert.equal(rn(db.agreements.find((g) => g.service === 'Vinduesvask' && g.price === 180).routeId), 'Hjørring');
  assert.equal(rn(db.agreements.find((g) => g.service === 'Tagrenderens').routeId), 'Tagrenderens');
  const dora = db.agreements.find((g) => g.service === 'Vinduesvask Doravej 5');
  assert.match(db.addresses.find((a) => a.id === dora.addressId).street, /^Doravej 5/); assert.equal(rn(dora.routeId), 'Bindslev 2');
});

// To kunder med samme navn: leveringskonto (Stabækvej, faktureres via betaler) + betalerkonto (Mosevej) – som "Landbrug ved Johnny Jørgensen"
const kundeB = (page, y0, no, name, addr, bill, agr) => { const it = kunde(page, y0, no, name, addr, [], agr);
  // erstat faktureringsadresse-kolonnen med betalerens adresse
  return it.map((x) => (x.x === R && addr.includes(x.str) ? { ...x, str: bill[addr.indexOf(x.str)] } : x)); };
const STAM3 = [...kundeB(1, 763, '00000038', 'Landbrug Test', ['Stabækvej 1', '9800 Hjørring'], ['Mosevej 9', '9870 Sindal'], [['Rens af staldbygninger', 'Hver 4. uge', '11/11-2026', 'kr. 840,00', '0:55']]),
  ...kunde(1, 560, '00000730', 'Landbrug Test', ['Mosevej 9', '9870 Sindal'], [], [['Vinduesvask', 'Hver 4. uge', '07/12-2026', 'kr. 300,00', '0:20']]),
  ...kunde(2, 763, '00000040', 'Bind Fast', ['Bvej 1', '9881 Bindslev'], [], [['Vinduesvask', 'Hver 4. uge', '11/11-2026', 'kr. 100,00', '0:10']]),
  ...kunde(2, 560, '00000041', 'Myg Fast', ['Mvej 1', '9870 Sindal'], [], [['Vinduesvask', 'Hver 4. uge', '07/12-2026', 'kr. 100,00', '0:10']])];
const LB_AGR = [['Rens af staldbygninger', 'Hver 4. uge', '840,00', '00:55'], ['Vinduesvask', 'Hver 4. uge', '300,00', '00:20']];
const OV_B2 = ovT('Bindslev 2', [{ nr: 1, name: 'Bind Fast', street: 'Bvej 1', zip: '9881 Bindslev', agr: [['Vinduesvask', 'Hver 4. uge', '100,00', '00:10']] }, { nr: 2, name: 'Landbrug Test', street: 'Mosevej 9', zip: '9870 Sindal', agr: LB_AGR }]);
const OV_M2 = ovT('Mygdal 2', [{ nr: 1, name: 'Landbrug Test', street: 'Mosevej 9', zip: '9870 Sindal', agr: LB_AGR }, { nr: 2, name: 'Myg Fast', street: 'Mvej 1', zip: '9870 Sindal', agr: [['Vinduesvask', 'Hver 4. uge', '100,00', '00:10']] }]);

test('to kunder med samme navn (leveringskonto + betaler): aftaler på hver sin rute, ingen enkeltbesøg, betaler koblet', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = []; db.routes = [];
  const plan = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(STAM3) }], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(plan, [OV_M2, OV_B2], db, { today: '2026-11-02' });
  assert.equal(plan.customers.length, 4);
  const ids = SD.materializeRoutes(db, plan, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'x' });
  I.applyImportPlan(db, plan, { batchId: 'x', uid, horizon: '2027-03-01', today: '2026-11-02' }); SD.applyRouteOrder(db, plan, ids);
  assert.equal(SD.linkBillingFromStamdata(db, plan), 1);
  const rn = (id) => db.routes.find((r) => r.id === id)?.name;
  const stald = db.agreements.find((g) => g.price === 840), vask = db.agreements.find((g) => g.price === 300);
  assert.equal(rn(stald.routeId), 'Bindslev 2'); assert.equal(rn(vask.routeId), 'Mygdal 2');
  assert.ok(!db.visits.some((v) => !v.routeId), 'ingen enkeltbesøg');
  const lev = db.customers.find((c) => c.customerNo === '00000038'), bet = db.customers.find((c) => c.customerNo === '00000730');
  assert.equal(lev.billTo, bet.id);
  const b2 = db.routes.find((r) => r.name === 'Bindslev 2'); assert.equal(db.addresses.find((a) => a.id === b2.order[1]).customerId, lev.id, 'Bindslev 2 viser leveringsadressen');
});

test('ruteoversigt med forkortede navne ("Andelsboligforeningen Museu...") kobles til rette kunde og rute', () => {
  const db = seedDb('2026-11-02'); db.customers = []; db.addresses = []; db.agreements = []; db.visits = []; db.routes = [];
  const STAM4 = [...kunde(1, 763, '00000018', 'Andelsboligforeningen Museumsgade/Akseltorv V/ Kirsten Dalsgaard', ['Museumsgade 6, st.', '9800 Hjørring'], [],
      [['Tagrenderens Museumsgade 4', 'Hver 52. uge', '27/09-2027', 'kr. 496,00', '0:30'], ['Tagrenderens Museumsgade 6', 'Hver 52. uge', '27/09-2027', 'kr. 675,00', '0:30']]),
    ...kunde(1, 560, '00000020', 'C/O Ejerforeningen Esben Veng-Christensen', ['Kongensgade 6', '9800 Hjørring'], [], [['Tagrenderens', 'Hver 52. uge', '27/09-2027', 'kr. 898,00', '1:00']])];
  const OV = ovT('Tagrenderens', [{ nr: 1, name: 'Andelsboligforeningen Museu...', street: 'Museumsgade 6, st.', zip: '9800 Hjørring', agr: [['Tagrenderens Museumsgade 4', 'Hver 52. uge', '496,00', '00:30'], ['Tagrenderens Museumsgade 6', 'Hver 52. uge', '675,00', '00:30']] },
    { nr: 2, name: 'C/O Ejerforeningen Esben Ve...', street: 'Kongensgade 6', zip: '9800 Hjørring', agr: [['Tagrenderens', 'Hver 52. uge', '898,00', '01:00']] }]);
  const plan = SD.buildSkvizPlan([{ fileName: 'alle.pdf', routeId: '', customers: SD.parseStamdataItems(STAM4) }], null, db, { today: '2026-11-02' });
  SD.addRouteOverviews(plan, [OV], db, { today: '2026-11-02' });
  assert.equal(plan.customers.length, 2, 'ingen dubletter fra forkortede navne');
  const ids = SD.materializeRoutes(db, plan, { uid, today: '2026-11-02', employeeId: 'e1', batchId: 'x' });
  I.applyImportPlan(db, plan, { batchId: 'x', uid, horizon: '2028-01-01', today: '2026-11-02' });
  assert.ok(db.agreements.every((g) => db.routes.find((r) => r.id === g.routeId)?.name === 'Tagrenderens'));
});
