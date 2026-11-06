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
  for (const m of r.moves) { assert.equal(m.toRoute, 'B'); assert.ok(m.shift >= -4 && m.shift <= 10); }
  // delmængde
  const half = O.evaluate(P, r.moves.slice(0, 1)); assert.ok(half.objective > r.after.objective && half.objective < r.before.objective);
  assert.ok(O.dayStops(P, r.moves, '2027-03-03').length > 4);
});

test('optimering: gennemfør flytter aftaler, besøg og rækkefølge – data før startdato røres ikke', () => {
  const db = mkDb(); const P = O.buildProblem(db, opts); const r = O.runOptimizer(P);
  const past = db.visits.filter((v) => v.plannedDate < START).map((v) => v.id).sort();
  const m = r.moves[0]; const res = S.applyRouteMoves(db, admin, [m], START, '2027-12-31');
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
