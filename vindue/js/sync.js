// Synkronisering mellem appens lokale data (db) og den fælles database (records-tabellen).
// Appen virker lokalt (også offline); ændringer skubbes op, og andres ændringer hentes ned.
// Konflikt: sidste skrivning vinder pr. post (kunde, besøg …) – tilstrækkeligt for få brugere; logges.

// Samlinger der er lister med id
const LISTS = { customers: 'customer', addresses: 'address', agreements: 'agreement', routes: 'route', employees: 'employee', visits: 'visit',
  invoiceLinks: 'invoice', smsMessages: 'sms', audit: 'audit' };
// Samlinger der er objekter (nøgle → værdi)
const MAPS = { dayPlans: 'dayplan', vdraft: 'vdraft' };
// Det medarbejdere må skrive (skal matche employee_may_write i schema.sql)
export const EMPLOYEE_KINDS = new Set(['visit', 'vdraft', 'sms', 'audit']);
const IMPORT_KIND = 'import';

/**
 * Hvem (ud over admin) må se en post? emps = liste af medarbejder-id'er; null = alle i firmaet; [] = kun admin.
 * Medarbejdere ser kun kunder/adresser/aftaler/besøg på deres egne ruter (håndhæves i databasen, se schema.sql).
 */
export function scoper(db, todayIso = new Date().toISOString().slice(0, 10)) {
  const empIds = new Set((db.employees || []).map((e) => String(e.id)));
  const routeEmp = new Map((db.routes || []).map((r) => [r.id, r.employeeId || null]));
  const visitEmps = (v) => { const s = new Set(); const e = routeEmp.get(v.routeId); if (e) s.add(e); for (const x of v.split || []) if (x.employeeId) s.add(x.employeeId); if (empIds.has(v.completion?.by)) s.add(v.completion.by); return s; };
  const byCust = new Map(); const add = (cid, set) => { if (!cid) return; let c = byCust.get(cid); if (!c) byCust.set(cid, (c = new Set())); for (const e of set) c.add(e); };
  for (const a of db.agreements || []) if (a.active !== false && routeEmp.get(a.routeId)) add(a.customerId, [routeEmp.get(a.routeId)]);
  const recent = (() => { const d = new Date(todayIso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 60); return d.toISOString().slice(0, 10); })();
  const visits = new Map();
  for (const v of db.visits || []) { const s = visitEmps(v); visits.set(v.id, s); if (v.status === 'planlagt' || v.status === 'udsat' || v.plannedDate >= recent) add(v.customerId, s); }
  const arr = (s) => (s ? [...s].sort() : []);
  const cust = (cid) => arr(byCust.get(cid));
  const addrCust = new Map((db.addresses || []).map((a) => [a.id, a.customerId]));
  return (kind, data, id) => {
    switch (kind) {
      case 'customer': return cust(data.id);
      case 'address': return cust(data.customerId);
      case 'agreement': return arr(new Set(routeEmp.get(data.routeId) ? [routeEmp.get(data.routeId)] : []));
      case 'visit': return arr(visits.get(data.id) || visitEmps(data));
      case 'vdraft': return arr(visits.get(id));
      case 'invoice': case 'sms': return cust(data.customerId || addrCust.get(data.addressId));
      case 'employee': return [String(data.id)];
      case 'route': case 'dayplan': case 'settings': return null;
      case 'audit': return data.byEmp ? [String(data.byEmp)] : []; // medarbejder ser egne logposter
      default: return []; // import m.m.: kun admin
    }
  };
}

/** db → liste af { kind, id, data, emps } */
export function toRecords(db, todayIso) {
  const out = []; const sc = scoper(db, todayIso);
  const push = (kind, id, data) => out.push({ kind, id, data, emps: sc(kind, data, id) });
  for (const [col, kind] of Object.entries(LISTS)) for (const x of db[col] || []) if (x?.id != null) push(kind, String(x.id), x);
  for (const [col, kind] of Object.entries(MAPS)) for (const [k, v] of Object.entries(db[col] || {})) if (v != null) push(kind, k, v);
  for (const b of db.imports || []) push(IMPORT_KIND, String(b.batchId), b);
  push('settings', 'main', { settings: db.settings || {}, templates: db.templates || {}, closedDays: db.closedDays || [], closedInfo: db.closedInfo || {} });
  return out;
}

