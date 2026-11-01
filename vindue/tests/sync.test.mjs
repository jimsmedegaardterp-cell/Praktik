import test from 'node:test';
import assert from 'node:assert/strict';
import * as SY from '../js/sync.js';
import { seedDb, freshDb } from '../js/seed.js';
import * as S from '../js/services.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('toRecords/applyRecords: rundtur giver samme data', () => {
  const db = seedDb('2026-11-02'); db.dayPlans = { '2026-11-02': { mode: 'optimal', order: ['a'] } }; db.vdraft = { v1: { result: 'udfoert' } }; db.imports = [{ batchId: 'b1', counts: {} }];
  const recs = SY.toRecords(db);
  const back = SY.applyRecords(freshDb(), clone(recs));
  for (const k of ['customers', 'addresses', 'agreements', 'routes', 'visits', 'employees']) assert.deepEqual(back[k].map((x) => x.id).sort(), db[k].map((x) => x.id).sort(), k);
  assert.deepEqual(back.dayPlans, db.dayPlans); assert.deepEqual(back.vdraft, db.vdraft); assert.equal(back.imports.length, 1);
  assert.deepEqual(back.templates, db.templates);
});

test('to enheder: admin uploader, medarbejder henter, ændrer besøg; admin får ændringen', async () => {
  const server = new SY.MemoryBackend(); const org = 'org1';
  const pc = seedDb('2026-11-02'); const pcSync = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' });
  const r1 = await pcSync.sync(pc); assert.ok(r1.pushed > 50); assert.equal(r1.pulled, 0);
  const phone = freshDb(); const phSync = new SY.SyncEngine({ backend: server.as('medarbejder'), state: { orgId: org }, role: 'medarbejder' });
  const r2 = await phSync.sync(phone); assert.equal(phone.customers.length, pc.customers.length); assert.equal(phone.visits.length, pc.visits.length); assert.ok(r2.pulled > 50);
  // medarbejder færdigmelder et besøg på telefonen
  const v = phone.visits.find((x) => x.routeId === 'r1' && x.status === 'planlagt');
  S.registerVisit(phone, { id: 'u2', role: 'medarbejder', employeeId: 'e2' }, v.id, { result: 'udfoert', opId: 'p1' });
  const r3 = await phSync.sync(phone); assert.ok(r3.pushed >= 2, 'besøg + audit');
  // admin henter
  await pcSync.sync(pc);
  assert.equal(pc.visits.find((x) => x.id === v.id).status, 'udfoert');
  assert.equal((await pcSync.sync(pc)).pushed, 0, 'intet at skubbe bagefter');
});

test('medarbejder skubber ikke kunde-ændringer (adgangsregler), admin sletter → forsvinder hos andre', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await aS.sync(a);
  const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder'), state: { orgId: org }, role: 'medarbejder' }); await mS.sync(m);
  m.customers[0].name = 'Ændret af medarbejder';
  assert.equal(mS.pending(m).filter((r) => r.kind === 'customer').length, 0);
  await mS.sync(m); await aS.sync(a); assert.notEqual(a.customers[0].name, 'Ændret af medarbejder');
  const gone = a.customers[1].id; S.deleteCustomer(a, { id: 'u1', role: 'admin' }, gone);
  a.customers = a.customers.filter((c) => c.id !== gone);
  await aS.sync(a); await mS.sync(m);
  assert.ok(!m.customers.some((c) => c.id === gone));
});

test('samtidige ændringer på forskellige poster flettes', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await aS.sync(a);
  const b = freshDb(); const bS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await bS.sync(b);
  a.customers[0].notes = 'fra A'; b.customers[1].notes = 'fra B';
  await aS.sync(a); await bS.sync(b); await aS.sync(a);
  assert.equal(a.customers.find((c) => c.id === b.customers[1].id).notes, 'fra B');
  assert.equal(b.customers.find((c) => c.id === a.customers[0].id).notes, 'fra A');
});
