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
    const sc = new SupabaseCloud(c); sc.conf = { url, anonKey }; return sc;
  }
  constructor(c) { this.c = c; this.backend = { push: (o, rows) => this.push(o, rows), pull: (o, since) => this.pull(o, since) }; }
  async session() { const { data, error } = await this.c.auth.getSession(); err(error); return data.session ? { user: { id: data.session.user.id, email: data.session.user.email } } : null; }
  onAuth(cb) { this.c.auth.onAuthStateChange((ev, s) => cb(ev, s ? { user: { id: s.user.id, email: s.user.email } } : null)); }
  async signIn(email, password) { const { error } = await this.c.auth.signInWithPassword({ email, password }); err(error); }
  async signUp(email, password) { const { data, error } = await this.c.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); err(error); return { needsConfirm: !data.session }; }
  async signOut() { await this.c.auth.signOut(); }
  /** Tjek kodeord uden at røre den aktuelle session (den har evt. to-trinsniveau). */
  async checkPassword(email, password) {
    const t = window.supabase.createClient(this.conf.url, this.conf.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'vindue-pwcheck' } });
    const { error } = await t.auth.signInWithPassword({ email, password }); if (error) return false;
    await t.auth.signOut({ scope: 'local' }); return true;
  }
  async resetPassword(email) { const { error } = await this.c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); err(error); }
  async updatePassword(password) { const { error } = await this.c.auth.updateUser({ password }); err(error); }
  // To-trinslogin (TOTP: Google/Microsoft Authenticator, 1Password …)
  async mfaStatus() {
    const a = await this.c.auth.mfa.getAuthenticatorAssuranceLevel(); err(a.error);
    const f = await this.c.auth.mfa.listFactors(); err(f.error);
    return { current: a.data.currentLevel, next: a.data.nextLevel, factors: f.data.totp.map((x) => ({ id: x.id, name: x.friendly_name, created: x.created_at })), unverified: f.data.all.filter((x) => x.status !== 'verified').map((x) => x.id) };
  }
  async mfaEnroll(name) {
    for (const id of (await this.mfaStatus()).unverified) await this.c.auth.mfa.unenroll({ factorId: id }); // rester fra afbrudte forsøg
    const { data, error } = await this.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: name, issuer: 'Sindal Vinduespolering' }); err(error);
    const svg = String(data.totp.qr_code || '').replace(/^data:image\/svg\+xml;utf-8,/, '');
    return { id: data.id, qr: svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : null, secret: data.totp.secret };
  }
  async mfaVerify(factorId, code) { const { error } = await this.c.auth.mfa.challengeAndVerify({ factorId, code: String(code).replace(/\s/g, '') }); err(error); }
  async mfaUnenroll(factorId) { const { error } = await this.c.auth.mfa.unenroll({ factorId }); err(error); }
  async membership() {
    const s = await this.session(); if (!s) return null;
    const { data, error } = await this.c.from('members').select('org_id, role, employee_id, email, orgs(name)').eq('user_id', s.user.id).maybeSingle(); err(error);
    return data ? { orgId: data.org_id, role: data.role, employeeId: data.employee_id, email: data.email || s.user.email, orgName: data.orgs?.name } : null;
  }
  async createOrg(name) { const { data, error } = await this.c.rpc('create_org', { org_name: name }); err(error); return data; }
  async acceptInvite(code) { const { data, error } = await this.c.rpc('accept_invite', { invite_code: code }); err(error); return data; }
  async createInvite(orgId, role, employeeId, note) { const { data, error } = await this.c.rpc('create_invite', { o: orgId, r: role, emp: employeeId, n: note || null }); err(error); return data; }
  /** Kald serverfunktionen til e-conomic (nøglerne ligger kun på serveren). */
  async economic(op, params = {}) {
    const { data, error } = await this.c.functions.invoke('economic', { body: { op, ...params } });
    if (error) { let m = error.message; try { const b = await error.context?.json?.(); if (b?.error) m = b.error; } catch {}
      throw new Error(/Failed to send|FunctionsFetchError|404/i.test(m) ? 'Serverfunktionen "economic" er ikke installeret i Supabase endnu (se OPSÆTNING.md)' : m); }
    if (!data?.ok) throw new Error(data?.error || 'Ukendt fejl fra e-conomic-funktionen');
    return data.data;
  }
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