/** Læg modtagne poster ind i db (overskriver lokalt; deleted fjerner). */
export function applyRecords(db, rows) {
  const byCol = Object.fromEntries(Object.entries(LISTS).map(([c, k]) => [k, c]));
  const mapCol = Object.fromEntries(Object.entries(MAPS).map(([c, k]) => [k, c]));
  for (const r of rows) {
    if (r.kind === 'settings') { if (r.deleted || !r.data) continue; const d = r.data;
      // lokale hemmeligheder/indstillinger der ikke skal overskrives af andre enheder bevares
      db.settings = { ...(db.settings || {}), ...(d.settings || {}) }; db.templates = d.templates || db.templates || {}; db.closedDays = d.closedDays || []; db.closedInfo = d.closedInfo || {}; continue; }
    if (r.kind === IMPORT_KIND) { db.imports ||= []; const i = db.imports.findIndex((x) => String(x.batchId) === r.id); if (r.deleted) { if (i >= 0) db.imports.splice(i, 1); } else if (i >= 0) db.imports[i] = r.data; else db.imports.push(r.data); continue; }
    if (mapCol[r.kind]) { const c = mapCol[r.kind]; db[c] ||= {}; if (r.deleted) delete db[c][r.id]; else db[c][r.id] = r.data; continue; }
    const col = byCol[r.kind]; if (!col) continue;
    db[col] ||= []; const i = db[col].findIndex((x) => String(x.id) === r.id);
    if (r.deleted) { if (i >= 0) db[col].splice(i, 1); }
    else if (i >= 0) db[col][i] = r.data; else db[col].push(r.data);
  }
  return db;
}

/** JSON med sorterede nøgler – databasen (jsonb) gemmer ikke nøglernes rækkefølge, så hashen må ikke afhænge af den. */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canon(x))).join(',') + ']';
  if (v && typeof v === 'object') { if (typeof v.toJSON === 'function') return canon(v.toJSON());
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined && typeof v[k] !== 'function').map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'; }
  return JSON.stringify(v) ?? 'null';
}
/** Hurtig, stabil hash af en værdi (FNV-1a over kanonisk JSON). */
export function hash(v) {
  const s = canon(v); let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + s.length;
}
const key = (r) => r.kind + '/' + r.id;

const rhash = (data, emps) => hash(data) + '|' + (emps == null ? '*' : emps.join(','));
const STATE_V = 3; // v2: adgangsliste (emps); v3: hash uafhængig af nøglerækkefølge

/**
 * SyncEngine
 *   backend: { pull(orgId, sinceIso) → rows[{kind,id,data,deleted,emps,updated_at}], push(orgId, rows[{kind,id,data,deleted,emps}]) }
 *   state:   { v, orgId, lastPull, hashes: { 'kind/id': hash } } – gemmes af kalderen
 *   role:    'admin' | 'medarbejder' (medarbejder skubber kun tilladte typer)
 * Første synk på en enhed (eller efter formatskift) henter FØR den skubber, så en ny/tom enhed ikke overskriver firmaets data.
 * Medarbejdere laver en fuld afstemning første gang pr. opstart: poster de ikke længere har adgang til, fjernes lokalt.
 */
