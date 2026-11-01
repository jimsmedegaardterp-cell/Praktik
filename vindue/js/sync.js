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

/** db → liste af { kind, id, data } */
export function toRecords(db) {
  const out = [];
  for (const [col, kind] of Object.entries(LISTS)) for (const x of db[col] || []) if (x?.id != null) out.push({ kind, id: String(x.id), data: x });
  for (const [col, kind] of Object.entries(MAPS)) for (const [k, v] of Object.entries(db[col] || {})) if (v != null) out.push({ kind, id: k, data: v });
  for (const b of db.imports || []) out.push({ kind: IMPORT_KIND, id: String(b.batchId), data: b });
  out.push({ kind: 'settings', id: 'main', data: { settings: db.settings || {}, templates: db.templates || {}, closedDays: db.closedDays || [], closedInfo: db.closedInfo || {} } });
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

/** Hurtig, stabil hash af en værdi (FNV-1a over JSON). */
export function hash(v) {
  const s = JSON.stringify(v); let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + s.length;
}
const key = (r) => r.kind + '/' + r.id;

/**
 * SyncEngine
 *   backend: { pull(orgId, sinceIso) → rows[{kind,id,data,deleted,updated_at}], push(orgId, rows[{kind,id,data,deleted}]) }
 *   state:   { orgId, lastPull, hashes: { 'kind/id': hash } } – gemmes af kalderen
 *   role:    'admin' | 'medarbejder' (medarbejder skubber kun tilladte typer)
 */
export class SyncEngine {
  constructor({ backend, state, role }) { this.b = backend; this.s = state; this.role = role; this.s.hashes ||= {}; }
  /** Hvad er ændret lokalt siden sidste synk? */
  pending(db) {
    const now = toRecords(db); const seen = new Set(); const changed = [];
    for (const r of now) { const k = key(r); seen.add(k); const h = hash(r.data); if (this.s.hashes[k] !== h) changed.push({ ...r, _h: h }); }
    for (const k of Object.keys(this.s.hashes)) if (!seen.has(k)) { const [kind, ...rest] = k.split('/'); changed.push({ kind, id: rest.join('/'), data: null, deleted: true, _h: null }); }
    return this.role === 'admin' ? changed : changed.filter((r) => EMPLOYEE_KINDS.has(r.kind));
  }
  /** Skub lokale ændringer op og hent andres ned. Returnerer { pushed, pulled }. */
  async sync(db) {
    const out = this.pending(db); let pushed = 0;
    for (let i = 0; i < out.length; i += 400) {
      const batch = out.slice(i, i + 400);
      await this.b.push(this.s.orgId, batch.map(({ kind, id, data, deleted }) => ({ kind, id, data, deleted: !!deleted })));
      for (const r of batch) { const k = key(r); if (r.deleted) delete this.s.hashes[k]; else this.s.hashes[k] = r._h; }
      pushed += batch.length;
    }
    // hent med lidt overlap, så samtidige skrivninger ikke tabes
    const since = this.s.lastPull ? new Date(new Date(this.s.lastPull).getTime() - 60000).toISOString() : null;
    const rows = await this.b.pull(this.s.orgId, since);
    const local = new Map(toRecords(db).map((r) => [key(r), hash(r.data)]));
    const incoming = rows.filter((r) => (r.deleted ? local.has(key(r)) : local.get(key(r)) !== hash(r.data)));
    applyRecords(db, incoming);
    for (const r of rows) { const k = key(r); if (r.deleted) delete this.s.hashes[k]; else this.s.hashes[k] = hash(r.data); }
    for (const r of rows) if (!this.s.lastPull || r.updated_at > this.s.lastPull) this.s.lastPull = r.updated_at;
    return { pushed, pulled: incoming.length };
  }
}

/** Database i hukommelsen med samme regler som Supabase (til test og demo uden server). */
export class MemoryBackend {
  constructor(store = { rows: {}, clock: 0 }) { this.store = store; this.role = 'admin'; }
  as(role) { const b = new MemoryBackend(this.store); b.role = role; return b; }
  async push(orgId, rows) {
    for (const r of rows) {
      if (this.role !== 'admin' && !EMPLOYEE_KINDS.has(r.kind)) throw new Error('new row violates row-level security policy');
      const t = new Date(Date.UTC(2026, 0, 1) + ++this.store.clock * 1000).toISOString();
      this.store.rows[orgId + '|' + r.kind + '/' + r.id] = { ...JSON.parse(JSON.stringify(r)), org_id: orgId, updated_at: t };
    }
  }
  async pull(orgId, since) {
    return Object.values(this.store.rows).filter((r) => r.org_id === orgId && (!since || r.updated_at > since)).map((r) => JSON.parse(JSON.stringify(r)));
  }
}