/** TOTP (RFC 6238) – bruges kun af testdatabasen. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export async function totp(secret, t = Date.now()) {
  let bits = ''; for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const msg = new Uint8Array(8); let c = Math.floor(t / 30000); for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg)); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
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
  async signIn(email, password) { const u = this.st().users.find((x) => x.email === email.toLowerCase()); if (!u || u.pw !== password) throw new Error('Forkert e-mail eller kodeord'); localStorage.setItem('vindue-memuser', u.id); localStorage.removeItem('vindue-memaal'); this.fire('SIGNED_IN'); }
  async signUp(email, password) { const s = this.st(); if (s.users.some((x) => x.email === email.toLowerCase())) throw new Error('Brugeren findes allerede'); if (password.length < 8) throw new Error('Kodeord skal være mindst 8 tegn');
    const u = { id: 'u' + Math.random().toString(36).slice(2, 10), email: email.toLowerCase(), pw: password }; s.users.push(u); this.put(s); localStorage.setItem('vindue-memuser', u.id); this.fire('SIGNED_IN'); return { needsConfirm: false }; }
  async checkPassword(email, pw) { const u = this.st().users.find((x) => x.email === email.toLowerCase()); return !!u && u.pw === pw; }
  async signOut() { localStorage.removeItem('vindue-memuser'); localStorage.removeItem('vindue-memaal'); this.fire('SIGNED_OUT'); }
  async resetPassword() { throw new Error('Ikke muligt i testdatabasen'); }
  me(s) { return s.users.find((u) => u.id === this.uid()); }
  async mfaStatus() { const s = this.st(); const u = this.me(s); const fs = u.factors || [];
    const v = fs.filter((f) => f.status === 'verified');
    return { current: localStorage.getItem('vindue-memaal') === u.id ? 'aal2' : 'aal1', next: v.length ? 'aal2' : 'aal1', factors: v.map((f) => ({ id: f.id, name: f.name, created: f.created })), unverified: fs.filter((f) => f.status !== 'verified').map((f) => f.id) }; }
  async mfaEnroll(name) { const s = this.st(); const u = this.me(s); u.factors = (u.factors || []).filter((f) => f.status === 'verified');
    if (u.factors.some((f) => f.name === name)) throw new Error('A factor with the friendly name already exists');
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => B32[b & 31]).join('');
    const f = { id: 'f' + Math.random().toString(36).slice(2, 8), name, secret, status: 'unverified', created: new Date().toISOString() }; u.factors.push(f); this.put(s); return { id: f.id, qr: null, secret }; }
  async mfaVerify(id, code) { const s = this.st(); const u = this.me(s); const f = (u.factors || []).find((x) => x.id === id); if (!f) throw new Error('Factor not found');
    code = String(code).replace(/\s/g, ''); const ok = (await Promise.all([-30000, 0, 30000].map((d) => totp(f.secret, Date.now() + d)))).includes(code);
    if (!ok) throw new Error('Invalid TOTP code entered'); f.status = 'verified'; this.put(s); localStorage.setItem('vindue-memaal', u.id); }
  async mfaUnenroll(id) { const s = this.st(); const u = this.me(s); if (u.factors?.some((f) => f.status === 'verified') && localStorage.getItem('vindue-memaal') !== u.id) throw new Error('AAL2 required'); u.factors = (u.factors || []).filter((f) => f.id !== id); this.put(s); }
  async updatePassword(pw) { const s = this.st(); s.users.find((u) => u.id === this.uid()).pw = pw; this.put(s); }
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
