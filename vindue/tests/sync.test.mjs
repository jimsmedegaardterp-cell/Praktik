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

const mine = (db, e) => new Set(db.agreements.filter((a) => db.routes.find((r) => r.id === a.routeId)?.employeeId === e).map((a) => a.customerId));

test('to enheder: admin uploader, medarbejder henter KUN egne ruter, ændrer besøg; admin får ændringen', async () => {
  const server = new SY.MemoryBackend(); const org = 'org1';
  const pc = seedDb('2026-11-02'); const pcSync = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' });
  const r1 = await pcSync.sync(pc); assert.ok(r1.pushed > 50); assert.equal(r1.pulled, 0);
  const phone = freshDb(); const phSync = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: { orgId: org }, role: 'medarbejder' });
  await phSync.sync(phone);
  const exp = mine(pc, 'e2');
  assert.deepEqual(new Set(phone.customers.map((c) => c.id)), exp, 'kun kunder på egne ruter');
  assert.ok(exp.size > 0 && exp.size < pc.customers.length);
  assert.ok(phone.visits.length > 0 && phone.visits.every((v) => pc.routes.find((r) => r.id === v.routeId)?.employeeId === 'e2'));
  assert.ok(!phone.audit.length, 'ser ikke admins auditlog');
  assert.deepEqual(phone.employees.map((e) => e.id), ['e2'], 'ser kun sig selv (ikke kollegers provisionssats)');
  assert.equal(phone.routes.length, pc.routes.length, 'rutenavne er fælles');
  // medarbejder færdigmelder et besøg på telefonen
  const v = phone.visits.find((x) => x.routeId === 'r1' && x.status === 'planlagt');
  S.registerVisit(phone, { id: 'u2', role: 'medarbejder', employeeId: 'e2' }, v.id, { result: 'udfoert', opId: 'p1' });
  phone.audit.forEach((a) => (a.byEmp = 'e2'));
  const r3 = await phSync.sync(phone); assert.ok(r3.pushed >= 2, 'besøg + audit');
  await pcSync.sync(pc);
  assert.equal(pc.visits.find((x) => x.id === v.id).status, 'udfoert');
  assert.ok(pc.audit.some((a) => a.byEmp === 'e2'));
  assert.equal((await pcSync.sync(pc)).pushed, 0, 'intet at skubbe bagefter');
  assert.equal((await phSync.sync(phone)).pushed, 0, 'heller ikke fra telefonen');
});

test('medarbejder skubber ikke kunde-ændringer, admin sletter → forsvinder hos andre', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await aS.sync(a);
  const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: { orgId: org }, role: 'medarbejder' }); await mS.sync(m);
  const c0 = m.customers[0]; c0.name = 'Ændret af medarbejder';
  assert.equal(mS.pending(m).filter((r) => r.kind === 'customer').length, 0);
  await mS.sync(m); await aS.sync(a); assert.notEqual(a.customers.find((c) => c.id === c0.id).name, 'Ændret af medarbejder');
  const gone = m.customers[1].id; S.deleteCustomer(a, { id: 'u1', role: 'admin' }, gone);
  a.customers = a.customers.filter((c) => c.id !== gone);
  await aS.sync(a); await mS.sync(m);
  assert.ok(!m.customers.some((c) => c.id === gone));
});

test('rute flyttes til anden medarbejder → forsvinder fra den gamle medarbejders telefon, uden at blive slettet', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); a.employees.push({ id: 'e3', name: 'Medarbejder 2', role: 'medarbejder' });
  const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await aS.sync(a);
  const st = { orgId: org }; const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: st, role: 'medarbejder' }); await mS.sync(m);
  const r1cust = new Set(a.agreements.filter((x) => x.routeId === 'r1').map((x) => x.customerId));
  assert.ok([...r1cust].every((id) => m.customers.some((c) => c.id === id)));
  // telefonen har en kladde på et r1-besøg
  const v = m.visits.find((x) => x.routeId === 'r1' && x.status === 'planlagt'); m.vdraft = { [v.id]: { result: 'udfoert' } }; await mS.sync(m);
  a.routes.find((r) => r.id === 'r1').employeeId = 'e3'; const p = await aS.sync(a); assert.ok(p.pushed >= r1cust.size, 'adgangsliste ændret → poster skubbes igen');
  // ny opstart af appen på telefonen (samme gemte tilstand) → fuld afstemning
  const m2S = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: st, role: 'medarbejder' }); await m2S.sync(m);
  assert.ok([...r1cust].every((id) => !m.customers.some((c) => c.id === id)), 'r1-kunder væk fra telefonen');
  assert.ok(!m.visits.some((x) => x.routeId === 'r1'));
  assert.equal(m2S.pending(m).length, 0, 'intet slettes på serveren');
  await aS.sync(a); assert.equal(a.customers.length, seedDb('2026-11-02').customers.length, 'kunderne findes stadig hos admin');
  const e3 = freshDb(); await new SY.SyncEngine({ backend: server.as('medarbejder', 'e3'), state: { orgId: org }, role: 'medarbejder' }).sync(e3);
  assert.ok([...r1cust].every((id) => e3.customers.some((c) => c.id === id)), 'ny medarbejder ser dem');
});

