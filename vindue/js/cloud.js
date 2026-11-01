// Forbindelse til den fælles database. To implementeringer med samme grænseflade:
//   SupabaseCloud – den rigtige (Supabase, EU)
//   MemoryCloud   – til test/demo uden server (gemmes i browseren; url = "memory")
import { MemoryBackend } from './sync.js';

const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Kunne ikke hente ' + src)); document.head.append(s); });
const err = (e) => { if (e) throw new Error(e.message || String(e)); };

export class SupabaseCloud {
  static async create({ url, anonKey }) {
    if (!window.supabase) await loadScript('vendor/supabase-js-2.45.4/supabase.js');
    const c = window.supabase.createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return new SupabaseCloud(c);
  }
  constructor(c) { this.c = c; this.backend = { push: (o, rows) => this.push(o, rows), pull: (o, since) => this.pull(o, since) }; }
  async session() { const { data, error } = await this.c.auth.getSession(); err(error); return data.session ? { user: { id: data.session.user.id, email: data.session.user.email } } : null; }
  onAuth(cb) { this.c.auth.onAuthStateChange((ev, s) => cb(ev, s ? { user: { id: s.user.id, email: s.user.email } } : null)); }
  async signIn(email, password) { const { error } = await this.c.auth.signInWithPassword({ email, password }); err(error); }
  async signUp(email, password) { const { data, error } = await this.c.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); err(error); return { needsConfirm: !data.session }; }
  async signOut() { await this.c.auth.signOut(); }
  async resetPassword(email) { const { error } = await this.c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); err(error); }
  async updatePassword(password) { const { error } = await this.c.auth.updateUser({ password }); err(error); }
  async membership() {
    const s = await this.session(); if (!s) return null;
    const { data, error } = await this.c.from('members').select('org_id, role, employee_id, email, orgs(name)').eq('user_id', s.user.id).maybeSingle(); err(error);
    return data ? { orgId: data.org_id, role: data.role, employeeId: data.employee_id, email: data.email || s.user.email, orgName: data.orgs?.name } : null;
  }
  async createOrg(name) { const { data, error } = await this.c.rpc('create_org', { org_name: name }); err(error); return data; }
  async acceptInvite(code) { const { data, error } = await this.c.rpc('accept_invite', { invite_code: code }); err(error); return data; }
  async createInvite(orgId, role, employeeId, note) { const { data, error } = await this.c.rpc('create_invite', { o: orgId, r: role, emp: employeeId, n: note || null }); err(error); return data; }
  async members(orgId) { const { data, error } = await this.c.from('members').select('user_id, role, employee_id, email, created_at').eq('org_id', orgId).order('created_at'); err(error); return data; }
  async invites(orgId) { const { data, error } = await this.c.from('invites').select('code, role, employee_id, note, expires_at, used_at').eq('org_id', orgId).is('used_at', null).order('created_at', { ascending: false }); err(error); return data; }
  async updateMember(orgId, userId, patch) { const { error } = await this.c.from('members').update(patch).eq('org_id', orgId).eq('user_id', userId); err(error); }
  async removeMember(orgId, userId) { const { error } = await this.c.from('members').delete().eq('org_id', orgId).eq('user_id', userId); err(error); }
  async deleteInvite(code) { const { error } = await this.c.from('invites').delete().eq('code', code); err(error); }
  async push(orgId, rows) {
    const { error } = await this.c.from('records').upsert(rows.map((r) => ({ org_id: orgId, kind: r.kind, id: r.id, data: r.data, deleted: !!r.deleted, emps: r.emps ?? null })), { onConflict: 'org_id,kind,id' });
    err(error);
  }
  async pull(orgId, since) {
    const out = []; const page = 1000;
    for (let from = 0; ; from += page) {
      let q = this.c.from('records').select('kind, id, data, deleted, emps, updated_at').eq('org_id', orgId).order('updated_at').order('kind').order('id').range(from, from + page - 1);
      if (since) q = q.gt('updated_at', since);
      const { data, error } = await q; err(error); out.push(...data); if (data.length < page) break;
    }
    return out;
  }
}

