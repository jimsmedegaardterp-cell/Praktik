// Kør: node --test vindue/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/domain.js';
import * as S from '../js/services.js';
import * as O from '../js/optimizer.js';

const admin = { id: 'u1', role: 'admin', employeeId: 'e1' };
const START = '2027-03-01'; // mandag
// To 4-ugers ruter: A mandag (overfyldt), B onsdag samme uge (halvtom). Tagrender tirsdag (fast).
function mkDb() {
  const db = S.emptyDb();
  db.routes = [
    { id: 'A', name: 'Nord', intervalWeeks: 4, anchorDate: '2027-03-01', order: [] },
    { id: 'B', name: 'Syd', intervalWeeks: 4, anchorDate: '2027-03-03', order: [] },
    { id: 'T', name: 'Tagrenderens', intervalWeeks: 4, anchorDate: '2027-03-02', order: [] },
    { id: 'C', name: 'Langt væk', intervalWeeks: 4, anchorDate: '2027-03-15', order: [] }, // uden for vinduet
  ];
  const add = (i, routeId, lat, lng, dur, interval = 4) => {
    const r = db.routes.find((x) => x.id === routeId);
    db.addresses.push({ id: 'ad' + i, customerId: 'c' + i, street: 'Vej ' + i, lat, lng });
    db.agreements.push({ id: 'ag' + i, customerId: 'c' + i, addressId: 'ad' + i, routeId, service: 'Vinduer', price: 200, intervalWeeks: interval, durationMin: dur, anchorDate: r.anchorDate, seasonMonths: [], active: true });
    r.order.push('ad' + i);
  };
  // A: 20 kunder á 30 min = 10 t arbejde. B: 4 kunder á 30 min. Alle tæt på hinanden.
  for (let i = 0; i < 20; i++) add(i, 'A', 57.47 + i * 0.001, 10.2, 30);
  for (let i = 20; i < 24; i++) add(i, 'B', 57.47 + i * 0.001, 10.2, 30);
  for (let i = 24; i < 28; i++) add(i, 'T', 57.47, 10.21, 60);
  add(28, 'A', 57.48, 10.2, 30, 8); // 8-ugers kunde på 4-ugers rute
  S.planAhead(db, '2027-12-31', '2027-01-01');
  return db;
}
const opts = { start: START, startPoint: { lat: 57.47, lng: 10.2 }, excludeRouteIds: ['T'], timeMs: 2000 };

test('optimering: byg problem – vindue, interval, udelukket rute', () => {
  const P = O.buildProblem(mkDb(), opts);
  assert.equal(P.items.length, 25, 'kun A og B er flytbare');
  const it = P.items.find((x) => x.key === 'ad0|A|2027-03-01');
  assert.ok(it.cands.every((c) => c.routeId !== 'T' && c.routeId !== 'C'), 'ikke til tagrender, ikke uden for vinduet');
  assert.ok(it.cands.some((c) => c.routeId === 'B' && c.shift === 2));
  assert.ok(it.cands.every((c) => c.shift >= -4 && c.shift <= 10));
  assert.equal(it.cur.length, 3, '3 besøg på 12 uger');
  assert.ok(P.fixed.some((f) => f.date === '2027-03-02'), 'tagrenderens tid tæller med');
  const eight = P.items.find((x) => x.key === 'ad28|A|2027-03-01'); assert.ok(eight.cands.length > 0 && eight.cur.length === 2);
});

test('optimering: flytter fra overfyldt til halvtom dag og respekterer vinduet', () => {
  const db = mkDb(); const P = O.buildProblem(db, opts);
  const r = O.runOptimizer(P);
  assert.ok(r.moves.length > 0);
  assert.ok(r.after.objective < r.before.objective);
  assert.ok(r.after.over < r.before.over, `overtid ${r.before.over} → ${r.after.over}`);
  const tot = (s, d) => (s.perDate[d] ? s.perDate[d].work + s.perDate[d].drive : 0);
  assert.ok(tot(r.after, '2027-03-01') <= 480 + 30 && tot(r.before, '2027-03-01') > 600);
  for (const m of r.moves) { assert.ok(['A', 'B'].includes(m.toRoute)); assert.ok(m.shift >= -4 && m.shift <= 10); }
  assert.ok(r.moves.some((m) => m.toRoute === 'A' && m.toDate !== '2027-03-01'), 'egen rute på en tom dag');
  // delmængde
  const half = O.evaluate(P, r.moves.slice(0, 1)); assert.ok(half.objective > r.after.objective && half.objective < r.before.objective);
  assert.ok(O.dayStops(P, r.moves, '2027-03-03').length > 4);
});

