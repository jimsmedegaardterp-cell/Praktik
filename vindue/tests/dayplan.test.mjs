import test from 'node:test';
import assert from 'node:assert/strict';
import * as DP from '../js/dayplan.js';

const P = (name, lat, lng) => ({ name, street: name, lat, lng });
const start = P('Hjem', 57.47, 10.2);
const stops = [P('A', 57.47, 10.3), P('B', 57.47, 10.21), P('C', 57.47, 10.25), P('D', 57.47, 10.35)];

test('lokal optimering: rækkefølge der ikke krydser', () => {
  const vs = stops.map((p, i) => ({ id: 'v' + i, p }));
  const order = DP.localOptimal(vs, (v) => v.p, start).map((id) => stops[+id.slice(1)].name).join('');
  assert.ok(order === 'BCAD' || order === 'DACB', order);
  const legs = DP.estimateLegs(['B', 'C', 'A', 'D'].map((n) => stops.find((s) => s.name === n)), start);
  assert.equal(legs.length, 5); assert.ok(DP.sumLegs(legs).sec > 0);
});

test('"som faste ruter": ruterne efter hinanden med fast rækkefølge', () => {
  const vs = [{ id: 1, routeId: 'r2', addressId: 'x' }, { id: 2, routeId: 'r1', addressId: 'b' }, { id: 3, routeId: 'r1', addressId: 'a' }];
  assert.deepEqual(DP.routeOrder(vs, [{ id: 'r1', order: ['a', 'b'] }, { id: 'r2' }]), [1, 3, 2]);
});

test('Google: opdeling i bidder af højst 24, sammenhængende ben og hjemtur til sidst', async () => {
  const many = Array.from({ length: 30 }, (_, i) => P('S' + i, 57.4 + i / 1000, 10.2));
  const calls = [];
  const fakeFetch = async (url, opt) => { const b = JSON.parse(opt.body); calls.push(b);
    assert.equal(opt.headers['X-Goog-Api-Key'], 'KEY'); assert.ok(b.intermediates.length <= 25);
    const n = b.intermediates.length; return { ok: true, json: async () => ({ routes: [{ optimizedIntermediateWaypointIndex: [...Array(n).keys()].reverse(), legs: Array.from({ length: n + 1 }, () => ({ duration: '60s', distanceMeters: 1000 })) }] }) }; };
  const r = await DP.googleDay('KEY', { start, stops: many, optimize: true }, fakeFetch);
  assert.equal(calls.length, 2);
  assert.deepEqual([...r.order].sort((a, b) => a - b), [...Array(30).keys()], 'alle stop med præcis én gang');
  assert.equal(r.legs.length, 31, 'ét ben pr. stop + hjemtur');
  assert.equal(calls[1].destination.location.latLng.latitude, start.lat, 'sidste bid slutter hjemme');
});

test('Google-fejl vises tydeligt', async () => {
  const bad = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) });
  await assert.rejects(DP.googleDay('X', { start, stops, optimize: true }, bad), /Google Maps: API key not valid/);
});

test('Google: åben slut (slut ved sidste kunde) og vejrute returneres', async () => {
  const some = Array.from({ length: 5 }, (_, i) => P('S' + i, 57.4 + i / 1000, 10.2));
  const calls = [];
  const fakeFetch = async (url, opt) => { const b = JSON.parse(opt.body); calls.push(b); const n = b.intermediates.length;
    return { ok: true, json: async () => ({ routes: [{ legs: Array.from({ length: n + 1 }, () => ({ duration: '60s', distanceMeters: 1000 })), polyline: { encodedPolyline: 'abc' } }] }) }; };
  const r = await DP.googleDay('KEY', { start, end: null, stops: some, optimize: false }, fakeFetch);
  assert.equal(calls[0].destination.location.latLng.latitude, some[4].lat, 'slutter ved sidste stop');
  assert.deepEqual(r.order, [0, 1, 2, 3, 4]); assert.equal(r.legs.length, 5, 'ingen hjemtur'); assert.deepEqual(r.polylines, ['abc']);
});