/** Test-/demoudgave uden server. Al "server"-data ligger i localStorage['vindue-memserver']. Adgangskoder er IKKE beskyttede – kun til test. */
export class MemoryCloud {
  constructor() { this.K = 'vindue-memserver'; this.cbs = []; this.backend = { push: (o, r) => this.mem().push(o, r), pull: (o, s) => this.mem().pull(o, s) }; }
  st() { try { return JSON.parse(localStorage.getItem(this.K)) || { users: [], orgs: [], members: [], invites: [], rows: {}, clock: 0 }; } catch { return { users: [], orgs: [], members: [], invites: [], rows: {}, clock: 0 }; } }
  put(s) { localStorage.setItem(this.K, JSON.stringify(s)); }
  mem() { const s = this.st(); const self = this; const m = new MemoryBackend(s); m.role = this.myRole || 'admin'; m.emp = this.myEmp || null;
    return { push: async (o, rows) => { await m.push(o, rows); self.put(s); }, pull: (o, since) => m.pull(o, since) }; }
  uid() { return sessionStorage.getItem('vindue-memuser') || localStorage.getItem('vindue-memuser'); }
  async session() { const u = this.st().users.find((x) => x.id === this.uid()); return u ? { user: { id: u.id, email: u.email } } : null; }
  onAuth(cb) { this.cbs.push(cb); }
  fire(ev) { this.session().then((s) => this.cbs.forEach((cb) => cb(ev, s))); }
  async signIn(email, password) { const u = this.st().users.find((x) => x.email === email.toLowerCase()); if (!u || u.pw !== password) throw new Error('Forkert e-mail eller kodeord'); localStorage.setItem('vindue-memuser', u.id); this.fire('SIGNED_IN'); }
  async signUp(email, password) { const s = this.st(); if (s.users.some((x) => x.email === email.toLowerCase())) throw new Error('Brugeren findes allerede'); if (password.length < 8) throw new Error('Kodeord skal være mindst 8 tegn');
    const u = { id: 'u' + Math.random().toString(36).slice(2, 10), email: email.toLowerCase(), pw: password }; s.users.push(u); this.put(s); localStorage.setItem('vindue-memuser', u.id); this.fire('SIGNED_IN'); return { needsConfirm: false }; }
  async signOut() { localStorage.removeItem('vindue-memuser'); this.fire('SIGNED_OUT'); }
  async resetPassword() { throw new Error('Ikke muligt i testdatabasen'); }
  async updatePassword() {}
  async membership() { const s = this.st(); const m = s.members.find((x) => x.user_id === this.uid()); if (!m) return null; this.myRole = m.role; this.myEmp = m.employee_id;
    return { orgId: m.org_id, role: m.role, employeeId: m.employee_id, email: m.email, orgName: s.orgs.find((o) => o.id === m.org_id)?.name }; }
  async createOrg(name) { const s = this.st(); if (s.members.some((x) => x.user_id === this.uid())) throw new Error('Du er allerede med i et firma');
    const o = { id: 'org' + Math.random().toString(36).slice(2, 8), name }; s.orgs.push(o); s.members.push({ org_id: o.id, user_id: this.uid(), role: 'admin', employee_id: 'e1', email: s.users.find((u) => u.id === this.uid()).email, created_at: new Date().toISOString() }); this.put(s); return o.id; }
  async createInvite(orgId, role, employeeId, note) { const s = this.st(); const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    s.invites.push({ code, org_id: orgId, role, employee_id: employeeId, note, expires_at: new Date(Date.now() + 14 * 864e5).toISOString(), used_at: null }); this.put(s); return code; }
  async acceptInvite(code) { const s = this.st(); const inv = s.invites.find((x) => x.code === code.trim().toUpperCase()); if (!inv) throw new Error('Ukendt kode'); if (inv.used_at) throw new Error('Koden er allerede brugt');
    if (s.members.some((x) => x.user_id === this.uid())) throw new Error('Du er allerede med i et firma');
    s.members.push({ org_id: inv.org_id, user_id: this.uid(), role: inv.role, employee_id: inv.employee_id, email: s.users.find((u) => u.id === this.uid()).email, created_at: new Date().toISOString() });
    inv.used_at = new Date().toISOString(); this.put(s); return inv.org_id; }
  async members(orgId) { return this.st().members.filter((m) => m.org_id === orgId); }
  async invites(orgId) { return this.st().invites.filter((i) => i.org_id === orgId && !i.used_at); }
  async updateMember(orgId, userId, patch) { const s = this.st(); Object.assign(s.members.find((m) => m.org_id === orgId && m.user_id === userId), patch); this.put(s); }
  async removeMember(orgId, userId) { const s = this.st(); s.members = s.members.filter((m) => !(m.org_id === orgId && m.user_id === userId)); this.put(s); }
  async deleteInvite(code) { const s = this.st(); s.invites = s.invites.filter((i) => i.code !== code); this.put(s); }
}