test('optimering: gennemfør flytter aftaler, besøg og rækkefølge – data før startdato røres ikke', () => {
  const db = mkDb(); const P = O.buildProblem(db, opts); const r = O.runOptimizer(P);
  const past = db.visits.filter((v) => v.plannedDate < START).map((v) => v.id).sort();
  const it = P.items.find((x) => x.key === 'ad0|A|2027-03-01'); const c = it.cands.find((k) => k.routeId === 'B' && k.shift === 2);
  const m = { key: it.key, agreementIds: it.agreementIds, addressId: it.addressId, toRoute: 'B', shift: 2, anchors: Object.fromEntries(c.anchors) }; assert.ok(r.moves.length); const res = S.applyRouteMoves(db, admin, [m], START, '2027-12-31');
  assert.equal(res.moved, 1);
  const a = db.agreements.find((x) => x.id === m.agreementIds[0]);
  assert.equal(a.routeId, 'B'); assert.equal(a.anchorDate, D.addDays('2027-03-01', m.shift));
  const fut = db.visits.filter((v) => v.agreementId === a.id && v.plannedDate >= START);
  assert.ok(fut.length && fut.every((v) => v.routeId === 'B' && D.routeRuns(db.routes[1], v.rhythmDate)));
  assert.equal(new Set(db.visits.map((v) => v.id)).size, db.visits.length, 'ingen dubletter');
  assert.deepEqual(db.visits.filter((v) => v.plannedDate < START).map((v) => v.id).sort(), past);
  assert.ok(db.routes[1].order.includes(m.addressId) && !db.routes[0].order.includes(m.addressId));
  // planAhead bagefter danner ikke dubletter
  S.planAhead(db, '2028-06-30'); assert.equal(new Set(db.visits.map((v) => v.id)).size, db.visits.length);
});

test('optimering: dagsstraf', () => {
  assert.equal(O.dayPenalty(0), 0); assert.equal(O.dayPenalty(450), 0);
  assert.ok(O.dayPenalty(540) > O.dayPenalty(360));
});

test('optimering: forklaring – årsager og mulige flytninger', () => {
  const db = mkDb(); db.addresses.find((a) => a.id === 'ad21').lat = null; const P = O.buildProblem(db, opts); const r = O.runOptimizer(P);
  const ex = O.explain(P, r.moves, 'c21'); assert.match(ex[0].why, /koordinater/);
  const ex2 = O.explain(P, r.moves, 'c0'); assert.ok(ex2[0].opts.length > 0); assert.ok(ex2[0].why.some((w) => w.routeId === 'C' && /kører ikke/.test(w.why)));
  assert.ok(ex2[0].opts.every((o, i, a) => !i || a[i - 1].delta <= o.delta), 'sorteret');
  assert.match(O.explain(P, r.moves, 'c25')[0].why, /flyttes ikke/);
});

test('optimering: rutens dage tages fra kalenderen, og aftaler med forskellig dato flyttes hver for sig', () => {
  const db = mkDb(); db.routes.find((r) => r.id === 'B').anchorDate = '2027-03-24'; // forkert dato på ruten – besøgene ligger stadig onsdag 3/3
  db.addresses.push({ id: 'adx', customerId: 'cx', street: 'X', lat: 57.471, lng: 10.2 });
  for (const [id, anchor] of [['agx1', '2027-03-01'], ['agx2', '2027-03-15']]) db.agreements.push({ id, customerId: 'cx', addressId: 'adx', routeId: 'A', service: 'V', price: 1, intervalWeeks: 4, durationMin: 20, anchorDate: anchor, seasonMonths: [], active: true });
  S.planAhead(db, '2027-12-31', '2027-01-01');
  const P = O.buildProblem(db, opts);
  assert.ok(P.items.find((x) => x.key === 'ad0|A|2027-03-01').cands.some((c) => c.routeId === 'B' && c.shift === 2), 'B onsdag 3/3 som i kalenderen');
  const xs = P.items.filter((x) => x.customerId === 'cx'); assert.equal(xs.length, 2);
  assert.ok(xs.find((x) => x.ref === '2027-03-01').cands.some((c) => c.routeId === 'B'));
});