test('medarbejder sletter kladde efter færdigmelding (sletning må skubbes)', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); await new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }).sync(a);
  const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: { orgId: org }, role: 'medarbejder' }); await mS.sync(m);
  const v = m.visits.find((x) => x.status === 'planlagt'); m.vdraft = { [v.id]: { note: 'x' } }; await mS.sync(m);
  delete m.vdraft[v.id]; const r = await mS.sync(m); assert.equal(r.pushed, 1);
  assert.equal(Object.values(server.store.rows).find((x) => x.kind === 'vdraft').deleted, true);
});

test('ny enhed overskriver ikke firmaets indstillinger/medarbejdere (henter før den skubber)', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); a.settings.commissionRate = 0.4; a.employees[0].name = 'Jim Rigtig';
  await new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }).sync(a);
  const b = freshDb(); const bS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await bS.sync(b);
  assert.equal(b.settings.commissionRate, 0.4); assert.equal(b.employees.find((e) => e.id === 'e1').name, 'Jim Rigtig');
  const rows = Object.values(server.store.rows); assert.equal(rows.find((r) => r.kind === 'settings').data.settings.commissionRate, 0.4);
  assert.equal(rows.find((r) => r.kind === 'employee' && r.id === 'e1').data.name, 'Jim Rigtig');
});

test('gammel synk-tilstand (uden adgangslister) → admin skubber alt igen med adgangsliste', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); const st = { orgId: org };
  await new SY.SyncEngine({ backend: server.as('admin'), state: st, role: 'admin' }).sync(a);
  for (const r of Object.values(server.store.rows)) r.emps = null; // som før opdateringen
  delete st.v;
  const r = await new SY.SyncEngine({ backend: server.as('admin'), state: st, role: 'admin' }).sync(a);
  assert.ok(r.pushed > 50);
  assert.ok(Object.values(server.store.rows).filter((x) => x.kind === 'customer').every((x) => Array.isArray(x.emps)));
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

test('rolig tilstand: gentagne synk skubber og henter intet (jsonb ændrer nøglerækkefølge)', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); a.settings.zz = 1; a.settings.a = 2; const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' });
  await aS.sync(a); await aS.sync(a);
  for (let i = 0; i < 3; i++) { const r = await aS.sync(a); assert.deepEqual(r, { pushed: 0, pulled: 0 }, 'admin runde ' + i); }
  const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: { orgId: org }, role: 'medarbejder' });
  await mS.sync(m); await mS.sync(m);
  for (let i = 0; i < 3; i++) { const r = await mS.sync(m); assert.deepEqual(r, { pushed: 0, pulled: 0 }, 'medarbejder runde ' + i); }
  a.customers[0].notes = 'ny'; const r1 = await aS.sync(a); assert.equal(r1.pushed, 1);
  await aS.sync(a); assert.deepEqual(await aS.sync(a), { pushed: 0, pulled: 0 });
});

test('medarbejder: note til kunde og "meldt udsat" synkroniseres til admin (uden at ændre besøget)', async () => {
  const server = new SY.MemoryBackend(); const org = 'o';
  const a = seedDb('2026-11-02'); const aS = new SY.SyncEngine({ backend: server.as('admin'), state: { orgId: org }, role: 'admin' }); await aS.sync(a);
  const m = freshDb(); const mS = new SY.SyncEngine({ backend: server.as('medarbejder', 'e2'), state: { orgId: org }, role: 'medarbejder' }); await mS.sync(m);
  const v = m.visits.find((x) => x.status === 'planlagt'); const c = m.customers.find((x) => x.id === v.customerId);
  (m.customerNotes ||= []).push({ id: 'n1', customerId: c.id, addressId: v.addressId, text: 'Ny kode 1234', by: 'u2', byName: 'Mads', at: '2026-11-06T10:00:00Z' });
  v.flag = { kind: 'udsat', note: 'Ikke hjemme', by: 'u2', at: '2026-11-06T10:01:00Z' };
  const r = await mS.sync(m); assert.ok(r.pushed >= 2);
  await aS.sync(a);
  assert.equal(a.customerNotes.find((n) => n.id === 'n1').text, 'Ny kode 1234');
  const av = a.visits.find((x) => x.id === v.id); assert.equal(av.flag.note, 'Ikke hjemme'); assert.equal(av.status, 'planlagt'); assert.equal(av.plannedDate, v.plannedDate);
});