export class SyncEngine {
  constructor({ backend, state, role }) {
    this.b = backend; this.s = state; this.role = role;
    if (this.s.v !== STATE_V) { this.s.v = STATE_V; this.s.lastPull = null; this.s.hashes = {}; }
    this.s.hashes ||= {}; this.reconciled = false;
  }
  /** Hvad er ændret lokalt siden sidste synk? */
  pending(db) {
    const now = toRecords(db); const seen = new Set(); const changed = [];
    const admin = this.role === 'admin';
    for (const r of now) {
      const k = key(r); seen.add(k); const old = this.s.hashes[k]; let h = rhash(r.data, r.emps);
      if (old === h) continue;
      if (!admin) {
        // medarbejder: kun egne dataændringer skubbes; adgangslisten styres af admin (lokalt kendes ikke alt)
        if (old && old.split('|')[0] === h.split('|')[0]) continue;
        const prev = old ? old.split('|')[1] : '';
        if (prev && prev !== '*') { r.emps = [...new Set([...(r.emps || []), ...prev.split(',')])].sort(); h = rhash(r.data, r.emps); }
      }
      changed.push({ ...r, _h: h });
    }
    for (const k of Object.keys(this.s.hashes)) if (!seen.has(k)) { const [kind, ...rest] = k.split('/'); const e = this.s.hashes[k].split('|')[1]; changed.push({ kind, id: rest.join('/'), data: null, deleted: true, emps: e == null || e === '*' ? null : e ? e.split(',') : [], _h: null }); }
    return admin ? changed : changed.filter((r) => EMPLOYEE_KINDS.has(r.kind));
  }
  async push(db) {
    const out = this.pending(db); let pushed = 0;
    for (let i = 0; i < out.length; i += 400) {
      const batch = out.slice(i, i + 400);
      await this.b.push(this.s.orgId, batch.map(({ kind, id, data, deleted, emps }) => ({ kind, id, data, deleted: !!deleted, emps: emps ?? null })));
      for (const r of batch) { const k = key(r); if (r.deleted) delete this.s.hashes[k]; else this.s.hashes[k] = r._h; }
      pushed += batch.length;
    }
    return pushed;
  }
  async pull(db) {
    const full = !this.s.lastPull || (this.role !== 'admin' && !this.reconciled);
    // hent med lidt overlap, så samtidige skrivninger ikke tabes
    const since = full ? null : new Date(new Date(this.s.lastPull).getTime() - 60000).toISOString();
    const rows = await this.b.pull(this.s.orgId, since);
    const local = new Map(toRecords(db).map((r) => [key(r), hash(r.data)]));
    const settingsAfter = (d) => { const t = applyRecords({ settings: db.settings, templates: db.templates, closedDays: db.closedDays, closedInfo: db.closedInfo }, [{ kind: 'settings', id: 'main', data: d }]);
      return hash({ settings: t.settings || {}, templates: t.templates || {}, closedDays: t.closedDays || [], closedInfo: t.closedInfo || {} }); };
    // indstillinger flettes med lokale felter → kun "ny" hvis fletningen faktisk ændrer noget
    const incoming = rows.filter((r) => (r.deleted ? local.has(key(r)) : r.kind === 'settings' ? settingsAfter(r.data) !== local.get(key(r)) : local.get(key(r)) !== hash(r.data)));
    if (full && this.role !== 'admin') {
      // afstemning: alt lokalt som serveren ikke (længere) viser denne medarbejder, fjernes
      const there = new Set(rows.map(key));
      for (const k of local.keys()) if (!there.has(k) && !k.startsWith('settings/')) { const [kind, ...rest] = k.split('/'); incoming.push({ kind, id: rest.join('/'), deleted: true }); delete this.s.hashes[k]; }
      this.reconciled = true;
    }
    applyRecords(db, incoming);
    for (const r of rows) { const k = key(r); if (r.deleted) delete this.s.hashes[k]; else this.s.hashes[k] = rhash(r.data, r.emps ?? null); }
    for (const r of rows) if (!this.s.lastPull || r.updated_at > this.s.lastPull) this.s.lastPull = r.updated_at;
    if (!this.s.lastPull) this.s.lastPull = new Date(0).toISOString();
    return incoming.length;
  }
  /** Skub lokale ændringer op og hent andres ned. Returnerer { pushed, pulled }. */
  async sync(db) {
    if (!this.s.lastPull || this.pullFirst) { const pulled = await this.pull(db); this.pullFirst = false; const pushed = await this.push(db); return { pushed, pulled }; }
    let pushed;
    try { pushed = await this.push(db); }
    catch (e) {
      // medarbejder har fx mistet adgang til et besøg (ruten flyttet): afstem først næste gang, så posten fjernes lokalt
      if (this.role !== 'admin') { this.reconciled = false; this.pullFirst = true; }
      throw e;
    }
    const pulled = await this.pull(db);
    return { pushed, pulled };
  }
}

/** Som PostgreSQL jsonb: nøgler sorteres (korteste først), værdier bevares. */
function jsonb(v) {
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).filter((k) => v[k] !== undefined).map((k) => [k, jsonb(v[k])]));
  return v;
}
/** Database i hukommelsen med samme regler som Supabase (til test og demo uden server). */
export class MemoryBackend {
  constructor(store = { rows: {}, clock: 0 }) { this.store = store; this.role = 'admin'; this.emp = null; }
  as(role, emp = null) { const b = new MemoryBackend(this.store); b.role = role; b.emp = emp; return b; }
  sees(r) { return this.role === 'admin' || r.emps == null || r.emps.includes(this.emp); }
  async push(orgId, rows) {
    for (const r of rows) {
      const k = orgId + '|' + r.kind + '/' + r.id; const old = this.store.rows[k];
      if (this.role !== 'admin' && (!EMPLOYEE_KINDS.has(r.kind) || (old && !this.sees(old)) || !(r.emps || []).includes(this.emp)))
        throw new Error('new row violates row-level security policy');
      const t = new Date(Date.UTC(2026, 0, 1) + ++this.store.clock * 1000).toISOString();
      this.store.rows[k] = { ...JSON.parse(JSON.stringify(r)), data: jsonb(r.data), org_id: orgId, updated_at: t };
    }
  }
  async pull(orgId, since) {
    return Object.values(this.store.rows).filter((r) => r.org_id === orgId && (!since || r.updated_at > since) && this.sees(r)).map((r) => JSON.parse(JSON.stringify(r)));
  }
}