test('optimering: rute udført af en anden tæller ikke med og kan ikke modtage kunder', () => {
  const P = O.buildProblem(mkDb(), { ...opts, excludeRouteIds: [], ignoreRouteIds: ['T'] });
  assert.ok(!P.fixed.some((f) => f.date === '2027-03-02'), 'tagrenderens tid tæller ikke');
  assert.ok(P.items.every((it) => it.cands.every((c) => c.routeId !== 'T')));
  assert.match(O.explain(P, [], 'c25')[0].why, /en anden/);
});

test('optimering: hel rute flyttes til en dag hvor den passer bedre (Horne ons → fre efter Hjørring)', () => {
  const db = S.emptyDb();
  db.routes = [
    { id: 'F', name: 'Frederikshavn', intervalWeeks: 4, anchorDate: '2027-03-03', order: [] },
    { id: 'H', name: 'Horne', intervalWeeks: 4, anchorDate: '2027-03-03', order: [] },
    { id: 'J', name: 'Hjørring 2', intervalWeeks: 4, anchorDate: '2027-03-05', order: [] },
  ];
  let i = 0; const add = (rid, lat, lng, dur) => { const r = db.routes.find((x) => x.id === rid); i++;
    db.addresses.push({ id: 'ad' + i, customerId: 'c' + i, street: 'V' + i, lat, lng });
    db.agreements.push({ id: 'ag' + i, customerId: 'c' + i, addressId: 'ad' + i, routeId: rid, service: 'V', price: 200, intervalWeeks: 4, durationMin: dur, anchorDate: r.anchorDate, seasonMonths: [], active: true }); r.order.push('ad' + i); };
  for (let k = 0; k < 18; k++) add('F', 57.44 + k * 0.002, 10.53, 20);
  for (let k = 0; k < 8; k++) add('H', 57.55 + k * 0.002, 9.95, 15);
  for (let k = 0; k < 10; k++) add('J', 57.46 + k * 0.002, 9.98, 20);
  S.planAhead(db, '2027-12-31', '2027-01-01');
  const r = O.optimizeAll(db, { start: START, startPoint: { lat: 57.47, lng: 10.2 }, timeMs: 2000 });
  const tot = (s, d) => (s.perDate[d] ? s.perDate[d].work + s.perDate[d].drive : 0);
  assert.ok(tot(r.after, '2027-03-03') < tot(r.before, '2027-03-03') - 60, 'onsdag kortere');
  assert.ok(r.after.drive < r.before.drive, 'mindre kørsel');
  assert.ok(r.routeMoves.some((m) => m.routeId === 'H' && m.shift === 2) || r.moves.filter((m) => m.toRoute === 'J').length >= 6, JSON.stringify(r.routeMoves));
  // gennemfør og tjek at Horne nu ligger fredag og rutens dato er rettet
  const fm = O.finalMoves(r.P, r.moves); S.applyRouteMoves(db, { id: 'u1', role: 'admin' }, fm.moves, START, '2027-12-31', fm.routeAnchors);
  const hv = db.visits.filter((v) => v.plannedDate >= START && v.plannedDate < '2027-03-08' && ['F', 'H', 'J'].includes(v.routeId));
  assert.ok(!hv.some((v) => v.plannedDate === '2027-03-03' && v.addressId <= 'ad26' && Number(v.addressId.slice(2)) > 18), 'ingen Horne-kunder onsdag');
  assert.equal(new Set(db.visits.map((v) => v.id)).size, db.visits.length);
  if (r.routeMoves.length) assert.equal(db.routes.find((x) => x.id === 'H').anchorDate, '2027-03-05');
});

test('optimering: samme rute på to dage – nabokunder samles på én dag', () => {
  const db = S.emptyDb();
  db.routes = [{ id: 'M', name: 'Mygdal', intervalWeeks: 4, anchorDate: '2027-03-02', order: [] }, { id: 'X', name: 'Andet', intervalWeeks: 4, anchorDate: '2027-03-04', order: [] }];
  let i = 0; const add = (rid, anchor, lat, lng, dur) => { i++; db.addresses.push({ id: 'ad' + i, customerId: 'c' + i, street: 'V' + i, lat, lng });
    db.agreements.push({ id: 'ag' + i, customerId: 'c' + i, addressId: 'ad' + i, routeId: rid, service: 'V', price: 200, intervalWeeks: 4, durationMin: dur, anchorDate: anchor, seasonMonths: [], active: true }); };
  for (let k = 0; k < 10; k++) add('M', '2027-03-02', 57.52 + k * 0.001, 10.05, 20); // tirsdag
  for (let k = 0; k < 4; k++) add('M', '2027-03-04', 57.521 + k * 0.001, 10.051, 20); // torsdag – naboer
  for (let k = 0; k < 14; k++) add('X', '2027-03-04', 57.45 + k * 0.001, 10.3, 25); // torsdag – andet sted, fylder dagen
  S.planAhead(db, '2027-12-31', '2027-01-01');
  const r = O.optimizeAll(db, { start: START, startPoint: { lat: 57.47, lng: 10.2 }, timeMs: 2000 });
  const fm = O.finalMoves(r.P, r.moves);
  const moved = fm.moves.filter((m) => Number(m.addressId.slice(2)) >= 11 && Number(m.addressId.slice(2)) <= 14 && m.toDate === '2027-03-02');
  assert.equal(moved.length, 4, 'alle fire torsdagskunder til tirsdag: ' + JSON.stringify(r.routeMoves) + JSON.stringify(r.moves.map((m) => [m.addressId, m.toDate])));
  assert.ok(r.after.drive < r.before.drive);
  // uden ruteflytninger: naboerne flyttes samlet som enkeltkunder
  const r2 = O.optimizeAll(db, { start: START, startPoint: { lat: 57.47, lng: 10.2 }, timeMs: 2000 }, { routeShifts: {} });
  assert.equal(r2.moves.filter((m) => m.toDate === '2027-03-02' && Number(m.addressId.slice(2)) >= 11).length, 4);
});

test('optimering: dyb søgning (annealing) er aldrig dårligere end den hurtige', () => {
  const db = mkDb(); const base = { ...opts, excludeRouteIds: [], ignoreRouteIds: ['T'] };
  const a = O.optimizeAll(db, base); const b = O.optimizeAll(db, { ...base, saMs: 600 });
  assert.ok(b.after.objective <= a.after.objective + 1, `${b.after.objective} vs ${a.after.objective}`);
});

test('optimering: tom mandag og fire overfyldte dage – arbejdet fordeles og rykkes frem', () => {
  const db = S.emptyDb(); const days = ['2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05'];
  db.routes = days.map((d, k) => ({ id: 'R' + k, name: 'R' + k, intervalWeeks: 4, anchorDate: d, order: [] }));
  let i = 0;
  days.forEach((d, k) => { for (let j = 0; j < 22; j++) { i++; db.addresses.push({ id: 'ad' + i, customerId: 'c' + i, street: 'V' + i, lat: 57.40 + k * 0.05 + j * 0.001, lng: 10.0 + k * 0.08 });
    db.agreements.push({ id: 'ag' + i, customerId: 'c' + i, addressId: 'ad' + i, routeId: 'R' + k, service: 'V', price: 200, intervalWeeks: 4, durationMin: 20, anchorDate: d, seasonMonths: [], active: true }); } });
  S.planAhead(db, '2027-12-31', '2027-01-01');
  const r = O.optimizeAll(db, { start: START, startPoint: { lat: 57.47, lng: 10.2 }, maxDay: 450, saMs: 800 });
  const T = (s, d) => (s.perDate[d] ? s.perDate[d].work + s.perDate[d].drive : 0);
  const wk = ['2027-03-01', ...days];
  assert.ok(wk.some((d) => T(r.before, d) > 470), 'før: overfyldte dage');
  assert.ok(T(r.after, '2027-03-01') > 120, 'mandag bruges: ' + wk.map((d) => T(r.after, d)).join(','));
  assert.ok(wk.every((d) => T(r.after, d) <= 465), 'ingen dag over grænsen: ' + wk.map((d) => T(r.after, d)).join(','));
});

test('optimering: en flytning ændrer aldrig antallet af besøg (sæson og periodens slutning)', () => {
  const db = mkDb(); const r = db.routes.find((x) => x.id === 'B');
  db.addresses.push({ id: 'ads', customerId: 'cs', street: 'Sommerhus', lat: 57.5, lng: 10.2 });
  db.agreements.push({ id: 'ags', customerId: 'cs', addressId: 'ads', routeId: 'B', service: 'V', price: 1, intervalWeeks: 12, durationMin: 30, anchorDate: '2027-04-28', seasonMonths: [4, 5, 6, 7, 8, 9, 10, 11], active: true });
  S.planAhead(db, '2027-12-31', '2027-01-01');
  const P = O.buildProblem(db, { ...opts, start: '2027-04-26' });
  for (const it of P.items) for (const c of it.cands) assert.equal(c.occ.length, it.cur.length, it.key);
});
