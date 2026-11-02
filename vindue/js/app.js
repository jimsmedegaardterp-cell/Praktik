// UI for prototypen. Al forretningslogik ligger i domain.js / services.js.
import * as D from './domain.js';
import * as S from './services.js';
import { MockEconomic, EconomicApi, MockSms, mapsDirections, mapsRoute, smsLink, suggestOrder, routeKm } from './adapters.js';
import { seedDb, freshDb } from './seed.js';
import * as I from './import.js';
import * as G from './gdpr.js';
import * as SD from './stamdata.js';
import * as RS from './rutesedel.js';
import * as DP from './dayplan.js';
import * as SY from './sync.js';
import { SupabaseCloud, MemoryCloud } from './cloud.js';
import { SUPABASE } from './config.js';
import { showRouteMap } from './map.js';
import * as KV from './store.js';

export const VERSION = '2026-11-02 #44';
const KEY = 'vindue-demo-v3'; // v3: ruter med egen rytme
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let db = await load();
let eco = new MockEconomic(db.mock.economic);
let sms = new MockSms(db.mock.sms);
/** Rigtig e-conomic når den er slået til og man er admin i den fælles database; ellers øve-udgaven (mock). */
const ecoReal = () => !!(db.settings.economic?.enabled && cloud?.economic && member?.role === 'admin');
const ecoApi = () => (ecoReal() ? new EconomicApi((op, p) => cloud.economic(op, p), db.settings.economic) : eco);
function setDb(nd) { db = nd; db.mock ||= { economic: {}, sms: {} }; eco = new MockEconomic(db.mock.economic); sms = new MockSms(db.mock.sms); }
/* ---------- Fælles database (login + synkronisering) ---------- */
let cloud = null;      // forbindelse (SupabaseCloud / MemoryCloud) – null = kun lokalt
let member = null;     // { userId, email, orgId, orgName, role, employeeId }
let gate = null;       // login-skærm der vises i stedet for appen: 'login' | 'confirm' | 'onboard' | 'firstdata' | 'recovery' | 'loading'
let syncer = null, syncTimer = null; const syncInfo = { status: 'off', at: null, error: null };
const cloudConf = () => { try { const o = JSON.parse(localStorage.getItem('vindue-cloudconf')); if (o?.url) return o; } catch {} return SUPABASE.url ? SUPABASE : null; };
// Brugere = medarbejdere i appen (prototype: ingen login – vælg bruger i topbjælken)
const LEGACY = { e1: 'u1', e2: 'u2' };
const users = () => member ? [{ id: member.userId, name: `${emp(member.employeeId)?.name || member.email}${member.role === 'admin' ? ' (admin)' : ''}`, role: member.role, employeeId: member.employeeId }] : db.employees.filter((e) => !e.inactive).map((e) => ({ id: LEGACY[e.id] || 'u_' + e.id, name: `${e.name}${e.role === 'admin' ? ' (admin)' : ''}`, role: e.role === 'admin' ? 'admin' : 'medarbejder', employeeId: e.id }));
const userName = (id) => { const u = users().find((x) => x.id === id); if (u) return u.name; const e = db.employees.find((x) => 'u_' + x.id === id || LEGACY[x.id] === id); return e?.name ?? id; };
const ui = { tab: 'kalender', user: null, weekStart: mondayOf(todayIso()), day: todayIso(), customer: null, route: 'r1', q: '', offline: false, outbox: [], sel: new Set() };
try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY + '-ui')) || {}); } catch {}
ui.user = users().find((u) => u.id === ui.user?.id) || users().find((u) => u.role === 'admin') || users()[0];

async function load() {
  const d = await KV.get(KEY); KV.persist();
  return d && Array.isArray(d.customers) ? d : seedDb(todayIso());
}
// Gemmer hele db i IndexedDB. Flere gem lige efter hinanden slås sammen; rækkefølgen bevares.
let saving = null, again = false;
let dbKey = KEY; // indlogget: hver bruger har sine egne lokale data (KEY:brugerid)
function persist() {
  if (saving) { again = true; return saving; }
  saving = (async () => {
    try { do { again = false; await KV.set(dbKey, db); } while (again); }
    catch (e) { toast('⚠️ Kunne ikke gemme på enheden (' + (e?.name === 'QuotaExceededError' ? 'lageret er fuldt' : e?.message || e) + '). Tag en backup under Admin.'); console.error(e); }
    finally { saving = null; }
  })();
  return saving;
}
function save() {
  if (syncer) scheduleSync();
  try { localStorage.setItem(KEY + '-ui', JSON.stringify({ tab: ui.tab, user: { id: ui.user.id }, route: ui.route, outbox: ui.outbox })); } catch {}
  return persist();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
function mondayOf(iso) { return D.addDays(iso, -D.weekday(iso)); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kr = (n) => (n ?? 0).toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' kr';
const DAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const fmt = (iso) => { const d = D.toDate(iso); return `${DAYS[D.weekday(iso)]}. ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const fmtTs = (ts) => new Date(ts).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });
const cust = (id) => db.customers.find((c) => c.id === id);
const addr = (id) => db.addresses.find((a) => a.id === id);
const route = (id) => db.routes.find((r) => r.id === id);
const routeWhen = (r) => `hver ${r.intervalWeeks}. uge · næste ${fmt(D.nextRouteDate(r, todayIso()) || todayIso())}`;
/** Første dag (fra i dag) hvor ruten har planlagte besøg; ellers rutens beregnede dato. */
/** Dage hvor ruten har planlagte/udsatte besøg (sorteret). */
const routeDays = (r) => [...new Set(db.visits.filter((v) => v.routeId === r.id && (v.status === 'planlagt' || v.status === 'udsat')).map((v) => v.plannedDate))].sort();
/** Den dag ruten skal åbne på: første fremtidige dag med besøg; ellers seneste dag med åbne (ikke færdigmeldte) besøg; ellers rytmen. */
const nextRouteDay = (r, from = todayIso()) => { const ds = routeDays(r); return ds.find((d) => d >= from) || ds.filter((d) => d < from).pop() || D.nextRouteDate(r, from); };
const openPastDay = (r, from = todayIso()) => routeDays(r).filter((d) => d < from).pop() || null;
const mins = (vs) => vs.filter((v) => v.status !== 'aflyst').reduce((s, v) => s + (v.durationMin ?? 15), 0);
const agrDesc = (a) => a.intervalWeeks ? `Hver ${a.intervalWeeks}. uge` : 'Ikke fast';
const emp = (id) => db.employees.find((e) => e.id === id);
const isAdmin = () => ui.user.role === 'admin';
const STATUS = { planlagt: ['Planlagt', ''], ...Object.fromEntries(Object.entries(D.RESULTS).map(([k, v]) => [k, [v, ['udfoert', 'delvis'].includes(k) ? 'ok' : k === 'udsat' ? 'warn' : 'bad']])) };
const pill = (st) => `<span class="pill ${STATUS[st]?.[1] ?? ''}">${esc(STATUS[st]?.[0] ?? st)}</span>`;
const PAY = { bank: 'Bankoverførsel', mobilepay: 'MobilePay', betalingsservice: 'Betalingsservice', kontant: 'Kontant' };
const INV = { afventer: 'warn', kladde: '', bogført: 'ok', fejl: 'bad' };

function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
const $view = document.getElementById('view');

/* ---------------- Faner ---------------- */
const TABS = [
  ['kalender', 'Kalender', true], ['kunder', 'Kunder', true], ['mobil', 'Dagsrute', false], ['faktura', 'Fakturering', true],
  ['sms', 'Beskeder', true], ['import', 'Import', true], ['admin', 'Admin', true],
];
const TABICON = { kalender: '📅', kunder: '👥', mobil: '🚐', faktura: '🧾', sms: '💬', import: '📥', admin: '⚙️' };
const TABSHORT = { faktura: 'Faktura', sms: 'Beskeder' };
function renderTabs() {
  const tabs = TABS.filter(([, , adm]) => !adm || isAdmin());
  if (ui.tab === 'overblik') ui.tab = 'kalender';
  if (!tabs.some(([k]) => k === ui.tab) && !((ui.tab === 'ruter' || ui.tab === 'dag' || ui.tab === 'print') && isAdmin())) ui.tab = tabs[0][0];
  const active = ui.tab === 'ruter' ? 'kunder' : (ui.tab === 'dag' || ui.tab === 'print') ? 'kalender' : ui.tab;
  const unread = db.smsMessages.filter((m) => m.dir === 'ind' && !m.read).length;
  document.getElementById('tabs').innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" class="${active === k ? 'on' : ''}"><span class="ti">${TABICON[k] || ''}</span><span class="tl">${n}</span><span class="ts">${TABSHORT[k] || n}</span>${k === 'sms' && unread ? ` <span class="pill bad">${unread}</span>` : ''}</button>`).join('');
}
function render() {
  renderNet();
  if (gate) return renderGate();
  document.getElementById('tabs').hidden = false;
  if (!users().some((u) => u.id === ui.user?.id)) ui.user = users().find((u) => u.role === 'admin') || users()[0];
  renderUserSelect();
  renderTabs();
  const tag = document.querySelector('.tag'); if (tag) tag.textContent = (db.settings.realData ? 'PROTOTYPE' : 'PROTOTYPE · testdata') + ' · version ' + VERSION;
  ({ overblik, kunder, kalender, ruter, dag: dagsplan, print: printView, mobil, faktura, sms: beskeder, import: importView, admin })[ui.tab]();
  const rm = document.getElementById('routeMap'); if (rm && ui._routeMapArgs) showRouteMap(rm, ui._routeMapArgs).catch(() => {});
  save();
}

/* ---------------- Overblik ---------------- */
function overblik() {
  const t = todayIso(); const ws = mondayOf(t); const we = D.addDays(ws, 6);
  const today = db.visits.filter((v) => v.plannedDate === t);
  const week = db.visits.filter((v) => v.plannedDate >= ws && v.plannedDate <= we);
  const q = D.invoiceQueue(db.visits, db.invoiceLinks);
  const unread = db.smsMessages.filter((m) => m.dir === 'ind' && !m.read);
  const open = db.invoiceLinks.filter((l) => l.status === 'bogført' && l.payment !== 'betalt');
  const errs = db.invoiceLinks.filter((l) => l.status === 'fejl').length + db.smsMessages.filter((m) => m.status === 'fejlet').length;
  const dbl = D.findDoubleBookings(db.visits.filter((v) => v.plannedDate >= t));
  const overdue = db.visits.filter((v) => (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate < t);
  $view.innerHTML = `
  <div class="grid">
    <div class="card"><div class="mute">I dag</div><div class="kpi">${today.filter((v) => v.status !== 'planlagt').length}/${today.length}</div><div class="small mute">besøg registreret</div></div>
    <div class="card"><div class="mute">Denne uge (uge ${D.isoWeek(t)})</div><div class="kpi">${week.length}</div><div class="small mute">${kr(week.reduce((s, v) => s + (v.status === 'aflyst' ? 0 : v.price), 0))} ekskl. moms</div></div>
    <div class="card" data-tab="faktura" style="cursor:pointer"><div class="mute">Klar til fakturering</div><div class="kpi">${q.length}</div><div class="small mute">${kr(q.reduce((s, v) => s + v.price, 0))}</div></div>
    <div class="card" data-tab="sms" style="cursor:pointer"><div class="mute">Ulæste SMS</div><div class="kpi">${unread.length}</div><div class="small mute">${db.smsMessages.filter((m) => m.dir === 'ind' && !m.customerId).length} fra ukendte numre</div></div>
    <div class="card"><div class="mute">Åbne fakturaer</div><div class="kpi">${open.length}</div><div class="small mute">${kr(open.reduce((s, l) => s + (l.remainder ?? l.total * 1.25), 0))} inkl. moms</div></div>
  </div>
  ${errs ? `<div class="warnbox">⚠️ ${errs} integrationsfejl – se Fakturering/Beskeder.</div>` : ''}
  ${dbl.length ? `<div class="warnbox">⚠️ ${dbl.length} mulige dobbeltbookinger (samme adresse samme dag – samme opgave to gange eller to forskellige ruter). <button data-act="showDbl">Vis</button></div>` : ''}
  ${(() => { const n = dataCheck().slice(0, 2).reduce((s, [, it]) => s + it.length, 0); return n ? `<div class="warnbox">📋 ${n} ting at tjekke i kunde- og rutedata (kunder uden kundenr., ruter uden dato …). <button data-act="showCheck">Vis</button></div>` : ''; })()}
  ${overdue.length ? `<div class="warnbox">⚠️ ${overdue.length} besøg i fortiden er ikke registreret. <button data-act="showOverdue">Vis</button></div>` : ''}
  ${varselCard()}
  <div class="card"><h2>Dagens ruter – ${fmt(t)}</h2>${dayTable(today)}</div>
  <div class="card"><h2>Kommende 7 dage</h2>${dayTable(db.visits.filter((v) => v.plannedDate > t && v.plannedDate <= D.addDays(t, 7)).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate)), true)}</div>`;
}
function varselCard() {
  const nd = D.nextWorkday(D.addDays(todayIso(), 1), db.closedDays);
  const vs = db.visits.filter((v) => v.plannedDate === nd && v.status === 'planlagt' && cust(v.customerId)?.smsBefore);
  if (!vs.length) return '';
  const sent = new Set(db.smsMessages.filter((m) => m.clientRef?.startsWith('varsel:')).map((m) => m.clientRef.slice(7)));
  const left = vs.filter((v) => !sent.has(v.id)).length;
  return `<div class="card"><h2>SMS før besøg – ${fmt(nd)} ${left ? `<span class="pill warn">${left} mangler</span>` : '<span class="pill ok">alle sendt</span>'}</h2>
    ${vs.map((v) => { const c = cust(v.customerId); const tel = D.normalizePhone(c.phone); const text = D.renderTemplate(db.templates.varsel, { navn: c.name.split(' ')[0], dato: fmt(nd) });
      return `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="sp"><b>${esc(c.name)}</b> <span class="small mute">${esc(addr(v.addressId)?.street)}</span></div>${sent.has(v.id) ? '<span class="pill ok">✓ Sendt</span>' : tel ? `<a class="btn pri" data-varsel="${v.id}" data-text="${esc(text)}" href="${smsLink(tel, text)}">📱 Send varsel</a>` : '<span class="pill bad">intet mobilnr.</span>'}</div>`; }).join('')}</div>`;
}
function dayTable(vs, withDate) {
  if (!vs.length) return '<p class="mute">Ingen besøg.</p>';
  return `<table><tr>${withDate ? '<th>Dato</th>' : ''}<th>Kunde</th><th class="hide-m">Adresse</th><th>Rute</th><th>Pris</th><th>Status</th></tr>${vs.map((v) => `<tr>${withDate ? `<td>${fmt(v.plannedDate)}</td>` : ''}<td><a href="#" data-cust="${v.customerId}">${esc(cust(v.customerId)?.name)}</a></td><td class="hide-m">${esc(addr(v.addressId)?.street)}</td><td>${esc(route(v.routeId)?.name)}</td><td>${kr(v.price)}</td><td>${pill(v.status)}</td></tr>`).join('')}</table>`;
}

/** Skalér billede ned (maks 1280 px, JPEG) så det fylder ca. 100–200 KB i browserens lager. */
function shrinkImage(file, max = 1280, q = 0.72) {
  return new Promise((res, rej) => { const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); res(cv.toDataURL('image/jpeg', q)); };
    img.onerror = rej; img.src = url; });
}
/* ---------------- Kunder ---------------- */
const kTabs = () => `<div class="seg subtabs"><button data-act="kview" data-v="kunder" class="${ui.kView !== 'ruter' ? 'on' : ''}">Kunder</button><button data-act="kview" data-v="ruter" class="${ui.kView === 'ruter' ? 'on' : ''}">Faste ruter</button></div>`;
function kunder() {
  if (ui.customer && cust(ui.customer)) return kundekort(cust(ui.customer));
  if (ui.kView === 'ruter') return ruteOversigt();
  const q = ui.q.toLowerCase();
  const list = db.customers.filter((c) => !c.deleted && (!q || c.name.toLowerCase().includes(q) || String(c.customerNo || c.skvizbizId || '').includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) || db.addresses.some((a) => a.customerId === c.id && a.street.toLowerCase().includes(q))));
  $view.innerHTML = kTabs() + `<div class="card"><div class="row"><input id="q" placeholder="Søg navn, kundenr., telefon, adresse" value="${esc(ui.q)}" class="sp"><button class="pri" data-act="newCustomer">+ Ny kunde</button></div></div>
  <div class="card"><div class="small mute" style="margin-bottom:6px">${list.length} kunder</div><table class="clickable"><tr><th>Kundenr.</th><th>Navn / firma</th><th>Adresse</th><th class="hide-m">Interval</th><th class="hide-m">Rute</th><th class="hide-m">Næste besøg</th></tr>
  ${list.slice(0, 500).map((c) => { const ags = db.agreements.filter((a) => a.customerId === c.id && a.active); const a0 = db.addresses.find((a) => a.customerId === c.id);
    const next = db.visits.filter((v) => v.customerId === c.id && v.status === 'planlagt' && v.plannedDate >= todayIso()).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))[0];
    return `<tr data-cust="${c.id}"><td class="small">${esc(c.customerNo || c.skvizbizId || '')}</td><td><b>${esc(c.name)}</b></td><td class="small">${esc(a0?.street)}${db.addresses.filter((a) => a.customerId === c.id).length > 1 ? ' <span class="pill">+1</span>' : ''}</td><td class="hide-m small">${ags.map(agrDesc).join(', ') || '–'}</td><td class="hide-m small">${esc([...new Set(ags.map((a) => route(a.routeId)?.name).filter(Boolean))].join(', '))}</td><td class="hide-m small">${next ? fmt(next.plannedDate) : ''}</td></tr>`; }).join('')}</table></div>`;
  const qi = document.getElementById('q'); qi.oninput = () => { ui.q = qi.value; const pos = qi.selectionStart; kunder(); const n = document.getElementById('q'); n.focus(); n.setSelectionRange(pos, pos); };
}
function kundekort(c) {
  const adrs = db.addresses.filter((a) => a.customerId === c.id);
  const ags = db.agreements.filter((a) => a.customerId === c.id);
  const vs = db.visits.filter((v) => v.customerId === c.id).sort((a, b) => b.plannedDate.localeCompare(a.plannedDate));
  const t = todayIso();
  const msgs = db.smsMessages.filter((m) => m.customerId === c.id).sort((a, b) => a.at.localeCompare(b.at));
  msgs.forEach((m) => (m.read = true));
  const invs = db.invoiceLinks.filter((l) => l.customerId === c.id);
  $view.innerHTML = `<div class="row" style="margin-bottom:10px"><button data-act="back">← Kunder</button><span class="sp"></span><button data-act="editCustomer" data-id="${c.id}">Rediger</button><button data-act="exportCustomer" data-id="${c.id}">GDPR-eksport</button><button class="bad" data-act="deleteCustomer" data-id="${c.id}">Slet</button></div>
  <div class="grid">
    <div class="card"><h2>${esc(c.name)} ${c.customerNo || c.skvizbizId ? `<span class="small mute">#${esc(c.customerNo || c.skvizbizId)}</span>` : ''}</h2>
      <div>📞 <a href="tel:${esc(D.normalizePhone(c.phone) || '')}">${esc(c.phone)}</a></div>
      ${c.email ? `<div>✉️ ${esc(c.email)}</div>` : ''}
      <div class="small mute">${esc(PAY[c.paymentMethod] ?? 'Bankoverførsel')} · ${esc(c.paymentTerms)} · ${c.vatLiable ? 'Momspligtig' : 'Momsfri'} · e-conomic kundenr.: ${c.economicNumber ?? '<i>ikke oprettet</i>'}</div>
      <div class="small mute">${esc(c.group || 'Privat kunder')} · ${esc(INVTYPE[c.invoiceType || 'email'])} · ${c.invoiceInterval === 'maaned' ? 'samlet pr. måned' : 'faktura ved hvert besøg'}${c.cvr ? ' · CVR ' + esc(c.cvr) : ''}</div>
      <div class="row small" style="margin-top:4px">${c.callBefore ? '<span class="pill warn">📞 Ring før besøg</span>' : ''}${c.smsBefore ? '<span class="pill">SMS før besøg</span>' : ''}${c.smsAfter ? '<span class="pill">SMS efter besøg</span>' : ''}</div>
      ${c.billTo && cust(c.billTo) ? `<div class="small" style="margin-top:4px">💳 Faktureres via: <a href="#" data-cust="${c.billTo}">${esc(cust(c.billTo).name)}</a></div>` : ''}
      ${(() => { const kids = db.customers.filter((x) => x.billTo === c.id && !x.deleted); return kids.length ? `<div class="small" style="margin-top:4px">💳 Betaler for ${kids.length}: ${kids.slice(0, 12).map((k) => `<a href="#" data-cust="${k.id}">${esc(k.name)}</a>`).join(', ')}${kids.length > 12 ? ' …' : ''}</div>` : ''; })()}
      ${c.rememberNext ? `<div class="warnbox">Husk næste gang: ${esc(c.rememberNext)}</div>` : ''}
      ${c.notes ? `<p>${esc(c.notes)}</p>` : ''}
    </div>
    <div class="card"><h2>Adresser</h2>${adrs.map((a) => `<div style="margin-bottom:8px"><b>${esc(a.street)}</b> <a class="small" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">Kør hertil ↗</a>${a.access ? `<div class="small">🔑 ${esc(a.access)}</div>` : ''}
      <div class="thumbs">${(a.photos || []).map((ph) => `<span class="th"><img src="${ph.src}" data-act="photo" data-src="${ph.id}" data-a="${a.id}" alt=""><button type="button" class="x" data-act="photoDel" data-a="${a.id}" data-p="${ph.id}" title="Slet">✕</button></span>`).join('')}
      <label class="btn small">📷 Tilføj billede<input type="file" accept="image/*" multiple data-photo="${a.id}" hidden></label></div></div>`).join('')}<button data-act="addAddress" data-id="${c.id}">+ Adresse</button></div>
  </div>
  <div class="card"><h2>Serviceaftaler</h2><table><tr><th>Ydelse</th><th>Adresse</th><th>Interval</th><th>Sæson</th><th>Rute</th><th>Pris</th><th></th></tr>
    ${ags.map((a) => `<tr><td>${esc(a.service)}${a.active ? '' : ' <span class="pill">inaktiv</span>'}</td><td>${esc(addr(a.addressId)?.street)}</td><td>${agrDesc(a)} · ${a.durationMin ?? 15} min</td><td class="small">${a.seasonMonths?.length ? `md. ${Math.min(...a.seasonMonths)}–${Math.max(...a.seasonMonths)}` : 'Hele året'}</td><td>${esc(route(a.routeId)?.name ?? '–')}</td><td>${kr(a.price)}</td><td><button data-act="editAgreement" data-id="${a.id}">Ret</button> <button data-act="bookVisit" data-id="${a.id}">Book besøg</button></td></tr>`).join('')}
  </table><button data-act="addAgreement" data-id="${c.id}" style="margin-top:8px">+ Aftale</button></div>
  <div class="grid">
    <div class="card"><h2>SMS</h2><div class="msgs">${msgs.map(msgHtml).join('') || '<p class="mute">Ingen beskeder</p>'}</div>
      <div class="row" style="margin-top:8px"><select id="tpl"><option value="">Skabelon…</option>${Object.keys(db.templates).map((k) => `<option>${k}</option>`).join('')}</select></div>
      <textarea id="smsText" placeholder="Skriv besked …"></textarea><div class="row"><span id="smsInfo" class="small mute"></span><span class="sp"></span>
      <button data-act="sendSms" data-id="${c.id}" title="Kun test – kræver SMS-gateway">Gateway (test)</button>
      <a class="btn pri" id="smsOwn" href="#">📱 Send fra min telefon</a></div>
      <p class="small mute">Gratis: åbner telefonens SMS-app med teksten. Beskeden logges her; kundens svar kommer på din telefon.</p></div>
    <div class="card"><h2>Besøg</h2><div style="max-height:380px;overflow:auto"><table><tr><th>Dato</th><th>Ydelse</th><th>Pris</th><th>Status</th></tr>
      ${vs.map((v) => `<tr style="${v.plannedDate === t ? 'font-weight:600' : ''}"><td>${fmt(v.plannedDate)} ${v.plannedDate.slice(0, 4)}${v.plannedDate !== v.rhythmDate ? ' <span class="small mute" title="Grundrytme">(' + fmt(v.rhythmDate) + ')</span>' : ''}</td><td class="small">${esc(v.service)}<br><span class="mute">${esc(addr(v.addressId)?.street)}</span>${v.completion?.note ? `<br>💬 ${esc(v.completion.note)}` : ''}</td><td>${kr(v.price)}</td><td>${pill(v.status)} ${v.status === 'planlagt' || v.status === 'udsat' ? `<button class="small" data-act="visit" data-id="${v.id}">…</button>` : ''}</td></tr>`).join('')}
    </table></div>
    ${invs.length ? `<h3>Fakturaer</h3>${invs.map((l) => `<div class="small">${l.invoiceNumber ? 'Faktura ' + l.invoiceNumber : 'Kladde ' + (l.draftNumber ?? '–')} · ${kr(l.total)} · <span class="pill ${INV[l.status]}">${l.status}</span> ${l.payment ? `<span class="pill ${l.payment === 'betalt' ? 'ok' : 'warn'}">${l.payment}</span>` : ''}</div>`).join('')}` : ''}</div>
  </div>`;
  $view.querySelectorAll('[data-photo]').forEach((inp) => (inp.onchange = async () => { const a = addr(inp.dataset.photo); a.photos ||= [];
    for (const f of inp.files) { try { a.photos.push({ id: S.uid('ph'), src: await shrinkImage(f), at: new Date().toISOString() }); } catch (err) { toast('Kunne ikke læse billedet'); } }
    S.audit(db, ui.user.id, 'address.photo', a.id); save(); render(); }));
  const tx = document.getElementById('smsText'), info = document.getElementById('smsInfo'), own = document.getElementById('smsOwn');
  const upd = () => { const p = D.smsParts(tx.value); info.textContent = tx.value ? `${p.chars} tegn · ${p.parts} SMS · ${p.encoding}` : ''; own.href = smsLink(D.normalizePhone(c.phone) || '', tx.value); };
  tx.oninput = upd; upd();
  own.onclick = (e) => { if (!tx.value.trim()) { e.preventDefault(); return toast('Skriv en besked først'); }
    logManualSms(c, tx.value.trim()); setTimeout(render, 300); };
  document.getElementById('tpl').onchange = (e) => { const tpl = db.templates[e.target.value]; if (!tpl) return; const nv = vs.filter((v) => v.status === 'planlagt' && v.plannedDate >= t).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))[0];
    tx.value = D.renderTemplate(tpl, { navn: c.name.split(' ')[0], dato: nv ? fmt(nv.plannedDate) : '', tid: '', nydato: '' }); upd(); };
}
const msgHtml = (m) => `<div class="msg ${m.dir}">${esc(m.text)}<div class="meta">${fmtTs(m.at)} · ${m.dir === 'ud' ? esc(m.status) + (m.parts > 1 ? ` · ${m.parts} dele` : '') + (m.error ? ' · ' + esc(m.error) : '') : esc(m.phone)}</div></div>`;

const GROUPS = ['Privat kunder', 'Erhverv', 'Offentlig', 'Boligforening'];
const INVTYPE = { email: 'Email PDF (A4-faktura)', sms: 'Faktura på SMS', ean: 'EAN (offentlig)', print: 'Papir (A4-faktura udleveres)' };
const yn = (name, val) => `<select name="${name}"><option value="0" ${!val ? 'selected' : ''}>Nej</option><option value="1" ${val ? 'selected' : ''}>Ja</option></select>`;
function customerForm(c) {
  const isNew = !c; c ||= { name: '', phone: '', email: '', notes: '', paymentTerms: 'Netto 8 dage', paymentDays: 8, vatLiable: true, marketingConsent: false, group: 'Privat kunder', invoiceType: 'email', invoiceInterval: 'besoeg' };
  openDlg(`<h2>${isNew ? 'Ny kunde' : 'Rediger kunde'}</h2>
    <h3>Stamoplysninger</h3>
    <div class="row"><label><span>Kundenr.</span><input name="customerNo" value="${esc(c.customerNo || c.skvizbizId || '')}" style="width:120px"></label><label><span>Kundegruppe</span><select name="group">${GROUPS.map((g) => `<option ${g === (c.group || 'Privat kunder') ? 'selected' : ''}>${g}</option>`).join('')}</select></label></div>
    <label><span>Navn / firma *</span><input name="name" required value="${esc(c.name)}"></label>
    ${isNew ? `<label><span>Adresse *</span><input name="street" required placeholder="Vej 1, 9870 Sindal"></label>` : ''}
    <div class="row"><label><span>Mobilnr. *</span><input name="phone" required value="${esc(c.phone)}" inputmode="tel"></label><label><span>Fastnet nr.</span><input name="landline" value="${esc(c.landline || '')}" inputmode="tel"></label></div>
    <label><span>E-mail</span><input name="email" type="email" value="${esc(c.email)}"></label>
    <div class="row"><label><span>CVR nr.</span><input name="cvr" value="${esc(c.cvr || '')}" style="width:120px"></label><label><span>Kontaktperson</span><input name="contact" value="${esc(c.contact || '')}"></label></div>
    <h3>Fakturering og betaling</h3>
    <div class="row"><label><span>Fakturatype</span><select name="invoiceType">${Object.entries(INVTYPE).map(([k, v]) => `<option value="${k}" ${k === (c.invoiceType || 'email') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label><span>Fakturainterval</span><select name="invoiceInterval"><option value="besoeg" ${c.invoiceInterval !== 'maaned' ? 'selected' : ''}>Ved hvert besøg</option><option value="maaned" ${c.invoiceInterval === 'maaned' ? 'selected' : ''}>Samlet pr. måned</option></select></label>
    <label><span>Betalingsbetingelser: d.d. +</span><input name="paymentDays" type="number" min="0" value="${c.paymentDays ?? 8}" style="width:70px"> dage</label></div>
    <div class="row"><label><span>Betaling</span><select name="paymentMethod">${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${k === (c.paymentMethod || 'bank') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label><input type="checkbox" name="vatLiable" ${c.vatLiable ? 'checked' : ''}> Momspligtig</label></div>
    <h3>Bemærkninger og notater</h3>
    <div class="row"><label><span>Ring før besøg</span>${yn('callBefore', c.callBefore)}</label><label><span>SMS før besøg</span>${yn('smsBefore', c.smsBefore)}</label><label><span>SMS efter besøg</span>${yn('smsAfter', c.smsAfter)}</label><label><input type="checkbox" name="marketingConsent" ${c.marketingConsent ? 'checked' : ''}> Samtykke til markedsførings-SMS</label></div>
    ${isNew ? `<label><span>Husk hver gang (udskrives på ruteplan)</span><input name="access" placeholder="Alt på huset, nøgle under potte …"></label>` : '<p class="small mute">"Husk hver gang" står på hver adresse (ret under Adresser).</p>'}
    <label><span>Husk næste gang (udskrives på ruteplan én gang, slettes ved færdigmelding)</span><input name="rememberNext" value="${esc(c.rememberNext || '')}"></label>
    <label><span>Internt notat (udskrives ikke – undgå følsomme oplysninger)</span><textarea name="notes">${esc(c.notes)}</textarea></label>
    ${isNew ? `<h3>Første aftale</h3>${agreementFields({})}` : ''}`,
  (f) => {
    if (!D.normalizePhone(f.phone)) return 'Ugyldigt mobilnummer';
    const dup = db.customers.find((x) => x !== c && !x.deleted && D.normalizePhone(x.phone) === D.normalizePhone(f.phone));
    if (dup && !confirm(`${dup.name} har samme nummer. Gem alligevel?`)) return false;
    Object.assign(c, { customerNo: f.customerNo.trim(), group: f.group, name: f.name.trim(), phone: f.phone.trim(), landline: f.landline.trim(), email: f.email.trim(), cvr: f.cvr.trim(), contact: f.contact.trim(),
      invoiceType: f.invoiceType, invoiceInterval: f.invoiceInterval, paymentDays: Math.max(0, +f.paymentDays || 0), paymentTerms: `Netto ${Math.max(0, +f.paymentDays || 0)} dage`, paymentMethod: f.paymentMethod, vatLiable: !!f.vatLiable,
      callBefore: f.callBefore === '1', smsBefore: f.smsBefore === '1', smsAfter: f.smsAfter === '1', marketingConsent: !!f.marketingConsent, rememberNext: f.rememberNext.trim(), notes: f.notes });
    if (isNew) {
      c.id = S.uid('c'); db.customers.push(c);
      const a = { id: S.uid('adr'), customerId: c.id, street: f.street.trim(), lat: null, lng: null, access: f.access || '' }; db.addresses.push(a);
      const err = saveAgreement(null, c.id, a.id, f); if (err) return err;
      ui.customer = c.id; ui.tab = 'kunder';
    }
    S.audit(db, ui.user.id, isNew ? 'customer.create' : 'customer.edit', c.id);
  });
}
function agreementFields(a) {
  return `<label><span>Ydelse</span><input name="service" value="${esc(a.service ?? 'Vinduespudsning ude')}"></label>
  <div class="row"><label><span>Pris ekskl. moms</span><input name="price" type="number" min="0" step="1" value="${a.price ?? 300}" style="width:110px"></label>
  <label><span>Interval</span><select name="intervalWeeks">${[0, 1, 2, 3, 4, 6, 8, 10, 12, 16, 26, 52].map((n) => `<option value="${n}" ${n === (a.intervalWeeks ?? 4) ? 'selected' : ''}>${n ? 'Hver ' + n + '. uge' : 'Ikke fast'}</option>`).join('')}</select></label>
  <label><span>Tid (min)</span><input name="durationMin" type="number" min="1" value="${a.durationMin ?? 15}" style="width:80px"></label>
  <label><span>Rute</span><select name="routeId"><option value="">Ingen</option>${db.routes.map((r) => `<option value="${r.id}" ${r.id === a.routeId ? 'selected' : ''}>${esc(r.name)} (hver ${r.intervalWeeks}. uge)</option>`).join('')}</select></label></div>
  <div class="row"><label><span>Første besøg (tom = næste gang ruten kører)</span><input name="anchorDate" type="date" value="${a.anchorDate ?? ''}"></label>
  <label><span>Sæson fra–til (måned)</span><input name="sFrom" type="number" min="1" max="12" value="${a.seasonMonths?.length ? Math.min(...a.seasonMonths) : 1}" style="width:60px"> – <input name="sTo" type="number" min="1" max="12" value="${a.seasonMonths?.length ? Math.max(...a.seasonMonths) : 12}" style="width:60px"></label></div>
  ${a.id ? `<label><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> Aktiv</label>` : `<label><span>Adgangsforhold</span><input name="access" placeholder="Nøgle, kode, hund …"></label>`}`;
}
function saveAgreement(a, customerId, addressId, f) {
  const price = Number(f.price); if (!(price >= 0)) return 'Ugyldig pris';
  const sf = +f.sFrom, st = +f.sTo; const months = []; for (let m = sf; ; m = (m % 12) + 1) { months.push(m); if (m === st || months.length > 12) break; }
  const anchorDate = f.anchorDate || D.nextRouteDate(route(f.routeId), todayIso()) || todayIso();
  const vals = { service: f.service, price, intervalWeeks: +f.intervalWeeks, durationMin: Math.max(1, +f.durationMin || 15), routeId: f.routeId || null, anchorDate, seasonMonths: months.length >= 12 ? [] : months };
  if (!a) { a = { id: S.uid('ag'), customerId, addressId, active: true, ...vals }; db.agreements.push(a); }
  else {
    const rhythmChanged = a.intervalWeeks !== vals.intervalWeeks || a.anchorDate !== vals.anchorDate || JSON.stringify(a.seasonMonths) !== JSON.stringify(vals.seasonMonths) || a.active !== !!f.active;
    Object.assign(a, vals, { active: !!f.active });
    // fremtidige planlagte besøg får ny pris/rute; ved ændret rytme genplanlægges de
    const t = todayIso();
    if (rhythmChanged) db.visits = db.visits.filter((v) => !(v.agreementId === a.id && v.status === 'planlagt' && v.plannedDate >= t));
    else db.visits.forEach((v) => { if (v.agreementId === a.id && v.status === 'planlagt' && v.plannedDate >= t) Object.assign(v, { price, routeId: a.routeId, service: a.service, durationMin: a.durationMin }); });
  }
  if (a.active) { const mine = db.visits.filter((v) => v.agreementId === a.id); db.visits.push(...D.generateVisits(a, todayIso() > a.anchorDate ? todayIso() : a.anchorDate, D.addDays(todayIso(), 120), mine, db.closedDays)); }
  S.audit(db, ui.user.id, 'agreement.save', a.id, vals);
  if (!D.agreementFitsRoute(a, route(a.routeId))) setTimeout(() => toast(`Bemærk: aftalen følger ikke rutens rytme (${routeWhen(route(a.routeId))}). Tjek interval/startdato.`), 50);
}

/* ---------------- Kalender (uge) ---------------- */
/** Advarsler øverst i kalenderen (erstatter Overblik). */
function alertsStrip() {
  const t = todayIso(); const out = [];
  const overdue = db.visits.filter((v) => (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate < t);
  if (overdue.length) out.push(`<span class="alert">⏰ ${overdue.length} besøg i fortiden er ikke færdigmeldt <button data-act="showOverdue">Vis</button></span>`);
  const nd = D.nextWorkday(D.addDays(t, 1), db.closedDays); const tm = db.visits.filter((v) => v.plannedDate === nd && v.status === 'planlagt');
  const sent = new Set(db.smsMessages.filter((m) => m.clientRef?.startsWith('varsel:')).map((m) => m.clientRef.slice(7)));
  const left = tm.filter((v) => !sent.has(v.id) && D.normalizePhone(cust(v.customerId)?.phone)).length;
  if (left) out.push(`<span class="alert">📱 SMS til ${fmt(nd)}: ${left} mangler <button data-act="smsTomorrow">Send</button></span>`);
  const dbl = D.findDoubleBookings(db.visits.filter((v) => v.plannedDate >= t));
  if (dbl.length) out.push(`<span class="alert">⚠️ ${dbl.length} mulige dobbeltbookinger <button data-act="showDbl">Vis</button></span>`);
  if (isAdmin()) {
    const od = db.invoiceLinks.filter((l) => l.status === 'bogført' && l.payment !== 'betalt' && l.dueDate && l.dueDate < t);
    if (od.length) out.push(`<span class="alert">💸 ${od.length} faktura${od.length > 1 ? 'er' : ''} ikke betalt til tiden (${kr(Math.round(od.reduce((s2, l) => s2 + (l.remainder ?? l.gross ?? 0), 0)))}) <button data-tab="faktura">Vis</button></span>`);
    const bad = db.invoiceLinks.filter((l) => l.status === 'fejl' || (l.status === 'kladde' && (l.attempts || 0) >= 3));
    if (bad.length) out.push(`<span class="alert">⚠️ ${bad.length} faktura${bad.length > 1 ? 'er' : ''} kunne ikke laves i e-conomic <button data-tab="faktura">Vis</button></span>`);
  }
  const chk = dataCheck().slice(0, 2).reduce((s2, [, it]) => s2 + it.length, 0);
  if (chk) out.push(`<span class="alert">📋 ${chk} ting at tjekke i data <button data-act="showCheck">Vis</button></span>`);
  return out.length ? `<div class="alerts">${out.join('')}</div>` : '';
}
/** Økonomi for en mængde besøg (som SkvizBiz' "Total for uge"). */
function econ(vs, byRoute = false) {
  const live = vs.filter((v) => v.status !== 'aflyst' && v.status !== 'forgaeves');
  const sum = live.reduce((s2, v) => s2 + D.visitTotal(v), 0); const min = mins(live);
  const groups = new Map(); for (const v of live) { const k = (v.routeId || '-') + '|' + v.plannedDate; groups.set(k, [...(groups.get(k) || []), v]); }
  let km = 0; for (const [, g] of groups) { const r = route(g[0].routeId); const o = r?.order || []; g.sort((a, b) => (o.indexOf(a.addressId) + 1 || 999) - (o.indexOf(b.addressId) + 1 || 999)); km += routeKm(g.map((v) => addr(v.addressId)).filter(Boolean)) * 1.3; }
  const prov = live.reduce((s2, v) => s2 + D.visitTotal(v) * ((v.split?.length ? v.split : defaultSplit(v)).reduce((t2, x) => t2 + x.pct, 0) / 100), 0);
  const hours = min / 60;
  // Google-køretid pr. dag (samme som dagsplanen) eller pr. rute; skøn kun hvis Google mangler
  let gSec = 0, gM = 0, gOk = !!db.settings.googleKey && live.length > 0, gWait = false;
  if (gOk) {
    const st = startPoint(); const parts = new Map();
    for (const v of live) { const k = byRoute ? v.routeId + '|' + v.plannedDate : v.plannedDate; parts.set(k, [...(parts.get(k) || []), v]); }
    for (const [k, g] of parts) {
      const day = g[0].plannedDate; const ids = byRoute ? routeStops(g[0].routeId, day).filter((v) => g.includes(v)).map((v) => v.id) : dayOrder(day, g);
      const r = googleFor(byRoute ? gKey('route:' + g[0].routeId + day, ids) : gKey(day + 'cur', ids), ids, { start: st, optimize: false });
      if (r && !r.error) { const t = DP.sumLegs(r.legs); gSec += t.sec; gM += t.m; } else { gOk = false; gWait = !r?.error; }
    }
  }
  return { n: live.length, sum, min, km: gOk ? Math.round(gM / 1000) : Math.round(km), drive: gOk ? Math.round(gSec / 60) : Math.round(km / 50 * 60), google: gOk, gWait, prov, perHour: hours ? sum / hours : 0, wage: hours ? prov / hours : 0 };
}
function kalender() {
  const ws = ui.weekStart; const rf = ui.calRoute || '';
  const wv = db.visits.filter((v) => v.plannedDate >= ws && v.plannedDate <= D.addDays(ws, 6) && (!rf || v.routeId === rf));
  // weekend vises kun, når der ligger besøg på den
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => D.addDays(ws, i)).filter((d, i) => i < 5 || wv.some((v) => v.plannedDate === d));
  if (ui.calDay && (ui.calDay < ws || ui.calDay > D.addDays(ws, 6))) ui.calDay = null;
  const pick = ui.calPick?.split('|'); if (pick && (pick[1] < ws || pick[1] > D.addDays(ws, 6) || !route(pick[0]))) ui.calPick = null;
  const pv = ui.calPick ? wv.filter((v) => v.routeId === pick[0] && v.plannedDate === pick[1]) : ui.calDay ? wv.filter((v) => v.plannedDate === ui.calDay) : wv;
  const e = econ(pv, !!ui.calPick);
  const q = D.invoiceQueue(db.visits, db.invoiceLinks); const open = db.invoiceLinks.filter((l) => l.status === 'bogført' && l.payment !== 'betalt');
  const t = todayIso();
  $view.innerHTML = `${alertsStrip()}
  <div class="toolbar"><div class="seg"><button data-act="wk" data-d="-7">‹</button><button data-act="wk" data-d="0">I dag</button><button data-act="wk" data-d="7">›</button></div>
    <h2 class="sp">Uge ${D.isoWeek(ws)} <span class="mute small">${fmt(ws)} – ${fmt(days[days.length - 1])} ${ws.slice(0, 4)}</span></h2>
    ${ui.visSel?.size ? `<span class="pill">${ui.visSel.size} kunder valgt</span><button data-act="moveSelVisits">Flyt valgte kunder …</button><button data-act="clearVisSel">Ryd</button>` : ''}
    ${ui.calSel?.size ? `<span class="pill">${ui.calSel.size} ruter valgt</span><button class="pri" data-act="printSel">🖨 Udskriv valgte</button><button data-act="clearSel">Ryd</button>` : `<span class="small mute hide-m">Ctrl+klik: vælg ruter eller kunder</span>`}<button data-act="selWeek">Vælg alle i ugen</button>
    <select id="calRoute"><option value="">Alle ruter</option>${db.routes.map((r) => `<option value="${r.id}" ${rf === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
  <div class="cal timeline" style="--ndays:${days.length}">
    <div class="weekwrap"><div class="taxis">${(() => { const mx = Math.max(480, ...days.map((d) => { const vs = wv.filter((v) => v.plannedDate === d && v.status !== 'aflyst'); return mins(vs) + 30; })); return Array.from({ length: Math.ceil(mx / 60) + 1 }, (_, h) => `<div>${h === 0 ? 'Start' : h === 1 ? '1 time' : h + ' timer'}</div>`).join(''); })()}</div>
    <div class="week">${days.map((d) => { const vs = wv.filter((v) => v.plannedDate === d); const closed = D.isClosedDay(d, db.closedDays);
      const groups = new Map(); for (const v of vs) { const k = v.routeId || ''; groups.set(k, [...(groups.get(k) || []), v]); }
      return `<div class="day ${closed ? 'closed' : ''} ${d === t ? 'today' : ''} ${ui.calDay === d ? 'picked' : ''}" data-day="${d}" title="Klik på et tomt felt: vis dagens tal · Dobbeltklik: dagsplan"><div class="dayhead"><button class="daybtn" data-act="dayOpts" data-d="${d}" title="Ferie/fridag, dagsplan, flyt dagen">${fmt(d)}</button><span class="sp"></span>${vs.length ? `<button class="icon ${db.dayPlans?.[d] ? 'on' : ''}" data-act="dayPlan" data-d="${d}" title="Dagsplan: rækkefølge og køretid for hele dagen">🗺${db.dayPlans?.[d]?.legs ? ` <span class="small">${D.hm(Math.round(DP.sumLegs(db.dayPlans[d].legs).sec / 60))}</span>` : ''}</button>` : ''}${vs.some((v) => v.status === 'planlagt') ? `<button class="icon" data-act="dayMenu" data-d="${d}" title="Flyt/aflys/udfør hele dagen">⋯</button>` : ''}</div>${closed ? `<div class="closedlbl">${esc(db.closedInfo?.[d]?.label || (D.weekday(d) >= 5 ? 'Weekend' : D.danishHolidays(+d.slice(0, 4)).has(d) ? 'Helligdag' : 'Lukket'))}</div>` : ''}
        ${[...groups.entries()].map(([rid, gv]) => { const r = route(rid); const order = r?.order || []; gv.sort((a, b) => ((order.indexOf(a.addressId) + 1 || 999) - (order.indexOf(b.addressId) + 1 || 999)));
          const allDone = gv.every((v) => v.status !== 'planlagt' && v.status !== 'udsat');
          const key = (r?.id || '') + '|' + d;
          const gd = r ? (ui._google || {})[gKey('route:' + r.id + d, gv.filter((v) => v.status !== 'aflyst').map((v) => v.id))] : null; const drv = gd?.legs ? Math.round(DP.sumLegs(gd.legs).sec / 60) : 0;
          const bm = mins(gv.filter((v) => v.status !== 'aflyst')) + drv;
          return `<div style="--min:${Math.max(bm, 20)}" class="rblock ${allDone ? 'done' : ''} ${r && ui.calSel?.has(key) ? 'sel' : ''} ${ui.calPick === key ? 'picked' : ''}" ${r ? `data-rsel="${key}"` : ''}>${r ? `<div class="grip" data-act="routeMenu" data-r="${r.id}" data-d="${d}" draggable="true" data-dragroute="${key}" title="Klik: muligheder · Træk: flyt ruten · Ctrl+klik: vælg">⋮⋮</div>` : ''}<div class="rhead" ${r ? `data-dblroute="${r.id}" data-day="${d}" draggable="true" data-dragroute="${key}" title="Klik: vis rutens tal og muligheder · Dobbeltklik: færdigmeld · Træk: flyt hele ruten"` : ''}><b>${esc(r?.name ?? 'Uden rute')}</b><span class="badge">${gv.length}</span></div>
          <div class="rmeta"><span>${D.hm(bm)} t${drv ? ' inkl. kørsel' : ''} · ${kr(gv.filter((v) => v.status !== 'aflyst').reduce((s2, v) => s2 + D.visitTotal(v), 0))}</span>${r ? `<button class="icon" data-act="printRoute" data-r="${r.id}" data-d="${d}" title="Udskriv ruteseddel">🖨</button>` : ''}</div>
          ${gv.map((v) => `<div class="vline ${v.status} ${ui.visSel?.has(v.id) ? 'vsel' : ''}" draggable="${v.status === 'planlagt' || v.status === 'udsat'}" data-visit="${v.id}">${esc(cust(v.customerId)?.name)}</div>`).join('')}</div>`; }).join('')}</div>`; }).join('')}</div></div>
    <aside class="econ"><h3>${ui.calPick ? `${esc(route(pick[0]).name)} · ${fmt(pick[1])}` : ui.calDay ? `Total for ${fmt(ui.calDay)}` : `Total for uge ${D.isoWeek(ws)}`}</h3>${ui.calPick || ui.calDay ? `<p class="small"><a href="#" data-act="calWeek">← Vis hele ugen</a>${ui.calDay ? ` · <a href="#" data-act="dayPlan" data-d="${ui.calDay}">🗺 Dagsplan</a>` : ''}</p>` : ''}
      ${ui.calPick ? `<div class="sidemenu">${routeMenuButtons(pick[0], pick[1])}</div>` : ''}
      <dl><dt>Antal besøg</dt><dd>${e.n}</dd><dt>Planlagt omsætning</dt><dd>${kr(Math.round(e.sum))}</dd><dt>Inkl. moms</dt><dd>${kr(Math.round(e.sum * 1.25))}</dd>
      <dt>Tidsforbrug</dt><dd>${D.hm(e.min)} t</dd><dt>Forventet kørsel</dt><dd>${e.google ? '' : '≈ '}${D.hm(e.drive)} t (${e.km} km)</dd><dt>Provision</dt><dd>${kr(Math.round(e.prov))}</dd>
      <dt>Oms. pr. time</dt><dd>${kr(Math.round(e.perHour))}</dd><dt>Timeløn (provision)</dt><dd>${kr(Math.round(e.wage))}</dd></dl>
      <h3>Fakturering</h3><dl>${ecoReal() ? (() => { const od = open.filter((l) => l.dueDate && l.dueDate < t); return `<dt><a href="#" data-tab="faktura">Ikke betalt til tiden</a></dt><dd${od.length ? ' style="color:var(--bad)"' : ''}>${od.length} · ${kr(Math.round(od.reduce((s2, l) => s2 + (l.remainder ?? l.gross ?? 0), 0)))}</dd>`; })()
        : `<dt><a href="#" data-tab="faktura">Klar til fakturering</a></dt><dd>${q.length} · ${kr(Math.round(q.reduce((s2, v) => s2 + D.visitTotal(v), 0)))}</dd>`}
      <dt>Åbne fakturaer</dt><dd>${open.length} · ${kr(Math.round(open.reduce((s2, l) => s2 + (l.remainder ?? l.total * 1.25), 0)))}</dd></dl>
      <p class="small mute">${e.google ? 'Kørsel fra Google Maps (fra og til startadressen).' : e.gWait ? 'Henter køretider fra Google …' : 'Kørsel ≈ luftlinje × 1,3 ved 50 km/t (Google-nøgle mangler).'} Træk et navn til en anden dag for at flytte.</p></aside>
  </div>`;
  document.getElementById('calRoute').onchange = (ev) => { ui.calRoute = ev.target.value; render(); };
  $view.querySelectorAll('.vline[draggable=true]').forEach((ch) => ch.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/plain', ui.visSel?.has(ch.dataset.visit) && ui.visSel.size > 1 ? 'many:' + [...ui.visSel].join(',') : ch.dataset.visit)));
  $view.querySelectorAll('[data-dragroute]').forEach((g) => g.addEventListener('dragstart', (ev) => { ev.stopPropagation(); ev.dataTransfer.setData('text/plain', 'route:' + g.dataset.dragroute); }));
  $view.querySelectorAll('.day').forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target.closest('button, .rblock, a, input, select')) return; ui.calDay = ui.calDay === d.dataset.day ? null : d.dataset.day; ui.calPick = null; render(); });
    d.addEventListener('dblclick', (ev) => { const rh = ev.target.closest('[data-dblroute]'); if (rh) { ui.tab = 'ruter'; ui.routeMode = 'fm'; ui.sel = new Set(); ui.route = rh.dataset.dblroute; ui.day = rh.dataset.day; ui._routeDayFor = ui.route + ui.day; ui.calPick = null; return render(); }
      if (ev.target.closest('button, .rblock, a')) return; if (wv.some((v) => v.plannedDate === d.dataset.day)) { ui.tab = 'dag'; ui.planDay = d.dataset.day; ui._planMode = db.dayPlans?.[d.dataset.day]?.mode || 'ruter'; render(); } });
    d.addEventListener('dragover', (ev) => { ev.preventDefault(); d.classList.add('drop'); });
    d.addEventListener('dragleave', () => d.classList.remove('drop'));
    d.addEventListener('drop', (ev) => { ev.preventDefault(); d.classList.remove('drop'); const id = ev.dataTransfer.getData('text/plain');
      if (id.startsWith('many:')) { const vs2 = id.slice(5).split(',').map((x) => db.visits.find((v) => v.id === x)).filter(Boolean); ui.visSel = new Set(); bulkDialog(vs2, `Flyt ${vs2.length} kunder`, d.dataset.day); }
      else if (id.startsWith('route:')) { const [rid, from] = id.slice(6).split('|'); if (from !== d.dataset.day) bulkDialog(db.visits.filter((v) => v.routeId === rid && v.plannedDate === from), `Flyt ${route(rid).name} fra ${fmt(from)}`, d.dataset.day); }
      else if (id) moveDialog(id, d.dataset.day); });
  });
}
function visitDialog(id) {
  const v = db.visits.find((x) => x.id === id); const c = cust(v.customerId);
  openDlg(`<h2>${esc(c.name)} – ${fmt(v.plannedDate)}</h2><p>${esc(v.service)} · ${esc(addr(v.addressId)?.street)} · ${kr(v.price)} · ${pill(v.status)}</p>
    <p class="small mute">Grundrytme: ${fmt(v.rhythmDate)} · serie #${v.seriesIndex}</p>
    <div class="row"><button type="button" data-act="moveFromDlg" data-id="${id}">Flyt…</button><button type="button" data-act="cancelVisit" data-id="${id}" class="bad">Aflys</button><button type="button" data-cust="${c.id}">Kundekort</button></div>
    <h3>Historik</h3>${v.history.map((h) => `<div class="small">${esc(h.at?.slice?.(0, 16) ?? '')} · ${esc(h.action)} ${h.from ? esc(h.from) + ' → ' + esc(h.to) : ''} ${esc(h.note ?? '')}</div>`).join('') || '<div class="small mute">Ingen</div>'}`, null, 'Luk');
}
function moveDialog(id, newDate) {
  const v = db.visits.find((x) => x.id === id);
  openDlg(`<h2>Flyt besøg – ${esc(cust(v.customerId).name)}</h2>
    <label><span>Ny dato</span><input type="date" name="date" value="${newDate || v.plannedDate}" required></label>
    <label><input type="radio" name="mode" value="keep" checked> <b>Behold grundrytmen</b> – kun dette besøg flyttes</label>
    <label><input type="radio" name="mode" value="shift"> <b>Forskyd hele serien</b> – alle senere besøg flyttes tilsvarende</label>
    <label><input type="checkbox" name="notify"> Send SMS til kunden om ny dato (mock)</label>`,
  async (f) => {
    if (D.isClosedDay(f.date, db.closedDays) && !confirm('Datoen er en lukkedag/weekend. Flyt alligevel?')) return false;
    S.moveVisit(db, ui.user, id, f.date, f.mode);
    if (f.notify) await S.sendSms(db, ui.user, { customerId: v.customerId, text: `Hej ${cust(v.customerId).name.split(' ')[0]}. Vores besøg er flyttet til ${fmt(f.date)}. Svar gerne hvis det ikke passer. Mvh. Sindal Vinduespolering` }, sms);
    toast(f.mode === 'shift' ? 'Serien er forskudt' : 'Besøget er flyttet');
  });
}

function bulkDialog(vs, title, presetDate) {
  vs = vs.filter((v) => v.status === 'planlagt' || v.status === 'udsat');
  if (!vs.length) return toast('Vælg mindst ét planlagt besøg');
  const from = vs[0].plannedDate; const nd = presetDate || D.nextWorkday(D.addDays(from, 1), db.closedDays);
  openDlg(`<h2>${esc(title)} – ${vs.length} besøg</h2>
    <label><input type="radio" name="mode" value="keep" checked> <b>Flyt til</b> <input type="date" name="date" value="${nd}"> – kundernes rytme bevares</label>
    <label><input type="radio" name="mode" value="shift"> <b>Flyt og forskyd</b> til samme dato – deres næste besøg rykker også</label>
    <label><input type="radio" name="mode" value="udfoert"> <b>Marker udført</b></label>
    <label><input type="radio" name="mode" value="skip"> <b>Aflys</b> – kunderne får næste besøg i rytmen</label>
    <label><span>Bemærkning</span><input name="note"></label>
    <label><input type="checkbox" name="sms" checked> Vis SMS-liste bagefter (ved flyt/aflys)</label>`,
  (f) => {
    for (const v of vs) {
      if (f.mode === 'skip') S.registerVisit(db, ui.user, v.id, { result: 'aflyst', opId: 'bulk:' + v.id + ':' + v.plannedDate, note: f.note });
      else if (f.mode === 'udfoert') S.registerVisit(db, ui.user, v.id, { result: 'udfoert', opId: 'bulk:' + v.id + ':' + v.plannedDate, note: f.note });
      else S.moveVisit(db, ui.user, v.id, f.date, f.mode);
    }
    S.audit(db, ui.user.id, 'visits.bulk', '-', { mode: f.mode, n: vs.length });
    ui.sel = new Set();
    if (f.sms && f.mode !== 'udfoert') setTimeout(() => smsListDialog(vs, f.mode === 'skip' ? null : f.date), 50);
  });
}
/** Liste med ét tryk pr. kunde → åbner telefonens SMS-app. Logges på kundekortet. */
function smsListDialog(visits, newDate, title, tplOverride) {
  const tpl = tplOverride || (newDate ? db.templates.aflyst : 'Hej {navn}. Vi må desværre aflyse vinduespudsningen {dato}. Vi kommer igen ved næste planlagte besøg. Mvh. Sindal Vinduespolering');
  ui._smsList = visits.map((v) => { const c = cust(v.customerId); return { v, c, text: D.renderTemplate(tpl, { navn: c.name.split(' ')[0], dato: fmt(v.plannedDate), nydato: newDate ? fmt(newDate) : '' }) }; });
  openDlg(`<h2>${esc(title || 'Giv kunderne besked')}</h2><p class="small mute">Tryk på hver kunde – telefonens SMS-app åbner med teksten.</p>
    ${ui._smsList.map((x, i) => `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="sp"><b>${esc(x.c.name)}</b><div class="small mute">${esc(x.text)}</div></div><a class="btn pri" data-smsi="${i}" href="${smsLink(D.normalizePhone(x.c.phone), x.text)}">📱 Send</a></div>`).join('') || '<p class="mute">Ingen</p>'}`, null, 'Færdig');
}
function logManualSms(c, text, clientRef) {
  if (clientRef && db.smsMessages.some((m) => m.clientRef === clientRef)) return;
  db.smsMessages.push({ id: S.uid('m'), clientRef, dir: 'ud', customerId: c.id, phone: D.normalizePhone(c.phone), text, kind: 'service', status: 'sendt fra telefon', at: new Date().toISOString(), by: ui.user.id, ...D.smsParts(text) });
  S.audit(db, ui.user.id, 'sms.manual', c.id); save();
}

/** Datakontrol: finder ting der bør rettes – direkte i data, uden import. */
function dataCheck() {
  const live = db.customers.filter((c) => !c.deleted);
  const agOf = (c) => db.agreements.filter((g) => g.customerId === c.id && g.active !== false);
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
  const byAddr = new Map(); for (const a of db.addresses) { const c = cust(a.customerId); if (!c || c.deleted) continue; const k = norm(a.street); byAddr.set(k, [...(byAddr.get(k) || []), c]); }
  const dupes = [...byAddr.values()].map((cs) => [...new Set(cs)]).filter((cs) => cs.length > 1);
  return [
    ['Kunder uden kundenr. (kun fundet i ruteoversigt)', live.filter((c) => !c.customerNo).map((c) => ({ c, txt: db.addresses.find((a) => a.customerId === c.id)?.street || '' }))],
    ['Ruter uden kendt dato', db.routes.filter((r) => r.anchorUnknown).map((r) => ({ r, txt: r.name }))],
    ['Kunder uden aftaler', live.filter((c) => !agOf(c).length).map((c) => ({ c, txt: db.addresses.find((a) => a.customerId === c.id)?.street || '' }))],
    ['Faktureres via anden konto – betaler ikke fundet', live.filter((c) => c.billingSkvizId && !c.billTo).map((c) => ({ c, txt: `SkvizBiz betaler-id ${c.billingSkvizId}` }))],
    ['Kunder uden telefon og e-mail', live.filter((c) => !c.phone && !c.email).map((c) => ({ c, txt: '' }))],
    ['ℹ️ Flere kunder på samme adresse (kun til orientering)', dupes.map((cs) => ({ c: cs[0], txt: cs.map((x) => `${x.name}${x.customerNo ? ' #' + x.customerNo : ' (uden kundenr.)'}`).join('  ·  '), others: cs.slice(1) }))],
    ['ℹ️ Faste aftaler uden rute (planlægges på deres egen dato – kun til orientering)', live.flatMap((c) => agOf(c).filter((g) => g.intervalWeeks && !g.routeId).map((g) => ({ c, txt: `${g.service} · hver ${g.intervalWeeks}. uge · ${kr(g.price)}` })))],
  ];
}
function checkDialog() {
  const sec = dataCheck();
  openDlg(`<h2>Datakontrol</h2><p class="small mute">Klik på en kunde for at rette. Listen opdateres, når du åbner den igen.</p>
    ${sec.map(([title, items], i) => `<details ${i < 2 && items.length && !title.startsWith('ℹ️') ? 'open' : ''}><summary><b>${title}</b> (${items.length})</summary>${items.length ? `<table>${items.slice(0, 300).map((x) => `<tr class="small"><td>${x.c ? `<a href="#" data-cust="${x.c.id}">${esc(x.c.name)}</a>` : `<a href="#" data-route="${x.r.id}">${esc(x.r.name)}</a>`}${(x.others || []).map((o) => ` · <a href="#" data-cust="${o.id}">${esc(o.name)}</a>`).join('')}</td><td>${esc(x.txt)}</td></tr>`).join('')}</table>` : '<p class="small mute">Ingen 👍</p>'}</details>`).join('')}
    ${(db.imports || []).some((b) => b.issues?.length) ? '<p><button type="button" data-act="showIssues">Vis advarsler fra importen</button></p>' : ''}`, null, 'Luk');
}
function dblDialog() {
  const groups = D.findDoubleBookings(db.visits.filter((v) => v.plannedDate >= todayIso()));
  openDlg(`<h2>Mulige dobbeltbookinger (${groups.length})</h2><p class="small mute">Samme adresse samme dag med samme opgave to gange, eller på to forskellige ruter. Aflys det besøg, der er forkert, eller ret aftalen på kundekortet.</p>
    ${groups.map((ids) => { const vs = ids.map((id) => db.visits.find((v) => v.id === id)); const c = cust(vs[0].customerId);
      return `<div class="card" style="padding:10px"><div class="row"><b class="sp"><a href="#" data-cust="${c.id}">${esc(c.name)}</a> · ${fmt(vs[0].plannedDate)} ${vs[0].plannedDate.slice(0, 4)}</b></div><div class="small mute">${esc(addr(vs[0].addressId)?.street)}</div>
      <table>${vs.map((v) => `<tr class="small"><td>${esc(v.service)}</td><td>${esc(route(v.routeId)?.name ?? 'Uden rute')}</td><td>${kr(v.price)}</td><td>${v.manual ? 'manuelt booket' : 'fast aftale'}</td><td>${v.status === 'planlagt' ? `<button type="button" class="bad" data-act="dblCancel" data-id="${v.id}">Aflys dette</button>` : pill(v.status)}</td></tr>`).join('')}</table></div>`; }).join('') || '<p class="mute">Ingen.</p>'}`, null, 'Luk');
}
function issuesDialog(batchId) {
  const bs = (db.imports || []).filter((b) => !b.rolledBack && b.issues?.length && (!batchId || b.batchId === batchId));
  const rows = bs.flatMap((b) => b.issues.map((i, k) => ({ ...i, key: b.batchId + ':' + k })));
  const findCust = (line) => { const no = (String(line).match(/^(\d{8})/) || [])[1]; return no ? db.customers.find((c) => c.customerNo === no) : null; };
  const nameIn = (msg) => db.customers.find((c) => c.name && String(msg).startsWith(c.name + ':')) || db.customers.find((c) => c.name && String(msg).includes('"' + c.name + '"'));
  const groups = [['Skal tjekkes', (i) => !i.warn || /kan høre til|ikke genkendt|ingen af kundens ruter|ukendt/.test(i.msg)], ['Flyttet / koblet automatisk', (i) => /flyttet til|koblet til/.test(i.msg)], ['Kun i ruteoversigt (uden kundenr.) – mulige dubletter', (i) => /ikke fundet i stamdata/.test(i.msg)], ['Øvrige', () => true]];
  const used = new Set();
  openDlg(`<h2>Advarsler fra importen</h2><p class="small mute">Klik på kunden for at rette, og markér som løst. "Ingen aftaler" og "flere aftaler" er ofte i orden.</p>
    ${groups.map(([title, f]) => { const g = rows.filter((r) => !used.has(r.key) && f(r)); g.forEach((r) => used.add(r.key)); if (!g.length) return '';
      return `<details ${title === 'Skal tjekkes' ? 'open' : ''}><summary><b>${title}</b> (${g.filter((r) => !r.done).length} uløste)</summary><table>${g.map((r) => { const c = findCust(r.line) || nameIn(r.msg);
        return `<tr class="small" style="opacity:${r.done ? .45 : 1}"><td style="color:var(${r.warn ? '--warn' : '--bad'})">${esc(r.msg)}</td><td>${c ? `<a href="#" data-cust="${c.id}">Åbn kunde</a>` : `<span class="mute">${esc(r.line)}</span>`}</td><td><button type="button" data-act="issueDone" data-k="${r.key}">${r.done ? '✓ Løst' : 'Markér løst'}</button></td></tr>`; }).join('')}</table></details>`; }).join('') || '<p class="mute">Ingen advarsler.</p>'}`, null, 'Luk');
}

/** Ruteseddel (til print) for én rute på én dag. */
function routeSheetHtml(r, day) {
  const stops = routeStops(r.id, day); const total = stops.filter((v) => v.status !== 'aflyst').reduce((s2, v) => s2 + D.visitTotal(v), 0);
  const km = Math.round(routeKm(stops.map((v) => addr(v.addressId)).filter(Boolean)) * 1.3);
  return `<div class="sheet-page"><h2>${fmt(day)} ${day.slice(0, 4)} uge ${D.isoWeek(day)} – Rute: ${esc(r.name)}</h2><div class="small mute">${esc(emp(r.employeeId)?.name || '')} · udskrevet ${fmtTs(new Date().toISOString())} · ${stops.length} besøg · ${D.hm(mins(stops))} t · ca. ${km} km</div>
    <table><tr><th>Nr</th><th>Adresse</th><th>Navn</th><th>Tlf.</th><th>Kont.</th><th style="text-align:right">Beløb</th><th>Bemærkninger</th><th>Opgave</th><th>Tid</th></tr>
    ${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId) || {}; const ag = db.agreements.find((x) => x.id === v.agreementId);
      return `<tr data-id="${v.id}" class="${v.status === 'aflyst' ? 'struck' : ''}"><td>${i + 1}</td><td>${esc(a.street)}</td><td>${esc(c?.name)}</td><td>${esc(c?.phone)}</td><td>${c?.paymentMethod === 'kontant' ? '✓' : ''}</td><td style="text-align:right">${kr(D.visitTotal(v))}</td><td class="small">${esc(a.access)}${c?.rememberNext ? `<br><b>Husk: ${esc(c.rememberNext)}</b>` : ''}${c?.callBefore ? '<br><b>Ring før besøg</b>' : ''}</td><td class="small">${esc(v.service)} (${ag?.intervalWeeks ? ag.intervalWeeks + 'u' : 'enkelt'})</td><td>${D.hm(v.durationMin ?? 15)}</td></tr>`; }).join('')}
    <tr><td colspan="5"><b>I alt (ekskl. moms)</b></td><td style="text-align:right"><b>${kr(total)}</b></td><td colspan="2"></td><td><b>${D.hm(mins(stops))}</b></td></tr></table></div>`;
}
/** Ét ark pr. dag med alle valgte ruter (følger dagsplanen hvis den findes). */
function daySheetHtml(day, rids) {
  const plan = db.dayPlans?.[day];
  let stops = rids.flatMap((rid) => routeStops(rid, day));
  if (plan?.order) stops.sort((a, b) => (plan.order.indexOf(a.id) + 1 || 9999) - (plan.order.indexOf(b.id) + 1 || 9999));
  const total = stops.filter((v) => v.status !== 'aflyst').reduce((s2, v) => s2 + D.visitTotal(v), 0);
  const km = plan?.legs ? Math.round(DP.sumLegs(plan.legs).m / 1000) : Math.round(routeKm(stops.map((v) => addr(v.addressId)).filter(Boolean)) * 1.3);
  const names = rids.map((rid) => route(rid)?.name).filter(Boolean);
  let lastR = null;
  return `<div class="sheet-page"><h2>${fmt(day)} ${day.slice(0, 4)} uge ${D.isoWeek(day)} – ${names.length > 1 ? 'Ruter' : 'Rute'}: ${esc(names.join(', '))}</h2>
    <div class="small mute">Udskrevet ${fmtTs(new Date().toISOString())} · ${stops.length} besøg · arbejde ${D.hm(mins(stops))} t · kørsel ca. ${km} km${plan ? ' · rækkefølge fra dagsplan' : ''}</div>
    <table><tr><th>Nr</th><th>Adresse</th><th>Navn</th><th>Tlf.</th><th>Kont.</th><th style="text-align:right">Beløb</th><th>Bemærkninger</th><th>Opgave</th><th>Tid</th></tr>
    ${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId) || {}; const ag = db.agreements.find((x) => x.id === v.agreementId);
      const sub = !plan && names.length > 1 && v.routeId !== lastR ? `<tr class="subhead"><td colspan="9"><b>${esc(route(v.routeId)?.name)}</b></td></tr>` : ''; lastR = v.routeId;
      return `${sub}<tr class="${v.status === 'aflyst' ? 'struck' : ''}"><td>${i + 1}</td><td>${esc(a.street)}</td><td>${esc(c?.name)}</td><td>${esc(c?.phone)}</td><td>${c?.paymentMethod === 'kontant' ? '✓' : ''}</td><td style="text-align:right">${kr(D.visitTotal(v))}</td><td class="small">${esc(a.access)}${c?.rememberNext ? `<br><b>Husk: ${esc(c.rememberNext)}</b>` : ''}${c?.callBefore ? '<br><b>Ring før besøg</b>' : ''}</td><td class="small">${esc(v.service)} (${ag?.intervalWeeks ? ag.intervalWeeks + 'u' : 'enkelt'})</td><td>${D.hm(v.durationMin ?? 15)}</td></tr>`; }).join('')}
    <tr><td colspan="5"><b>I alt (ekskl. moms)</b></td><td style="text-align:right"><b>${kr(total)}</b></td><td colspan="2"></td><td><b>${D.hm(mins(stops))}</b></td></tr></table></div>`;
}
/** A4-faktura til kunder med fakturatype "Papir". Fakturanummer tildeles af e-conomic. */
function invoiceHtml(v) {
  const c = cust(v.customerId); const payer = (c.billTo && cust(c.billTo)) || c; const a = addr(v.addressId) || {}; const pa = db.addresses.find((x) => x.customerId === payer.id) || a;
  const f = db.settings.firm || {}; const lines = [{ t: `${v.service} – ${a.street}`, p: v.price }, ...(v.extras || []).map((x) => ({ t: 'Ekstra: ' + x.text, p: Number(x.price) || 0 }))];
  const net = lines.reduce((s2, l) => s2 + l.p, 0); const days = payer.paymentDays ?? 8; const due = D.addDays(v.plannedDate, days);
  return `<div class="sheet-page invoice"><div class="inv-head"><div><h2>${esc(f.name || 'Sindal Vinduespolering')}</h2><div class="small">${esc(f.address || '')}<br>${f.cvr ? 'CVR ' + esc(f.cvr) : ''}${f.phone ? ' · Tlf. ' + esc(f.phone) : ''}${f.email ? '<br>' + esc(f.email) : ''}</div></div>
      <div class="inv-meta"><h2>Faktura</h2><div class="small">Fakturanr.: <i>tildeles i e-conomic</i><br>Dato: ${fmt(v.plannedDate)} ${v.plannedDate.slice(0, 4)}<br>Kundenr.: ${esc(payer.customerNo || '')}<br>Forfald: ${fmt(due)} ${due.slice(0, 4)} (d.d. + ${days} dage)</div></div></div>
    <div class="inv-to"><b>${esc(payer.name)}</b><br>${esc(pa.street || '')}${payer !== c ? `<br><span class="small">Leveringssted: ${esc(c.name)}, ${esc(a.street)}</span>` : ''}</div>
    <table><tr><th>Beskrivelse</th><th style="text-align:right">Beløb</th></tr>${lines.map((l) => `<tr><td>${esc(l.t)}</td><td style="text-align:right">${kr(l.p)}</td></tr>`).join('')}
      <tr><td style="text-align:right">I alt ekskl. moms</td><td style="text-align:right">${kr(net)}</td></tr><tr><td style="text-align:right">Moms 25 %</td><td style="text-align:right">${kr(Math.round(net * 25) / 100)}</td></tr>
      <tr><td style="text-align:right"><b>At betale</b></td><td style="text-align:right"><b>${kr(Math.round(net * 125) / 100)}</b></td></tr></table>
    <p class="small">Betaling: ${f.bank ? 'Bank reg./konto ' + esc(f.bank) : ''}${f.mobilepay ? ' · MobilePay ' + esc(f.mobilepay) : ''}${!f.bank && !f.mobilepay ? '<i>Udfyld bank/MobilePay under Admin → Firma</i>' : ''}. Angiv kundenr. ved betaling.</p></div>`;
}
function printView() {
  const keys = [...(ui.printSet || [])].map((k) => k.split('|')).filter(([rid]) => route(rid));
  const byDay = new Map(); for (const [rid, d] of keys) byDay.set(d, [...(byDay.get(d) || []), rid]);
  const days = [...byDay.keys()].sort();
  // A4-fakturaer er slået fra indtil e-conomic er koblet på (fakturanumre skal komme derfra)
  const invVisits = !db.settings.printInvoices ? [] : days.flatMap((d) => byDay.get(d).flatMap((rid) => routeStops(rid, d))).filter((v) => v.status === 'planlagt' || v.status === 'udsat').filter((v) => { const c = cust(v.customerId); return ((c.billTo && cust(c.billTo)) || c).invoiceType === 'print'; });
  $view.innerHTML = `<div class="toolbar noprint"><button data-act="planBack">← Kalender</button><h2 class="sp">Udskriv ${days.length} ${days.length === 1 ? 'dag' : 'dage'}${invVisits.length ? ` · ${invVisits.length} A4-fakturaer` : ''}</h2><button class="pri" data-act="print">🖨 Udskriv</button></div>
    ${invVisits.length ? '<p class="small mute noprint">Fakturaerne er til kunder med fakturatype "Papir". Fakturanummer tildeles, når fakturaen bogføres i e-conomic.</p>' : ''}
    <div class="card sheet">${days.map((d) => daySheetHtml(d, byDay.get(d).sort((a, b) => route(a).name.localeCompare(route(b).name)))).join('')}${invVisits.map(invoiceHtml).join('')}</div>`;
}
/** Klik på en dag: ferie/fridag, dagsplan, flyt hele dagen. */
function dayOptions(d) {
  const info = db.closedInfo?.[d]; const isClosed = db.closedDays.includes(d);
  openDlg(`<h2>${fmt(d)} ${d.slice(0, 4)}</h2>${isClosed ? `<p><span class="pill warn">${esc(info?.label || 'Lukket')}</span></p>` : ''}<div class="menu">
    <button type="button" data-act="ferie" data-d="${d}">🏖 Indsæt ferie / fridag …</button>
    ${isClosed ? `<button type="button" data-act="ferieDel" data-d="${d}">Fjern ${esc((info?.label || 'lukkedag').toLowerCase())}</button>` : ''}
    <button type="button" data-act="dayPlan" data-d="${d}">🗺 Dagsplan for dagen</button>
    <button type="button" data-act="dayMenu" data-d="${d}">📅 Flyt / aflys hele dagen …</button></div>`, null, 'Luk');
}
function ferieDialog(d) {
  ui._fe = { a: d, b: d, step: 1, month: d.slice(0, 7) };
  openDlg(`<h2>🏖 Ferie / fridag</h2><p class="small mute">Klik på første og sidste dag i perioden. Klik kun én gang for en enkelt dag.</p><div id="feCal"></div>
    <div class="grid"><label><span>Type</span><select name="label"><option>Ferie</option><option>Fridag</option><option>Lukket</option></select></label>
    <label><span>Besøg i perioden</span><select name="mode"><option value="move">Flyt til første arbejdsdag efter perioden</option><option value="shift">Flyt dem og forskyd alle fremtidige aftaler tilsvarende</option><option value="keep">Lad dem stå – jeg flytter dem selv</option></select></label></div>`,
  (f) => applyFerie(f.label, f.mode), 'Annuller');
  drawFerie();
}
function drawFerie() {
  const el = document.getElementById('feCal'); if (!el) return; const { a, b, month } = ui._fe;
  const first = month + '-01'; const start = D.addDays(first, -D.weekday(first)); const mNames = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
  const cells = []; for (let i = 0; i < 42; i++) { const d = D.addDays(start, i); if (i >= 35 && d.slice(0, 7) !== month) break; cells.push(d); }
  const n = D.diffDays(a, b) + 1;
  el.innerHTML = `<div class="mcal"><div class="mcal-h"><button type="button" class="icon" data-act="feMonth" data-v="-1">‹</button><b>${mNames[+month.slice(5) - 1]} ${month.slice(0, 4)}</b><button type="button" class="icon" data-act="feMonth" data-v="1">›</button></div>
    <div class="mcal-g">${['M', 'T', 'O', 'T', 'F', 'L', 'S'].map((x) => `<span class="dn">${x}</span>`).join('')}${cells.map((d) => `<button type="button" data-act="feDay" data-d="${d}" class="${d.slice(0, 7) !== month ? 'out' : ''} ${d >= a && d <= b ? 'in' : ''} ${d === a || d === b ? 'end' : ''} ${D.isClosedDay(d, db.closedDays) ? 'closed' : ''}">${+d.slice(8)}</button>`).join('')}</div>
    <p class="small">Valgt: <b>${fmt(a)}${n > 1 ? ' – ' + fmt(b) : ''}</b> (${n} ${n === 1 ? 'dag' : 'dage'})</p></div>`;
}
function applyFerie(label, mode) {
  const { a, b } = ui._fe; db.closedInfo ||= {}; let n = 0;
  for (let d = a; d <= b; d = D.addDays(d, 1)) { db.closedInfo[d] = { label }; if (!db.closedDays.includes(d)) { db.closedDays.push(d); n++; } }
  db.closedDays.sort();
  let moved = 0;
  if (mode === 'shift') { const to = D.nextWorkday(D.addDays(b, 1), db.closedDays);
    for (const v of db.visits.filter((x) => (x.status === 'planlagt' || x.status === 'udsat') && x.plannedDate >= a && x.plannedDate <= b)) { try { S.moveVisit(db, ui.user, v.id, to, 'shift'); moved++; } catch {} } }
  if (mode === 'move') { const to = D.nextWorkday(D.addDays(b, 1), db.closedDays);
    for (const v of db.visits) if ((v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate >= a && v.plannedDate <= b) { v.history.push({ at: new Date().toISOString(), by: ui.user.id, action: 'flyttet', from: v.plannedDate, to, mode: 'ferie' }); v.plannedDate = to; moved++; } }
  S.audit(db, ui.user.id, 'calendar.closed', `${a}..${b}`, { label, moved });
  toast(`${label} ${fmt(a)}${a !== b ? '–' + fmt(b) : ''} indsat${moved ? ` · ${moved} besøg flyttet til ${fmt(D.nextWorkday(D.addDays(b, 1), db.closedDays))}` : ''}`);
}

/** Klik på kanten af en rute: menu med muligheder. */
function routeMenu(rid, day) {
  const r = route(rid); const vs = db.visits.filter((v) => v.routeId === rid && v.plannedDate === day);
  ui._rm = { rid, day };
  openDlg(`<h2>${esc(r.name)} <span class="mute">${fmt(day)}</span></h2><p class="small mute">${vs.length} besøg · ${D.hm(mins(vs))} t</p>${routeMenuButtons(rid, day)}`, null, 'Luk');
}
function routeMenuButtons(rid, day) {
  return `<div class="menu">
      <button type="button" data-route="${rid}" data-day="${day}">✓ Færdigmeld</button>
      <button type="button" data-route="${rid}" data-day="${day}" data-showmap="1">🗺 Vis ruten på kort</button>
      <button type="button" data-act="printRoute" data-r="${rid}" data-d="${day}">🖨 Udskriv ruteseddel</button>
      <button type="button" data-act="rmMove">📅 Flyt ruten til anden dag …</button>
      <button type="button" data-act="rmPart">✂ Flyt nogle kunder til anden dag …</button>
      <button type="button" data-act="rmSms">📱 SMS til kunderne på ruten</button>
      <button type="button" data-act="dayPlan" data-d="${day}">🗺 Dagsplan for dagen</button>
      <button type="button" data-act="rmSelect">☑ ${ui.calSel?.has(rid + '|' + day) ? 'Fravælg' : 'Vælg'} til samlet udskrift</button>
    </div>`;
}

/* ---------------- Dagsplan (på tværs af faste ruter) ---------------- */
const startPoint = () => { const st = db.settings.start; return st?.address ? { street: st.address, lat: st.lat ?? null, lng: st.lng ?? null } : null; };
/** Træk-og-slip i en liste (mus og finger). Elementer har data-id; håndtag har klassen .handle. */
function makeSortable(listEl, onDrop) {
  if (!listEl) return; let drag = null;
  listEl.addEventListener('pointerdown', (e) => { const h = e.target.closest('.handle'); if (!h) return; const item = h.closest('[data-id]'); if (!item) return;
    drag = { item, id: e.pointerId }; item.classList.add('dragging'); listEl.setPointerCapture(e.pointerId); e.preventDefault(); });
  listEl.addEventListener('pointermove', (e) => { if (!drag) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]');
    if (over && over !== drag.item && over.parentNode === listEl) { const r = over.getBoundingClientRect(); listEl.insertBefore(drag.item, e.clientY > r.top + r.height / 2 ? over.nextSibling : over); }
    const vr = listEl.getBoundingClientRect(); if (e.clientY < 60) window.scrollBy(0, -12); else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 12); });
  const end = () => { if (!drag) return; drag.item.classList.remove('dragging'); drag = null; onDrop([...listEl.querySelectorAll(':scope > [data-id]')].map((x) => x.dataset.id)); };
  listEl.addEventListener('pointerup', end); listEl.addEventListener('pointercancel', end);
}
/** Google-køretider (og vejrute) for en rækkefølge af besøg – hentes automatisk og huskes. */
const gKey = (k, ids, opt) => k + '|' + (opt ? [...ids].sort() : ids).join(',');
function googleFor(cacheKey, ids, { start, end, optimize, pointOf, onDone }) {
  const c = (ui._google ||= {}); if (c[cacheKey] || !db.settings.googleKey || !ids.length) return c[cacheKey] || null;
  if ((ui._gBusy ||= new Set()).has(cacheKey)) return null;
  ui._gBusy.add(cacheKey);
  const A = pointOf || ((id) => addr(db.visits.find((v) => v.id === id).addressId));
  DP.googleDay(db.settings.googleKey, { start, end, stops: ids.map(A), optimize })
    .then((r) => { c[cacheKey] = { order: r.order.map((k) => ids[k]), legs: r.legs, polylines: r.polylines }; onDone?.(c[cacheKey]); S.audit(db, ui.user.id, 'google.routes', cacheKey.slice(0, 40), { stops: ids.length }); })
    .catch((err) => { c[cacheKey] = { error: err.message }; toast(err.message); })
    .finally(() => { ui._gBusy.delete(cacheKey); softRender(); });
  return null;
}
/** Dagens rækkefølge (på tværs af ruter). Ingen plan = som de faste ruter. */
function dayOrder(day, vs) {
  const base = DP.routeOrder(vs, db.routes); const p = db.dayPlans?.[day];
  if (!p?.order) return base; const ids = new Set(vs.map((v) => v.id));
  return [...p.order.filter((id) => ids.has(id)), ...base.filter((id) => !p.order.includes(id))];
}
function setDayOrder(day, order, extra = {}) { (db.dayPlans ||= {})[day] = { ...(db.dayPlans[day] || {}), order: [...order], mode: 'tilpasset', at: new Date().toISOString(), ...extra }; save(); }
function dagsplan() {
  const day = ui.planDay || todayIso(); db.dayPlans ||= {}; const saved = db.dayPlans[day];
  const vs = db.visits.filter((v) => v.plannedDate === day && v.status !== 'aflyst' && v.status !== 'forgaeves');
  const byId = new Map(vs.map((v) => [v.id, v])); const A = (v) => addr(v.addressId) || {};
  const st = startPoint(); const useG = !!db.settings.googleKey;
  const order = dayOrder(day, vs);
  const g0 = useG && order.length ? googleFor(gKey(day + 'cur', order), order, { start: st, optimize: false }) : null; const g = g0 && !g0.error ? g0 : null;
  if (g && saved && saved.legsFor !== order.join(',')) { saved.legs = g.legs; saved.polylines = g.polylines; saved.legsFor = order.join(','); save(); } // tid vises i kalenderen
  const legs = g?.legs || DP.estimateLegs(order.map((id) => A(byId.get(id))), st);
  const cur = DP.sumLegs(legs); const work = mins(vs);
  const gm = []; const pts = order.map((id) => A(byId.get(id)).street); for (let i = 0; i < pts.length; i += 9) gm.push(mapsRoute(pts.slice(i, i + 10)));
  $view.innerHTML = `<div class="toolbar noprint"><button data-act="planBack">← Kalender</button><h2 class="sp">Dagsplan ${fmt(day)} ${day.slice(0, 4)}</h2><button data-act="print">🖨 Udskriv</button></div>
  <div class="card">
    <div class="row small"><span>${vs.length} besøg</span><span>Arbejde <b>${D.hm(work)}</b></span><span>Kørsel <b>${D.hm(Math.round(cur.sec / 60))}</b> (${Math.round(cur.m / 1000)} km)${cur.unknown ? ` <span class="warn-t">· ${cur.unknown} ben uden koordinater</span>` : ''}</span><span>I alt <b>${D.hm(work + Math.round(cur.sec / 60))}</b></span>
      <span class="pill ${g ? 'ok' : ''}">${g ? 'Køretider fra Google Maps' : useG ? (g0?.error ? 'Google fejlede – viser skøn' : 'Henter køretider fra Google …') : 'Skøn: luftlinje × 1,3 ved 50 km/t'}</span>
      <span class="pill">${saved?.order ? 'Tilpasset rækkefølge' : 'Som de faste ruter'}</span></div>
    ${st ? '' : '<div class="warnbox noprint">Sæt firmaets startadresse under Admin → Kørsel, så turen regnes fra og til den.</div>'}
    <div id="planMap" class="map"></div>
    <div class="toolbar noprint">${useG ? `<button class="pri" data-act="planOpt">✨ Optimér hele dagen</button><button data-act="planGoogle">🔄 Genberegn køretid</button>` : '<span class="small mute">Google Maps-nøgle ikke sat (Admin → Kørsel) – bruger skøn.</span>'}
      <span class="small mute">Træk i ⋮⋮ for at flytte. Ændringer gemmes med det samme.</span><span class="sp"></span>${saved?.order ? '<button data-act="planClear">↺ Som faste ruter</button>' : ''}</div>
    <table><thead><tr><th class="w1 noprint"></th><th class="w1">#</th><th>Kunde</th><th class="hide-m">Rute</th><th class="hide-m">Tid</th></tr></thead><tbody id="planList">
    ${order.map((id, i) => { const v = byId.get(id); const c = cust(v.customerId); const leg = legs[i + (st ? 0 : -1)];
      return `<tr data-id="${id}"><td class="noprint"><span class="handle" title="Træk">⋮⋮</span></td><td>${i + 1}</td><td><b>${esc(c.name)}</b><div class="small">${esc(A(v).street)}</div>${leg?.sec != null && (st || i) ? `<div class="small mute">🚗 ${Math.round(leg.sec / 60)} min · ${(leg.m / 1000).toFixed(1)} km hertil</div>` : ''}</td><td class="hide-m"><span class="pill">${esc(route(v.routeId)?.name ?? 'Uden rute')}</span></td><td class="hide-m">${D.hm(v.durationMin ?? 15)}</td></tr>`; }).join('')}</tbody></table>
    <div class="toolbar noprint" style="margin-top:10px">${gm.map((u, k) => `<a class="btn" target="_blank" rel="noopener" href="${u}">Navigér i Google Maps${gm.length > 1 ? ` (del ${k + 1})` : ''} ↗</a>`).join('')}</div>
    <p class="small mute">Gælder kun denne dag – de faste ruter ændres under ruten → "↕ Rækkefølge". Dagsruten og rutesedlen følger dagens rækkefølge.</p></div>`;
  ui._planOrder = order;
  makeSortable(document.getElementById('planList'), (o) => { setDayOrder(day, o); render(); });
  showRouteMap(document.getElementById('planMap'), { start: st, polylines: g?.polylines, stops: order.map((id, i) => { const v = byId.get(id); const a = A(v); return { lat: a.lat, lng: a.lng, n: i + 1, title: cust(v.customerId)?.name, sub: a.street, done: v.status !== 'planlagt' && v.status !== 'udsat' }; }) }).catch(() => {});
}

/* ---------------- Rutens faste rækkefølge: optimér, træk, kort ---------------- */
function routeOrderView(r, head) {
  const live = new Set(db.agreements.filter((a) => a.routeId === r.id && a.active !== false).map((a) => a.addressId));
  const base = [...(r.order || []).filter((id) => live.has(id)), ...[...live].filter((id) => !(r.order || []).includes(id))];
  if (ui._ordFor !== r.id) { ui._ordFor = r.id; ui._ord = base; ui._ordStart = r.optStart || (startPoint() ? { type: 'home' } : { type: 'stop', id: base[0] }); ui._ordEnd = r.optEnd || 'back'; }
  ui._ord = [...ui._ord.filter((id) => live.has(id)), ...base.filter((id) => !ui._ord.includes(id))];
  const A = (id) => addr(id) || {}; const so = ui._ordStart;
  const startPt = so.type === 'home' ? startPoint() : so.type === 'custom' ? (so.street ? { street: so.street } : null) : so.id ? A(so.id) : null;
  const fixedFirst = so.type === 'stop' && so.id && ui._ord.includes(so.id) ? so.id : null;
  if (fixedFirst) ui._ord = [fixedFirst, ...ui._ord.filter((id) => id !== fixedFirst)];
  const rest = fixedFirst ? ui._ord.slice(1) : ui._ord;
  const endOpt = ui._ordEnd === 'back' ? undefined : null;
  const key = gKey('ord:' + r.id + '|' + JSON.stringify(so) + '|' + ui._ordEnd, rest);
  const useG = !!db.settings.googleKey;
  const g0 = useG && rest.length ? googleFor(key, rest, { start: startPt, end: endOpt, optimize: false, pointOf: A }) : null; const g = g0 && !g0.error ? g0 : null;
  const legs = g?.legs || DP.estimateLegs(rest.map(A), ui._ordEnd === 'back' ? startPt : null);
  const sum = DP.sumLegs(legs); const work = db.agreements.filter((a) => a.routeId === r.id && a.active !== false).reduce((t, a) => t + (a.durationMin ?? 15), 0);
  const changed = JSON.stringify(ui._ord) !== JSON.stringify(base);
  const name = (id) => { const c = cust(A(id).customerId); return c?.name || '?'; };
  $view.innerHTML = head + `<div class="card"><div class="row"><h2 class="sp">Rækkefølge – ${esc(r.name)}</h2>${changed ? '<span class="pill warn">Ikke gemt</span>' : '<span class="pill ok">Gemt</span>'}</div>
    <div class="grid" style="margin:8px 0">
      <label><span>Start</span><select id="ordStart"><option value="home" ${so.type === 'home' ? 'selected' : ''} ${startPoint() ? '' : 'disabled'}>Firmaets adresse${startPoint() ? ' – ' + esc(startPoint().street) : ' (ikke sat)'}</option>
        <option value="stop" ${so.type === 'stop' ? 'selected' : ''}>En bestemt kunde først …</option><option value="custom" ${so.type === 'custom' ? 'selected' : ''}>Anden adresse …</option></select></label>
      ${so.type === 'stop' ? `<label><span>Første kunde</span><select id="ordFirst">${ui._ord.map((id) => `<option value="${id}" ${id === so.id ? 'selected' : ''}>${esc(name(id))} – ${esc(A(id).street)}</option>`).join('')}</select></label>` : ''}
      ${so.type === 'custom' ? `<label><span>Startadresse</span><input id="ordCustom" value="${esc(so.street || '')}" placeholder="Vej 1, 9870 Sindal"></label>` : ''}
      <label><span>Slut</span><select id="ordEnd"><option value="back" ${ui._ordEnd === 'back' ? 'selected' : ''}>Tilbage til start</option><option value="last" ${ui._ordEnd === 'last' ? 'selected' : ''}>Ved sidste kunde</option></select></label></div>
    <div class="row small"><span>${ui._ord.length} adresser</span><span>Arbejde <b>${D.hm(work)}</b></span><span>Kørsel <b>${D.hm(Math.round(sum.sec / 60))}</b> (${Math.round(sum.m / 1000)} km)</span><span>I alt <b>${D.hm(work + Math.round(sum.sec / 60))}</b></span>
      <span class="pill ${g ? 'ok' : ''}">${g ? 'Google Maps' : useG ? (g0?.error ? 'Google fejlede – skøn' : 'Henter Google …') : 'Skøn (ingen Google-nøgle)'}</span></div>
    <div id="ordMap" class="map"></div>
    <div class="toolbar"><button data-act="ordOpt" ${useG ? '' : 'disabled title="Kræver Google-nøgle (Admin → Kørsel)"'}>✨ Optimér med Google</button><span class="small mute">Træk i ⋮⋮ for at flytte en kunde.</span><span class="sp"></span>
      ${changed ? '<button data-act="ordReset">Fortryd</button>' : ''}<button class="pri" data-act="ordSave" ${changed || JSON.stringify(so) !== JSON.stringify(r.optStart || null) || ui._ordEnd !== (r.optEnd || 'back') ? '' : 'disabled'}>Gem som fast rækkefølge</button></div>
    <ol class="sortlist" id="ordList">${ui._ord.map((id, i) => { const a = A(id); const leg = fixedFirst && i === 0 ? null : legs[fixedFirst ? i - 1 : i];
      return `<li data-id="${id}" class="${id === fixedFirst ? 'fixed' : ''}"><span class="handle" title="Træk">⋮⋮</span><span class="num">${i + 1}</span><div class="sp"><b>${esc(name(id))}</b><div class="small">${esc(a.street)}</div>${leg?.sec != null ? `<div class="small mute">🚗 ${Math.round(leg.sec / 60)} min · ${(leg.m / 1000).toFixed(1)} km hertil</div>` : ''}</div>${id === fixedFirst ? '<span class="pill">start</span>' : ''}</li>`; }).join('')}</ol>
    <p class="small mute">Gemmes som rutens faste rækkefølge (bruges på alle fremtidige dage). En enkelt dag ændres i stedet under dagsplanen (🗺 på dagen).</p></div>`;
  makeSortable(document.getElementById('ordList'), (order) => { ui._ord = order; if (fixedFirst && order[0] !== fixedFirst) ui._ordStart = { type: 'stop', id: order[0] }; render(); });
  const set = () => render();
  document.getElementById('ordStart').onchange = (e) => { const v = e.target.value; ui._ordStart = v === 'stop' ? { type: 'stop', id: ui._ord[0] } : v === 'custom' ? { type: 'custom', street: so.street || '' } : { type: 'home' }; set(); };
  const f = document.getElementById('ordFirst'); if (f) f.onchange = (e) => { ui._ordStart = { type: 'stop', id: e.target.value }; set(); };
  const cu = document.getElementById('ordCustom'); if (cu) cu.onchange = (e) => { ui._ordStart = { type: 'custom', street: e.target.value.trim() }; set(); };
  document.getElementById('ordEnd').onchange = (e) => { ui._ordEnd = e.target.value; set(); };
  ui._ordCtx = { r, rest, startPt, endOpt, fixedFirst, A, so };
  const stops = ui._ord.map((id, i) => { const a = A(id); return { lat: a.lat, lng: a.lng, n: i + 1, title: name(id), sub: a.street }; });
  showRouteMap(document.getElementById('ordMap'), { start: so.type === 'stop' ? null : startPt?.lat != null ? startPt : null, polylines: g?.polylines, stops }).catch(() => {});
}

/* ---------------- Ruter & kort ---------------- */
function routeStops(routeId, day) {
  const r = route(routeId);
  const vs = db.visits.filter((v) => v.routeId === routeId && v.plannedDate === day);
  const order = r.order || []; const dp = db.dayPlans?.[day]?.order;
  const fixed = (a, b) => ((order.indexOf(a.addressId) + 1 || 999) - (order.indexOf(b.addressId) + 1 || 999)) || a.id.localeCompare(b.id);
  return vs.sort((a, b) => (dp ? (dp.indexOf(a.id) + 1 || 9999) - (dp.indexOf(b.id) + 1 || 9999) : 0) || fixed(a, b));
}
/** Ny rækkefølge for én rute på én dag (påvirker kun dagen; de andre ruter samme dag beholder deres pladser). */
function setRouteDayOrder(day, ids) {
  const vs = db.visits.filter((v) => v.plannedDate === day && v.status !== 'aflyst' && v.status !== 'forgaeves');
  const cur = dayOrder(day, vs); const set = new Set(ids); let k = 0;
  const out = cur.map((id) => (set.has(id) ? ids[k++] : id)); for (const id of ids) if (!out.includes(id)) out.push(id);
  setDayOrder(day, out);
}
const fixedRouteOrder = (r, vs) => { const o = r.order || []; return [...vs].sort((a, b) => ((o.indexOf(a.addressId) + 1 || 999) - (o.indexOf(b.addressId) + 1 || 999)) || a.id.localeCompare(b.id)); };
const ST = [['udfoert', '✓ Udført'], ['kontant', '💵 Kontant'], ['spring', '⏭ Udsæt']];
const STLABEL = { udfoert: 'Udført', kontant: 'Udført, betalt kontant', spring: 'Udsat' };
const doneLabel = (v) => (v.completion?.cashPaid ? 'Udført og betalt' : v.status === 'aflyst' && /Sprunget over/.test(v.completion?.note || '') ? 'Sprunget over' : STATUS[v.status]?.[0] || v.status);
/** Kladder pr. besøg (deles af færdigmelding og dagsrute) */
const vdraft = () => (db.vdraft ||= {});
const statusSeg = (v, res, big) => `<div class="seg st ${big ? 'big' : ''}">${ST.map(([k, t]) => `<button type="button" class="${res === k ? 'on ' + k : ''}" data-st="${v.id}" data-v="${k}">${t}</button>`).join('')}</div>`;
const extrasHtml = (v, d, done) => { const xs = done ? (v.extras || []) : (d.extras || []);
  return `${xs.map((x, i) => `<div class="extra">➕ ${esc(x.text)} · ${kr(Number(x.price) || 0)}${done ? '' : ` <a href="#" data-act="extraDel" data-id="${v.id}" data-i="${i}" title="Fjern">✕</a>`}</div>`).join('')}${done ? '' : `<button type="button" class="link small" data-act="extraAdd" data-id="${v.id}">+ Ekstra opgave</button>`}`; };
/** Udfør beslutninger for besøg: [{ v, d }] → { done, moved, conflicts } */
function applyDecisions(pairs) {
  const ent = []; let moved = 0;
  for (const { v, d } of pairs) {
    const split = d.split ?? defaultSplit(v); const extras = (d.extras || []).filter((x) => x.text);
    if (d.result === 'udfoert') ent.push({ visitId: v.id, result: 'udfoert', service: d.service, split, extras });
    else if (d.result === 'kontant') ent.push({ visitId: v.id, result: 'udfoert', service: d.service, split, extras, cashAmount: d.cashAmount ?? Math.round(D.visitTotal({ ...v, extras }) * 125) / 100, payMethod: 'kontant' });
    else if ((d.skip || 'skip') === 'skip') ent.push({ visitId: v.id, result: 'aflyst', note: 'Sprunget over' });
    else if (d.skip === 'forgaeves') ent.push({ visitId: v.id, result: 'forgaeves', note: 'Forgæves besøg' });
    else { S.moveVisit(db, ui.user, v.id, d.skip === 'reinsert' ? D.nextWorkday(D.addDays(v.plannedDate, 1), db.closedDays) : d.moveDate, d.skip === 'shift' ? 'shift' : 'keep'); moved++; }
  }
  const r = S.finishRoute(db, ui.user, ent); for (const { v } of pairs) delete vdraft()[v.id];
  return { ...r, moved };
}
const doneRes = (v) => (v.status === 'udfoert' || v.status === 'delvis' ? (v.completion?.cashPaid ? 'kontant' : 'udfoert') : 'spring');
function nextInSeries(v) {
  const n = db.visits.filter((x) => x.agreementId === v.agreementId && x.plannedDate > v.plannedDate && x.status === 'planlagt').sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))[0];
  if (n) return n.plannedDate; const ag = db.agreements.find((a) => a.id === v.agreementId); return ag?.intervalWeeks && v.seriesIndex >= 0 ? D.nextWorkday(D.rhythmDate(ag, v.seriesIndex + 1), db.closedDays) : null;
}
function skipOptions(v, d) {
  const nx = nextInSeries(v); const again = D.nextWorkday(D.addDays(v.plannedDate, 1), db.closedDays);
  const o = [['skip', nx ? `Spring over (næste gang ${fmt(nx)})` : 'Spring over'], ['reinsert', `Annuller og indsæt igen på ${fmt(again)}`], ['move', 'Skub til ny dato …'], ['shift', 'Skub til ny dato og flyt fremtidige …'], ['forgaeves', 'Forgæves besøg (kunden ikke hjemme e.l.)']];
  return o.map(([k, t]) => `<option value="${k}" ${k === (d.skip || 'skip') ? 'selected' : ''}>${esc(t)}</option>`).join('');
}
const PAYICON = { bank: '✉', mobilepay: '📱', betalingsservice: 'BS', kontant: '💰' };
const services = () => [...new Set(db.agreements.map((a) => a.service).concat(['Vinduesvask', 'Vinduesvask + rammer', 'Tagrender', 'Solceller', 'Ekstra opgave']))];
function defaultSplit(v) { const r = route(v.routeId); const e = emp(r?.employeeId); const pct = Math.round((e?.commissionRate ?? db.settings.commissionRate) * 1000) / 10; return e && pct ? [{ employeeId: e.id, pct }] : []; }
const splitTxt = (sp) => sp.length ? sp.map((x) => `${esc(emp(x.employeeId)?.name.split(' ')[0])} ${x.pct}%`).join(', ') : 'Firma 100%';
function ruter() {
  if (!ui.route || !route(ui.route)) return ruteOversigt();
  const r = route(ui.route);
  if (!routeStops(r.id, ui.day).length && ui._routeDayFor !== r.id + ui.day) { ui.day = nextRouteDay(r) || ui.day; ui._routeDayFor = r.id + ui.day; };
  const day = ui.day; const key = r.id + '|' + day;
  const stops = routeStops(r.id, day); const pts = stops.map((v) => addr(v.addressId));
  const sug = suggestOrder(pts); const cur = routeKm(pts);
  const live = stops.filter((v) => v.status !== 'aflyst'); const total = live.reduce((s, v) => s + v.price, 0);
  const dr = vdraft();
  const mode = ui.routeMode || 'fm';
  const head = `<div class="card row noprint"><button data-act="routesAll">← Alle ruter</button><select id="rsel">${db.routes.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <button data-act="rnext" data-d="-1">← Forrige gang</button><input type="date" id="rday" value="${day}"><button data-act="rnext" data-d="1">Næste gang →</button><span class="sp"></span>
    <button data-act="rmode" data-m="fm" class="${mode === 'fm' ? 'pri' : ''}">Færdigmelding</button><button data-act="rmode" data-m="sheet" class="${mode === 'sheet' ? 'pri' : ''}">Ruteseddel</button>${isAdmin() ? `<button data-act="rmode" data-m="order" class="${mode === 'order' ? 'pri' : ''}">↕ Rækkefølge</button>` : ''}</div>
  ${D.routeRuns(r, day) ? '' : '<div class="warnbox noprint">Ruten kører ikke normalt denne dag.</div>'}`;
  const nSel = stops.filter((v) => ui.sel.has(v.id)).length;
  const est = live.reduce((s, v) => s + D.visitTotal(v) * ((v.split?.length ? v.split : defaultSplit(v)).reduce((t, x) => t + x.pct, 0) / 100), 0);
  // Google-køretid og vejrute for rutens rækkefølge (hentes automatisk, når der er en nøgle)
  const rIds = live.map((v) => v.id); const rSt = startPoint();
  const rg0 = db.settings.googleKey && rIds.length ? googleFor(gKey('route:' + r.id + day, rIds), rIds, { start: rSt, optimize: false }) : null; const rg = rg0 && !rg0.error ? rg0 : null; const rsum = rg ? DP.sumLegs(rg.legs) : null;
  ui._routeMapArgs = { start: rSt, polylines: rg?.polylines, stops: stops.map((v, i) => { const a = addr(v.addressId); return { lat: a?.lat, lng: a?.lng, n: i + 1, title: cust(v.customerId)?.name, sub: a?.street, done: v.status !== 'planlagt' && v.status !== 'udsat' }; }) };
  const gmLinks = (() => { const ps = live.map((v) => addr(v.addressId)?.street).filter(Boolean); const out = []; for (let i = 0; i < ps.length; i += 9) out.push(mapsRoute(ps.slice(i, i + 10))); return out; })();
  const mapBlock = `<div class="noprint">${ui.hideRouteMap ? '' : '<div id="routeMap" class="map"></div>'}<div class="row small"><button class="link" data-act="toggleRouteMap">${ui.hideRouteMap ? '🗺 Vis kort' : 'Skjul kort'}</button><span class="sp"></span>${gmLinks.map((u, k) => `<a class="btn small" target="_blank" rel="noopener" href="${u}">Navigér i Google Maps${gmLinks.length > 1 ? ` (del ${k + 1})` : ''} ↗</a>`).join('')}</div></div>`;
  const fixedIds = fixedRouteOrder(r, stops).map((v) => v.id); const isDiff = stops.length > 1 && fixedIds.join() !== stops.map((v) => v.id).join();
  const dayDiff = isDiff && isAdmin() ? `<div class="row noprint small" style="margin-top:8px"><span class="pill warn">Dagens rækkefølge afviger fra rutens faste</span><button class="small" data-act="rdFix">Gør til rutens faste rækkefølge</button><button class="small" data-act="rdReset">↺ Brug den faste</button></div>` : '';
  const stats = `<div class="row small" style="margin:6px 0"><span>${stops.length} besøg</span><span>Oms.: <b>${kr(total)}</b> (${kr(total * 1.25)} inkl. moms)</span><span>Tid: <b>${D.hm(mins(stops))}</b></span><span>${rsum ? `Kørsel <b>${D.hm(Math.round(rsum.sec / 60))}</b> (${Math.round(rsum.m / 1000)} km, Google)` : `Kørsel ca. <b>${Math.round(cur * 1.3)} km</b>${db.settings.googleKey && !rg0?.error ? ' <span class="mute">(henter Google …)</span>' : ''}`}</span><span>Provision ca. <b>${kr(Math.round(est))}</b></span>${mins(live) ? `<span>Oms./time: <b>${kr(Math.round(total / (mins(live) / 60)))}</b></span>` : ''}</div>`;
  if (mode === 'order') return routeOrderView(r, head);
  if (mode === 'fm') {
    $view.innerHTML = head + `<div class="card"><h2>Færdigmelding – ${esc(r.name)} <span class="mute">${fmt(day)} ${day.slice(0, 4)}</span></h2>${stats}${mapBlock}
    ${stops.length ? `<div class="toolbar noprint"><button data-act="selAll">${stops.every((v) => ui.sel.has(v.id)) ? 'Fravælg alle' : 'Vælg alle'}</button><span class="small mute">${nSel} valgt:</span>
      <button data-act="fmSet" data-r="udfoert">✓ Udført</button><button data-act="fmSet" data-r="kontant">💵 Kontant</button><button data-act="fmSet" data-r="spring">⏭ Udsæt</button><button data-act="fmSet" data-r="aaben">Nulstil</button><button data-act="fmSplit">Provision…</button><button data-act="bulkSms">📱 SMS</button></div>
    <table class="fm"><thead><tr><th class="w1 noprint"></th><th class="w1"></th><th class="w1">#</th><th>Kunde</th><th>Status</th><th class="hide-m">Opgave</th><th class="hide-m">Provision</th></tr></thead><tbody id="rdList">
    ${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId); const done = v.status !== 'planlagt' && v.status !== 'udsat'; const d = dr[v.id] || {};
      const res = done ? doneRes(v) : d.result || 'aaben'; const sp = done ? (v.split ?? []) : (d.split ?? defaultSplit(v));
      const inv = `${c.invoiceType === 'sms' ? '📱' : c.invoiceType === 'ean' ? 'EAN' : '✉'}${c.paymentMethod === 'betalingsservice' ? ' BS' : ''}${c.paymentMethod === 'kontant' ? ' 💰' : ''}`;
      return `<tr data-id="${v.id}" class="${res !== 'aaben' ? 'res-' + res : ''} ${done ? 'locked' : ''}"><td class="noprint"><span class="handle" title="Træk – ændrer kun denne dag">⋮⋮</span></td><td><input type="checkbox" data-sel="${v.id}" ${ui.sel.has(v.id) ? 'checked' : ''}></td><td>${i + 1}</td>
        <td><a href="#" data-cust="${c.id}"><b>${esc(c.name)}</b></a> <span class="small mute" title="${esc(INVTYPE[c.invoiceType || 'email'])}">${inv}</span><div class="small">${esc(a.street)}</div>
          ${a.access ? `<div class="small mute">🔑 ${esc(a.access)}</div>` : ''}${c.rememberNext ? `<div class="small warn-t">⚠ ${esc(c.rememberNext)}</div>` : ''}${c.callBefore ? '<div class="small warn-t">📞 Ring før besøg</div>' : ''}
          ${(a.photos || []).length ? `<div class="thumbs">${a.photos.map((ph) => `<img src="${ph.src}" data-act="photo" data-src="${ph.id}" data-a="${a.id}" alt="">`).join('')}</div>` : ''}
          <div class="noprint">${extrasHtml(v, d, done)}</div></td>
        <td>${done ? `<span class="pill ${v.status === 'udfoert' || v.status === 'delvis' ? 'ok' : 'warn'}">${esc(doneLabel(v))}</span>` : statusSeg(v, res)}
          ${!done && res === 'kontant' ? `<div class="sub"><input type="number" min="0" step="1" class="cash" data-cash="${v.id}" value="${d.cashAmount ?? ''}" placeholder="${kr(Math.round(D.visitTotal({ ...v, extras: d.extras }) * 1.25))}"> <span class="small mute">kontant</span></div>` : ''}
          ${!done && res === 'spring' ? `<div class="sub"><select data-skip="${v.id}">${skipOptions(v, d)}</select>${d.skip === 'move' || d.skip === 'shift' ? `<input type="date" data-mdate="${v.id}" value="${d.moveDate || ''}">` : ''}</div>` : ''}</td>
        <td class="hide-m">${done ? `<span class="small">${esc(v.service)} · ${kr(D.visitTotal(v))}</span>` : `<select data-svc="${v.id}">${[...new Set([d.service || v.service, ...services()])].map((x) => `<option value="${esc(x)}" ${x === (d.service || v.service) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><div class="small mute">${kr(v.price)} · ${D.hm(v.durationMin ?? 15)}</div>`}</td>
        <td class="hide-m small"><a href="#" data-act="fmSplitOne" data-id="${v.id}">${splitTxt(sp)}</a></td></tr>`; }).join('')}</tbody></table>${dayDiff}
    <div class="toolbar" style="margin-top:12px"><div class="cashbox">💰 Kontant i alt <b>${kr(stops.reduce((s, v) => { const d = dr[v.id] || {}; return s + (v.completion?.cashAmount || (d.result === 'kontant' ? (d.cashAmount ?? Math.round(D.visitTotal({ ...v, extras: d.extras }) * 125) / 100) : 0)); }, 0))}</b></div><span class="sp"></span>
      <button data-act="fmSave">Gem til senere</button><button class="pri" data-act="fmCommit">✓ Gem og færdigmeld</button></div>
    <p class="small mute">Vælg Udført, Betalt (kontant) eller Udsæt for hver kunde. Kunder uden valg forbliver åbne. Ekstra opgaver kommer med på fakturaen.</p>` : '<p class="mute">Ingen besøg på ruten denne dag.</p>'}</div>`;
  } else {
    $view.innerHTML = head + `<div class="card sheet"><div class="row"><h2 class="sp">${fmt(day)} ${day.slice(0, 4)} uge ${D.isoWeek(day)} – Rute: ${esc(r.name)}</h2><button class="noprint" data-act="print">🖨 Udskriv</button></div><div class="small mute">${esc(emp(r.employeeId)?.name)} · ${routeWhen(r)} · udskrevet ${fmtTs(new Date().toISOString())}</div>${stats}${mapBlock}
    ${stops.length ? `<table><thead><tr><th>Nr</th><th>Adresse</th><th>Navn</th><th>Tlf.</th><th>Kont.</th><th style="text-align:right">Beløb</th><th>Bemærkninger</th><th>Opgave</th><th>Tid</th><th class="noprint"></th></tr></thead><tbody id="rdList">${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId); const ag = db.agreements.find((x) => x.id === v.agreementId);
      return `<tr class="${v.status === 'aflyst' ? 'struck' : ''}"><td>${i + 1}</td><td>${esc(a.street)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${c.paymentMethod === 'kontant' ? '✓' : ''}</td><td style="text-align:right">${kr(v.price)}</td><td class="small">${esc(a.access)}${c.rememberNext ? `<br><b>Husk: ${esc(c.rememberNext)}</b>` : ''}${c.callBefore ? '<br><b>Ring før besøg</b>' : ''}</td><td class="small">${esc(v.service)} (${ag?.intervalWeeks ? ag.intervalWeeks + 'u' : 'enkelt'})</td><td>${D.hm(v.durationMin ?? 15)}</td><td class="noprint"><span class="handle" title="Træk – ændrer kun denne dag">⋮⋮</span></td></tr>`; }).join('')}
      <tr><td colspan="5"><b>I alt (ekskl. moms)</b></td><td style="text-align:right"><b>${kr(total)}</b></td><td colspan="2"></td><td><b>${D.hm(mins(stops))}</b></td><td class="noprint"></td></tr></table>
    ${dayDiff}` : '<p class="mute">Ingen besøg på ruten denne dag.</p>'}</div>`;
  }
  document.getElementById('rsel').onchange = (e) => { ui.route = e.target.value; ui.day = nextRouteDay(route(ui.route)) || todayIso(); ui.sel = new Set(); render(); };
  document.getElementById('rday').onchange = (e) => { ui.day = e.target.value; render(); };
  $view.querySelectorAll('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? ui.sel.add(c.dataset.sel) : ui.sel.delete(c.dataset.sel); render(); }));
  const upd = (id, f) => { dr[id] = { ...(dr[id] || {}), ...f }; };
  $view.querySelectorAll('[data-cash]').forEach((x) => (x.onchange = () => { upd(x.dataset.cash, { cashAmount: x.value === '' ? null : +x.value, ...(x.value ? { result: 'kontant' } : {}) }); render(); }));
  $view.querySelectorAll('[data-skip]').forEach((x) => (x.onchange = () => { upd(x.dataset.skip, { skip: x.value }); render(); }));
  $view.querySelectorAll('[data-mdate]').forEach((x) => (x.onchange = () => { upd(x.dataset.mdate, { moveDate: x.value }); save(); }));
  $view.querySelectorAll('[data-svc]').forEach((x) => (x.onchange = () => { upd(x.dataset.svc, { service: x.value }); save(); }));
  ui._stops = stops; ui._sug = sug.order; ui._draftKey = key;
  makeSortable(document.getElementById('rdList'), (ids) => { setRouteDayOrder(day, ids); render(); });
}
function splitDialog(visits) {
  if (!visits.length) return toast('Vælg mindst én kunde');
  const cur = vdraft()[visits[0].id]?.split ?? defaultSplit(visits[0]);
  const pctOf = (eid) => cur.find((x) => x.employeeId === eid)?.pct ?? 0;
  openDlg(`<h2>Fordeling af provision – ${visits.length} kunde(r)</h2><p class="small mute">Beløb ekskl. moms. Resten tilfalder firmaet.</p>
    <table><tr><th>Medarbejder</th><th>%-sats</th><th style="text-align:right">Beløb</th></tr>${db.employees.map((e) => `<tr><td>${esc(e.name)}</td><td><input type="number" min="0" max="100" step="0.5" name="p_${e.id}" value="${pctOf(e.id)}" style="width:80px"></td><td style="text-align:right">${kr(visits.reduce((s, v) => s + v.price, 0) * pctOf(e.id) / 100)}</td></tr>`).join('')}</table>`,
  (f) => { const split = db.employees.map((e) => ({ employeeId: e.id, pct: Number(f['p_' + e.id]) || 0 })).filter((x) => x.pct > 0);
    if (split.reduce((s, x) => s + x.pct, 0) > 100) return 'Fordelingen må højst være 100 %';
    for (const v of visits) vdraft()[v.id] = { ...(vdraft()[v.id] || {}), split }; });
}
function ruteOversigt() {
  const t = todayIso(); const end = D.addDays(t, 364);
  // årsoverblik: generér (uden at gemme) alle besøg 12 mdr. frem
  const load = new Map(); let maxN = 1;
  for (const ag of db.agreements) for (const v of [...D.generateVisits(ag, t, end, [], db.closedDays), ...db.visits.filter((x) => x.agreementId === ag.id && x.manual && x.plannedDate >= t)]) { const n = (load.get(v.plannedDate) || 0) + 1; load.set(v.plannedDate, n); maxN = Math.max(maxN, n); }
  const weeks = []; for (let w = D.addDays(t, -D.weekday(t)); w <= end; w = D.addDays(w, 7)) weeks.push(w);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const rows = db.routes.map((r) => { const ags = db.agreements.filter((a) => a.routeId === r.id && a.active); const next = nextRouteDay(r, t);
    return { r, n: new Set(ags.map((a) => a.customerId)).size, year: ags.reduce((s, a) => s + D.annualRevenue(a), 0), min: ags.filter((a) => next && D.generateVisits(a, next, next).length).reduce((s, a) => s + (a.durationMin ?? 15), 0), next }; });
  const tot = rows.reduce((s, x) => s + x.year, 0);
  $view.innerHTML = kTabs() + `<div class="card"><div class="row"><h2 class="sp">Faste ruter (${db.routes.length})</h2><button data-act="addRoute">+ Opret rute</button></div>
    <div style="overflow-x:auto"><table class="heat"><tr><td></td>${weeks.map((w) => `<td class="hm">${D.toDate(w).getUTCDate() <= 7 ? MONTHS[D.month(w) - 1] : ''}</td>`).join('')}</tr>
    ${['M', 'T', 'O', 'T', 'F'].map((dn, i) => `<tr><td class="hm">${dn}</td>${weeks.map((w) => { const d = D.addDays(w, i); const n = load.get(d) || 0; return `<td title="${fmt(d)}: ${n} besøg" style="background:${n ? `rgba(31,95,139,${0.15 + 0.85 * n / maxN})` : 'var(--chip)'}"></td>`; }).join('')}</tr>`).join('')}</table></div>
    <p class="small mute">Belastning pr. dag de næste 12 måneder (mørkere = flere besøg).</p></div>
  <div class="card"><table class="clickable"><tr><th>Rutenavn</th><th>Medarbejder</th><th>Rytme</th><th>Størrelse</th><th>Næste</th><th style="text-align:right">Oms./år</th><th style="text-align:right">Inkl. moms</th><th>Tid næste gang</th></tr>
    ${rows.map((x) => `<tr data-route="${x.r.id}"><td><b>${esc(x.r.name)}</b></td><td>${esc(emp(x.r.employeeId)?.name)}</td><td>hver ${x.r.intervalWeeks}. uge</td><td>${x.n} kunder</td><td>${(() => { const op = openPastDay(x.r); return op ? `<span style="color:var(--bad)">${fmt(op)} ${op.slice(0, 4)} – åbne besøg</span><br>` : ''; })()}${x.r.anchorUnknown ? '<span style="color:var(--bad)">ukendt – sæt dato under Admin</span>' : x.next ? fmt(x.next) + ' ' + x.next.slice(0, 4) : '–'}</td><td style="text-align:right">${kr(Math.round(x.year))}</td><td style="text-align:right">${kr(Math.round(x.year * 1.25))}</td><td>${D.hm(x.min)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>Total</b></td><td style="text-align:right"><b>${kr(Math.round(tot))}</b></td><td style="text-align:right"><b>${kr(Math.round(tot * 1.25))}</b></td><td></td></tr></table>
    <p class="small mute">Oms./år er beregnet ud fra aftalernes pris, interval og sæson.</p></div>`;
}
/* ---------------- Mobil dagsrute ---------------- */
function mobil() {
  const myRoutes = db.routes.filter((r) => isAdmin() || r.employeeId === ui.user.employeeId);
  const dayStops = (d) => [...myRoutes.flatMap((r) => routeStops(r.id, d)), ...(isAdmin() ? db.visits.filter((v) => !v.routeId && v.plannedDate === d) : [])];
  // første gang: i dag, ellers næste dag med besøg
  if (ui._mobDayFor !== ui.user.id) { ui._mobDayFor = ui.user.id; if (!dayStops(ui.day).length) { const nx = [...new Set(db.visits.filter((v) => v.plannedDate >= todayIso() && v.status === 'planlagt').map((v) => v.plannedDate))].sort().find((d) => dayStops(d).length); if (nx) ui.day = nx; } }
  const day = ui.day; const stops = dayStops(day); const plan = db.dayPlans?.[day];
  if (plan?.order) stops.sort((a, b) => (plan.order.indexOf(a.id) + 1 || 9999) - (plan.order.indexOf(b.id) + 1 || 9999));
  const pending = new Set(ui.outbox.map((o) => o.visitId)); const dr = vdraft();
  const left = stops.filter((v) => (v.status === 'planlagt' || v.status === 'udsat') && !pending.has(v.id));
  $view.innerHTML = `<div class="mob-head"><button data-act="dd" data-d="-1" aria-label="Forrige dag">‹</button><div class="sp"><b>${fmt(day)} ${day.slice(0, 4)}</b><div class="small mute">${stops.length - left.length}/${stops.length} færdige · ${D.hm(mins(stops))} t</div></div><button data-act="dd" data-d="1" aria-label="Næste dag">›</button></div>
  <div class="toolbar"><button data-act="smsTomorrow">📱 SMS til morgendagens rute</button>${ui.offline || ui.outbox.length ? `<span class="pill warn">${ui.offline ? 'Offline' : ''} ${ui.outbox.length ? ui.outbox.length + ' venter på net' : ''}</span>` : ''}</div>
  ${left.length ? '' : stops.length ? '<div class="card center"><b>🎉 Alle dagens kunder er færdige</b></div>' : ''}
  ${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId); const done = (v.status !== 'planlagt' && v.status !== 'udsat') || pending.has(v.id); const d = dr[v.id] || {}; const isNext = left[0]?.id === v.id;
    return `<div class="stop ${done ? 'done' : ''} ${isNext ? 'next' : ''}" ${isNext ? 'id="nextStop"' : ''}>${isNext ? `<div class="nextbar"><span>Næste kunde</span><a class="btn pri" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">🚗 Navigér hertil</a></div>` : ''}<div class="stop-h"><span class="num">${i + 1}</span><div class="sp"><h3>${esc(c.name)}</h3><a class="small" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">${esc(a.street)}</a></div>${done ? `<span class="pill ok">${pending.has(v.id) ? 'Venter på net' : esc(doneLabel(v))}</span>` : `<span class="small mute">${esc(v.service)}</span>`}</div>
      ${a.access ? `<div class="desc">${esc(a.access)}</div>` : ''}${c.rememberNext ? `<div class="desc warn-t">⚠ Husk: ${esc(c.rememberNext)}</div>` : ''}${c.callBefore ? '<div class="desc warn-t">📞 Ring før besøg</div>' : ''}
      ${(a.photos || []).length ? `<div class="thumbs big">${a.photos.map((ph) => `<img src="${ph.src}" data-act="photo" data-src="${ph.id}" data-a="${a.id}" alt="">`).join('')}</div>` : ''}
      ${done ? ((v.extras || []).length ? `<div>${extrasHtml(v, d, true)}</div>` : '') : `<div class="extras">${extrasHtml(v, d, false)}</div>${statusSeg(v, null, true)}`}</div>`; }).join('') || '<p class="mute center">Ingen besøg denne dag.</p>'}`;
}
/** Dagsrute: Udført/Betalt registreres med det samme; Udsæt åbner valg. */
function mobileStatus(id, val) {
  const v = db.visits.find((x) => x.id === id); const d = { ...(vdraft()[id] || {}), result: val };
  const go = (dd) => { if (ui.offline) { const ent = { visitId: id, result: dd.result === 'kontant' ? 'udfoert' : dd.result, opId: 'm:' + id, extras: dd.extras, cashAmount: dd.cashAmount, payMethod: dd.payMethod, split: defaultSplit(v) };
      if (dd.result === 'spring') return toast('Udsæt kræver net'); ui.outbox.push(ent); delete vdraft()[id]; toast('Gemt – sendes når der er net'); return render(); }
    const r = applyDecisions([{ v, d: dd }]); toast(r.conflicts.length ? 'Konflikt: ' + r.conflicts[0] : `${cust(v.customerId).name}: ${STLABEL[dd.result]}`); save(); render();
    setTimeout(() => document.getElementById('nextStop')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  if (val === 'udfoert') return go(d);
  if (val === 'kontant') return openDlg(`<h2>💵 Betalt kontant – ${esc(cust(v.customerId).name)}</h2><label><span>Modtaget beløb (inkl. moms)</span><input name="amount" type="number" min="0" step="1" value="${Math.round(D.visitTotal({ ...v, extras: d.extras }) * 1.25)}" required></label>
    <p class="small mute">Betaler kunden med MobilePay eller kort, så tryk "Udført" – kunden får fakturaen på mail med betalingsknap.</p>`, (f) => go({ ...d, cashAmount: Number(f.amount) || 0, payMethod: 'kontant' }));
  return openDlg(`<h2>⏭ Udsæt – ${esc(cust(v.customerId).name)}</h2><label><span>Hvad skal der ske?</span><select name="skip">${skipOptions(v, {})}</select></label><label><span>Ny dato (kun ved "Skub til ny dato")</span><input type="date" name="moveDate"></label>`,
    (f) => { if ((f.skip === 'move' || f.skip === 'shift') && !f.moveDate) return 'Vælg ny dato'; go({ ...d, skip: f.skip, moveDate: f.moveDate }); });
}
function regDialog(id, result, cashPaid) {
  const v = db.visits.find((x) => x.id === id);
  const opId = S.uid('op'); // dannes ved tryk → genforsøg bruger samme id
  if (result === 'udfoert') return doReg({ visitId: id, result, opId, cashPaid: !!cashPaid });
  openDlg(`<h2>${esc(D.RESULTS[result])} – ${esc(cust(v.customerId).name)}</h2>
    <label><span>Bemærkning</span><textarea name="note" placeholder="Fx kunden ikke hjemme, port låst …"></textarea></label>
    ${result === 'delvis' ? `<label><span>Pris (kr ekskl. moms). Over ±20 % kræver admin-godkendelse</span><input type="number" name="price" value="${v.price}"></label>` : ''}`,
  (f) => doReg({ visitId: id, result, opId, note: f.note, price: f.price ? Number(f.price) : undefined }));
}
function doReg(op) {
  op.at = new Date().toISOString();
  if (ui.offline) { if (!ui.outbox.some((o) => o.opId === op.opId)) ui.outbox.push(op); toast('Gemt lokalt – sendes når der er net'); render(); return; }
  const vv = db.visits.find((x) => x.id === op.visitId); if (vv && !op.split) op.split = defaultSplit(vv);
  try { const r = S.registerVisit(db, ui.user, op.visitId, op); if (r.conflict) toast('Konflikt: ' + r.conflict); else toast(D.RESULTS[op.result] + ' registreret'); }
  catch (e) { toast(e.message); }
  render();
}
function flushOutbox() {
  const conflicts = [];
  for (const op of ui.outbox) { try { const r = S.registerVisit(db, ui.user, op.visitId, op); if (r.conflict) conflicts.push(r.conflict); } catch (e) { conflicts.push(e.message); } }
  const n = ui.outbox.length; ui.outbox = [];
  toast(conflicts.length ? `Synkroniseret ${n}, ${conflicts.length} konflikt(er): ${conflicts[0]}` : `Synkroniseret ${n} registrering(er)`);
}

/* ---------------- Fakturering ---------------- */
function faktura() {
  const q = D.invoiceQueue(db.visits, db.invoiceLinks).sort((a, b) => a.completion.at.localeCompare(b.completion.at));
  const links = [...db.invoiceLinks].reverse();
  $view.innerHTML = `<div class="card"><div class="row"><h2 class="sp">Faktureringskø (${q.length})</h2><label class="small"><input type="checkbox" id="perC" ${db.settings.perCustomerInvoice ? 'checked' : ''}> Samlefaktura pr. kunde</label></div>
    ${q.length ? `<table><tr><th><input type="checkbox" id="all" checked></th><th>Udført</th><th>Kunde</th><th class="hide-m">Ydelse</th><th>Af</th><th>Pris</th></tr>${q.map((v) => `<tr><td><input type="checkbox" class="qv" value="${v.id}" checked></td><td>${fmt(v.completion.at.slice(0, 10))}</td><td>${esc(cust(v.customerId).name)}${cust(v.customerId).billTo ? `<div class="small mute">💳 faktureres via ${esc(cust(cust(v.customerId).billTo)?.name)}</div>` : ''}</td><td class="hide-m small">${esc(v.service)}${v.status === 'delvis' ? ' (delvis)' : ''}${v.completion.priceChanged ? ' <span class="pill warn">pris ændret</span>' : ''}${v.completion.note ? `<br>💬 ${esc(v.completion.note)}` : ''}</td><td>${esc(emp(v.completion.by)?.name ?? v.completion.by)}<div class="small mute">${esc(PAY[cust(v.customerId).paymentMethod] ?? '')}${v.completion.cashPaid ? ` <span class="pill ok">${v.completion.payMethod === 'mobilepay' ? 'MobilePay' : 'kontant'} modtaget</span>` : ''}</div></td><td>${kr(v.price)}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:10px"><button class="${ecoReal() ? '' : 'pri'}" data-act="approve">${ecoReal() ? 'Fakturér valgte nu' : 'Godkend valgte → opret kladder (øve-udgave)'}</button>${ecoReal() ? '' : `<label class="small"><input type="checkbox" id="fail" ${eco.failNext ? 'checked' : ''}> Simulér timeout ved næste kald</label>`}</div>
    ${ecoReal() ? `<p class="small"><b>Automatisk:</b> færdigmeldte besøg faktureres af sig selv efter 5 minutter (så fejl kan nå at rettes). Kunder med "samlet pr. måned" faktureres den 1. i næste måned. Det sker, mens appen er åben hos en admin.</p><p class="small mute">Fakturaerne bogføres og ${db.settings.economic.sendEmail === false ? '<b>sendes ikke</b> (slået fra under Admin)' : 'sendes pr. mail til kunder med e-mail og "Email"-faktura'}. Kontant betalt på stedet lægges i kassekladden; bank og MobilePay afstemmes i e-conomic.</p>` : '<p class="small mute">⚠️ e-conomic er ikke forbundet – dette er en øve-udgave uden rigtige fakturaer. Opsætning: Admin → e-conomic.</p>'}` : '<p class="mute">Intet klar til fakturering. Registrér et besøg som udført i 📱 Dagsrute.</p>'}</div>
  <div class="card"><div class="row"><h2 class="sp">Fakturaer${ecoReal() ? '' : ' (øve-udgave)'}</h2><button data-act="syncPay">Hent betalingsstatus</button></div>
    ${links.length ? `<table><tr><th>Kunde</th><th>Besøg</th><th>Beløb</th><th>e-conomic</th><th>Status</th><th></th></tr>${links.map((l) => `<tr><td>${esc(cust(l.customerId)?.name)}</td><td>${l.visitIds.length}</td><td>${kr(l.total)}${l.gross ? `<div class="small mute">${kr(l.gross)} inkl. moms</div>` : ''}</td><td class="small">${l.invoiceNumber ? 'Faktura ' + l.invoiceNumber : l.draftNumber ? 'Kladde ' + l.draftNumber : '–'}${l.error ? `<div style="color:var(--bad)">${esc(l.error)}</div>` : ''}</td>
      <td><span class="pill ${INV[l.status]}">${l.status}</span> ${l.payment ? `<span class="pill ${l.payment === 'betalt' ? 'ok' : l.dueDate && l.dueDate < todayIso() ? 'bad' : 'warn'}">${l.payment === 'betalt' ? 'betalt' : l.dueDate && l.dueDate < todayIso() ? 'forfalden ' + fmt(l.dueDate) : l.payment}</span>` : ''}${l.sentBy === 'Email' ? ' <span class="pill">✉️ sendt</span>' : ''}${l.paymentRegistered ? ` <span class="pill ok" title="Indbetaling lagt i kassekladden">${l.paymentRegistered.method === 'kontant' ? '💵' : '📱'} ${kr(l.paymentRegistered.amount)}</span>` : ''}</td>
      <td>${l.status === 'fejl' ? `<button data-act="retry" data-id="${l.id}">Prøv igen</button>` : ''}${l.status === 'kladde' ? `<button data-act="book" data-id="${l.id}">Bogfør & send</button>` : ''}${l.status === 'bogført' && l.payment !== 'betalt' && !ecoReal() ? `<button class="small" data-act="pay" data-id="${l.id}" title="Kun øve-udgave">Simulér betaling</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="mute">Ingen endnu.</p>'}
    <p class="small mute">Status vises først som "kladde"/"bogført", når e-conomic har bekræftet. Regnskab, moms og bank ligger i e-conomic – appen henter betalingsstatus.</p></div>`;
  const all = document.getElementById('all'); if (all) all.onchange = () => $view.querySelectorAll('.qv').forEach((x) => (x.checked = all.checked));
  document.getElementById('perC').onchange = (e) => { db.settings.perCustomerInvoice = e.target.checked; save(); };
  const fl = document.getElementById('fail'); if (fl) fl.onchange = (e) => (eco.failNext = e.target.checked ? 1 : 0);
}

/* ---------------- Beskeder ---------------- */
function beskeder() {
  const unknown = db.smsMessages.filter((m) => m.dir === 'ind' && !m.customerId);
  const threads = new Map(); for (const m of db.smsMessages.filter((x) => x.customerId)) threads.set(m.customerId, [...(threads.get(m.customerId) || []), m]);
  const sorted = [...threads.entries()].map(([cid, ms]) => [cid, ms.sort((a, b) => a.at.localeCompare(b.at))]).sort((a, b) => b[1].at(-1).at.localeCompare(a[1].at(-1).at));
  const month = new Date().toISOString().slice(0, 7);
  const sentMonth = db.smsMessages.filter((m) => m.dir === 'ud' && m.at.startsWith(month)).reduce((s, m) => s + (m.parts || 1), 0);
  $view.innerHTML = `<div class="card row"><span class="sp">SMS-dele sendt denne måned: <b>${sentMonth}</b> · <span class="small mute">Gateway: Mock (ingen rigtige SMS)</span></span><button data-act="fakeInbound">Simulér indgående SMS</button></div>
  ${unknown.length ? `<div class="card"><h2>Ukendte afsendere (${unknown.length})</h2>${unknown.map((m) => `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="sp"><b>${esc(m.phone)}</b> · ${fmtTs(m.at)}<div>${esc(m.text)}</div></div><select data-attach="${m.id}"><option value="">Tilknyt kunde…</option>${db.customers.filter((c) => !c.deleted).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>`).join('')}</div>` : ''}
  <div class="card list"><h2>Samtaler</h2>${sorted.map(([cid, ms]) => { const last = ms.at(-1); const un = ms.filter((m) => m.dir === 'ind' && !m.read).length;
    return `<div class="item" data-cust="${cid}"><div><b>${esc(cust(cid)?.name)}</b> ${un ? `<span class="pill bad">${un} ny</span>` : ''}<div class="small mute">${last.dir === 'ud' ? 'Du: ' : ''}${esc(last.text.slice(0, 80))}</div></div><div class="small mute">${fmtTs(last.at)}<br>${last.dir === 'ud' ? esc(last.status) : ''}</div></div>`; }).join('') || '<p class="mute">Ingen samtaler endnu.</p>'}</div>`;
  $view.querySelectorAll('[data-attach]').forEach((s) => (s.onchange = () => { if (s.value) { S.attachInbound(db, ui.user, s.dataset.attach, s.value); render(); } }));
}

/* ---------------- Import fra SkvizBiz ---------------- */
const loadScript = (src) => new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('Kunne ikke hente ' + src.split('/').pop())); document.head.append(sc); });
async function pdfItems(f) {
  const V = 'vendor/pdfjs-3.11.174/'; // pdf.js (Apache-2.0) ligger lokalt – ingen ekstern afhængighed
  if (!window.pdfjsLib) await loadScript(V + 'pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
  const items = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    for (const it of tc.items) items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, page: p });
  }
  return items;
}
const isStamdata = (items) => items.some((i) => /^Kundenr\.\s*\d+\s*-/.test(i.str)) && items.some((i) => /^Leveringsadresse/.test(i.str));
async function readPdf(f) { return I.pdfItemsToTable(await pdfItems(f)); }
async function readTable(f) {
  if (/\.pdf$/i.test(f.name)) return readPdf(f);
  return I.parseCsv(await readFile(f));
}
async function readFile(f) {
  if (/\.xlsx?$/i.test(f.name)) {
    if (!window.XLSX) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('Kunne ikke hente Excel-læser – gem filen som CSV i stedet')); document.head.append(sc); });
    const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
    return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { FS: ';' });
  }
  const buf = await f.arrayBuffer(); const utf = new TextDecoder('utf-8').decode(buf);
  return utf.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf; // ældre Excel-CSV er ofte Windows-1252
}
function importView() {
  const st = ui.imp;
  const batches = (db.imports || []).slice().reverse();
  let html = `${db.settings.realData ? '' : '<div class="warnbox">Appen indeholder <b>testdata</b>. Før du importerer dine rigtige kunder: Admin → <b>Start tomt (til rigtige data)</b>. <button data-act="wipe">Start tomt nu</button></div>'}<div class="card"><h2>Import fra SkvizBiz</h2>
    <p class="small"><b>Fra SkvizBiz:</b> 1) Kunder → vælg alle → <b>Stamdata for valgte kunder</b> (én PDF). 2) Faste ruter → <b>ruteoversigt</b> for hver rute (én PDF pr. rute – giver rute og rækkefølge). Vælg alle PDF'erne her på én gang. Tilføj gerne <b>GDPR-udtrækket (zip)</b> – så kommer fakturatype, EAN, SMS-indstillinger og kort-koordinater med. Andre formater: 1) Gem kundekartoteket som PDF (eller Excel/CSV). 2) Vælg filen. 3) Tjek at kolonnerne passer. 4) Se forhåndsvisningen. 5) Importér. Intet gemmes før trin 5, og importen kan fortrydes. Filen læses kun i din browser – den sendes ingen steder hen.</p>
    <div class="row"><label class="btn pri">📄 Stamdata- og rute-PDF'er<input type="file" id="impStam" accept=".pdf" multiple hidden></label><label class="btn pri">📦 GDPR-udtræk (zip)<input type="file" id="impZip" accept=".zip" hidden></label><label class="btn">📁 Udpakket GDPR-mappe<input type="file" id="impDir" webkitdirectory multiple hidden></label><span class="small mute">eller PDF/Excel/CSV:</span><input type="file" id="impFile" accept=".pdf,.csv,.txt,.xlsx,.xls"><a class="btn" href="docs/eksempel-import.csv" download>Hent eksempelfil</a></div></div>`;
  if (st?.skviz && st.sheets?.length) {
    const sp = RS.buildSheetPlan(db, st.sheets, { today: todayIso() }); st.sheetPlan = sp;
    const cnt = (a) => sp.items.filter((x) => x.action === a).length;
    html += `<div class="card"><h2>Åbne ruter fra rutesedler</h2>
      ${db.customers.length ? '' : '<div class="warnbox">Importér kunderne (stamdata + ruteoversigter) først – rutesedlerne lægges ind på eksisterende kunder.</div>'}
      <table><tr><th>Ruteseddel</th><th>Rute</th><th>Kunder</th><th>Læg besøgene på</th></tr>${st.sheets.map((x, i) => `<tr><td class="small">${esc(x.fileName)}</td><td>${esc(x.routeName)}</td><td>${x.rows.length}</td><td><input type="date" data-sheetdate="${i}" value="${x.targetDate}"> <span class="small mute">(rutesedlens dato ${fmt(x.date)} ${x.date.slice(0, 4)})</span></td></tr>`).join('')}</table>
      <p><b>${cnt('visit')}</b> besøg på eksisterende aftaler · <b>${cnt('oneoff')}</b> enkeltopgaver oprettes · <b>${cnt('skip')}</b> springes over (har allerede besøg tæt på datoen)</p>
      ${sp.issues.length ? `<details ${sp.issues.some((i) => !i.warn) ? 'open' : ''}><summary>${sp.issues.filter((i) => !i.warn).length} fejl, ${sp.issues.filter((i) => i.warn).length} advarsler</summary><table>${[...sp.issues].sort((a, b) => !!a.warn - !!b.warn).map((i) => `<tr class="small"><td>${esc(i.line)}</td><td style="color:var(${i.warn ? '--warn' : '--bad'})">${esc(i.msg)}</td></tr>`).join('')}</table></details>` : ''}
      <div style="max-height:320px;overflow:auto"><table><tr><th>Nr</th><th>Kunde</th><th>Opgave</th><th>Aftale i appen</th><th>Pris</th><th></th></tr>${sp.items.map((x) => `<tr class="small" style="${x.action === 'skip' ? 'opacity:.5' : ''}"><td>${x.row.nr}</td><td>${esc(x.c.name)}</td><td>${esc(x.task.service)}</td><td>${x.g ? esc(x.g.service) + ' · ' + agrDesc(x.g) : '<span style="color:var(--warn)">ny enkeltopgave</span>'}</td><td>${kr(x.price || 0)}</td><td>${x.action === 'skip' ? esc(x.reason) : ''}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="pri" data-act="sheetApply" ${db.customers.length ? '' : 'disabled'}>Læg ${cnt('visit') + cnt('oneoff')} besøg ind</button><button data-act="impCancel">Annuller</button></div></div>`;
  }
  if (st?.skviz && (st.stams.length || st.overviews?.length || !st.sheets?.length)) {
    const plan = SD.buildSkvizPlan(st.stams, st.gdprMap, db, { today: todayIso() }); if (st.overviews?.length) SD.addRouteOverviews(plan, st.overviews, db, { today: todayIso() }); st.plan = plan;
    const nAgr = plan.customers.reduce((s, c) => s + c.addresses[0].agreements.length, 0);
    html += `<div class="card"><h2>Filer</h2><table>${st.stams.length ? '' : '<tr><td class="mute small">Ingen stamdata-PDF – kunder fra ruteoversigter får ikke kundenr. og næste dato</td></tr>'}<tr><th>Stamdata-PDF</th><th>Kunder</th><th>Rute for kunderne i filen</th><th></th></tr>${st.stams.map((f, i) => `<tr><td>${esc(f.fileName)}</td><td>${f.customers.length}</td>
      <td><select data-stroute="${i}"><option value="">Ingen – tildel senere</option>${db.routes.map((r) => `<option value="${r.id}" ${r.id === f.routeId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="__new">+ Opret ny rute …</option></select></td><td><button data-act="stRemove" data-i="${i}">Fjern</button></td></tr>`).join('')}</table>
      ${st.overviews?.length ? `<table style="margin-top:8px"><tr><th>Ruteoversigt</th><th>Kunder</th><th>Fundet i stamdata</th><th>Rute i appen</th></tr>${st.overviews.map((o, i) => { const nr = plan.newRoutes?.find((x) => x.name === o.routeName);
      return `<tr><td>${esc(o.routeName || o.fileName)}</td><td>${o.rows.length}</td><td>${nr ? nr.matched : '–'}</td><td>${nr ? `<span class="pill">ny</span> hver ${nr.intervalWeeks}. uge · næste ${nr.anchorDate ? fmt(nr.anchorDate) + ' ' + nr.anchorDate.slice(0, 4) : '<span style="color:var(--warn)">ukendt</span>'}` : '<span class="pill ok">findes</span>'} <button data-act="ovRemove" data-i="${i}">Fjern</button></td></tr>`; }).join('')}</table>` : ''}
      <p class="small">GDPR-udtræk: ${st.gdprMap ? `<b>${Object.keys(st.gdprMap).length} kunder</b> (${esc(st.gdprName)})` : '<span class="mute">ikke tilføjet – valgfrit</span>'}</p></div>
    <div class="card"><h2>Forhåndsvisning</h2>${plan.newRoutes?.length || plan.routeUpdates?.length ? `${plan.routeStats ? `<p>Rutekunder fundet i stamdata: <b>${plan.routeStats.matched}</b> af ${plan.routeStats.rows}${plan.routeStats.rows - plan.routeStats.matched ? ` <span class="small mute">(resten oprettes som nye kunder uden kundenr. – se advarsler)</span>` : ''}</p>` : ''}<p><b>${plan.newRoutes.length}</b> nye ruter${plan.resetRoutes?.length ? ` · <b>${plan.resetRoutes.length}</b> tomme ruter får rytme og dato` : ''} · <b>${plan.routeUpdates.length}</b> eksisterende kunder får rute og rækkefølge</p>` : ''}<p><b>${plan.customers.length}</b> nye kunder · <b>${nAgr}</b> aftaler${plan.skipped ? ` · ${plan.skipped} slettede sprunget over` : ''}</p>
      ${plan.duplicates.length ? `<div class="warnbox">${plan.duplicates.length} findes allerede (samme kundenr.) og springes over. <label><input type="checkbox" id="impDup" ${st.includeDup ? 'checked' : ''}> Importér dem alligevel</label></div>` : ''}
      ${plan.issues.length ? `<details ${plan.errors ? 'open' : ''}><summary>${plan.errors} fejl, ${plan.issues.length - plan.errors} advarsler</summary><table>${[...plan.issues].sort((a, b) => !!a.warn - !!b.warn).slice(0, 400).map((i) => `<tr class="small"><td>${esc(i.line)}</td><td style="color:var(${i.warn ? '--warn' : '--bad'})">${esc(i.msg)}</td></tr>`).join('')}</table></details>` : '<p class="pill ok">Ingen problemer fundet</p>'}
      <div style="max-height:420px;overflow:auto;margin-top:10px"><table><tr><th>Kundenr.</th><th>Navn</th><th>Adresse</th><th>Tlf.</th><th>Husk hver gang</th><th>Aftaler</th><th>Faktura</th></tr>${plan.customers.slice(0, 600).map((c) => `<tr class="small" style="${c.dupeOf ? 'opacity:.5' : ''}"><td>${esc(c.extId || '–')}${c.routeNr ? `<div class="mute">nr. ${c.routeNr}</div>` : ''}</td><td>${esc(c.name)}</td><td>${esc(c.addresses[0].street)}</td><td>${esc(c.phone)}</td><td>${esc(c.addresses[0].access)}</td>
        <td>${c.addresses[0].agreements.map((g) => `${esc(g.service)} · ${kr(g.price)} · ${agrDesc(g)}${g.intervalWeeks ? ' · ' + (g.anchorDate ? fmt(g.anchorDate) : 'rutens næste dato') : ''} · ${g.durationMin} min${g.routeId ? ' · ' + esc(route(g.routeId)?.name) : g.routeRef?.startsWith('new:') ? ' · ' + esc(g.routeRef.slice(4)) + ' (ny)' : ''}`).join('<br>') || '<span class="mute">–</span>'}</td><td>${esc(INVTYPE[c.extra.invoiceType])}${c.paymentMethod === 'kontant' ? ' 💰' : ''}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="pri" data-act="impApply">Importér</button><button data-act="impCancel">Annuller</button></div></div>`;
  } else if (st?.gdpr) {
    const plan = G.buildGdprPlan(st.files, db, { today: todayIso() }); st.plan = plan; st.updates = G.gdprUpdates(plan, db);
    const newOnes = plan.customers.filter((c) => !c.dupeOf).length;
    if (db.customers.length) html += `<div class="card"><h2>Opdatér eksisterende kunder</h2><p><b>${st.updates.length}</b> af dine kunder får oplysninger fra GDPR-udtrækket (fakturatype, EAN, SMS før/efter, ring før, kontant, kort-koordinater, manglende tlf./e-mail). Navn, adresse, aftaler og ruter røres ikke.</p>
      <p class="small">${newOnes ? `<label><input type="checkbox" id="impNew" ${st.includeNew ? 'checked' : ''}> Opret også ${newOnes} kunder, der ikke findes i appen</label>` : 'Alle kunder i udtrækket findes allerede i appen.'}</p>
      <div class="row"><button class="pri" data-act="gdprUpdate">Opdatér ${st.updates.length} kunder${st.includeNew && newOnes ? ` + opret ${newOnes}` : ''}</button><button data-act="impCancel">Annuller</button></div></div>`;
    const nAgr = plan.customers.reduce((s, c) => s + c.addresses[0].agreements.length, 0); const noAgr = plan.customers.filter((c) => !c.addresses[0].agreements.length).length;
    html += `<div class="card"><h2>Forhåndsvisning – ${esc(st.fileName)}</h2>
      <p><b>${plan.customers.length}</b> kunder · <b>${nAgr}</b> aftaler${noAgr ? ` · <span style="color:var(--warn)">${noAgr} uden aftale</span>` : ''}${plan.skipped ? ` · ${plan.skipped} slettede sprunget over` : ''}</p>
      ${plan.unmatchedRoutes.size ? `<div class="warnbox">${plan.unmatchedRoutes.size} ruter findes ikke i appen: ${[...plan.unmatchedRoutes.keys()].slice(0, 30).map(esc).join(', ')} <button data-act="impMakeRoutes">Opret dem</button></div>` : ''}
      ${plan.duplicates.length ? `<div class="warnbox">${plan.duplicates.length} findes allerede (samme kundenr./telefon) og springes over. <label><input type="checkbox" id="impDup" ${st.includeDup ? 'checked' : ''}> Importér dem alligevel</label></div>` : ''}
      <details><summary>Teknisk: felter i data.json (til tilpasning af importen)</summary><p class="small">Aftaler fundet under: <code>${[...plan.agreementPaths].map(esc).join(', ') || 'ingen'}</code></p>
        <p class="small">Ukendte felter (bruges ikke endnu): ${[...plan.unknownKeys.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<code>${esc(k)}</code> (${n})`).join(', ') || 'ingen'}</p></details>
      ${plan.issues.length ? `<details><summary>${plan.errors} fejl, ${plan.issues.length - plan.errors} advarsler</summary><table>${plan.issues.slice(0, 300).map((i) => `<tr class="small"><td>${esc(i.line)}</td><td style="color:var(${i.warn ? '--warn' : '--bad'})">${esc(i.msg)}</td></tr>`).join('')}</table></details>` : ''}
      <div style="max-height:380px;overflow:auto;margin-top:10px"><table><tr><th>Kundenr.</th><th>Navn</th><th>Adresse</th><th>Tlf.</th><th>Aftaler</th><th>Faktura</th></tr>${plan.customers.slice(0, 500).map((c) => `<tr class="small" style="${c.dupeOf ? 'opacity:.5' : ''}"><td>${esc(c.extId)}</td><td>${esc(c.name)}</td><td>${esc(c.addresses[0].street)}</td><td>${esc(c.phone)}</td>
        <td>${c.addresses[0].agreements.map((g) => `${esc(g.service)} · ${kr(g.price)} · ${agrDesc(g)}${g.routeRaw ? ' · ' + esc(g.routeRaw) : ''}${g.intervalWeeks ? ' · ' + fmt(g.anchorDate) : ''}`).join('<br>') || '<span class="mute">–</span>'}</td><td>${esc(INVTYPE[c.extra.invoiceType])}${c.paymentMethod === 'kontant' ? ' 💰' : ''}</td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="pri" data-act="impApply">Importér ${plan.customers.filter((c) => st.includeDup || !c.dupeOf).length} kunder</button><button data-act="impCancel">Annuller</button></div></div>`;
  } else if (st && !st.skviz) {
    const p = st.parsed;
    html += `<div class="card"><h2>Kolonner i ${esc(st.fileName)} (${p.rows.length} rækker)</h2><div class="grid">${Object.entries(I.FIELDS).map(([f, label]) => `<label><span>${esc(label)}</span><select data-map="${f}"><option value="">– ikke i filen –</option>${p.headers.map((h, i) => `<option value="${i}" ${st.mapping[f] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div>
      <label><span>Standardrute for kunder uden rute</span><select id="impRoute">${db.routes.map((r) => `<option value="${r.id}" ${st.route === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label></div>`;
    const plan = I.buildImportPlan(p, st.mapping, db, { defaultRouteId: st.route || db.routes[0].id, today: todayIso() }); st.plan = plan;
    const nAgr = plan.customers.reduce((s, c) => s + c.addresses.reduce((t, a) => t + a.agreements.length, 0), 0);
    html += `<div class="card"><h2>Forhåndsvisning</h2>
      <p><b>${plan.customers.length}</b> kunder · <b>${plan.customers.reduce((s, c) => s + c.addresses.length, 0)}</b> adresser · <b>${nAgr}</b> aftaler${plan.skipped ? ` · ${plan.skipped} tomme rækker sprunget over` : ''}</p>
      ${plan.duplicates.length ? `<div class="warnbox">${plan.duplicates.length} findes allerede (samme kundenr./telefon) og springes over: ${plan.duplicates.slice(0, 8).map((d) => esc(d.name)).join(', ')}${plan.duplicates.length > 8 ? ' …' : ''}<br><label><input type="checkbox" id="impDup" ${st.includeDup ? 'checked' : ''}> Importér dem alligevel</label></div>` : ''}
      ${plan.issues.length ? `<details ${plan.errors ? 'open' : ''}><summary>${plan.errors} fejl, ${plan.issues.length - plan.errors} advarsler</summary><table>${plan.issues.slice(0, 200).map((i) => `<tr class="small"><td>Linje ${i.line}</td><td style="color:var(${i.warn ? '--warn' : '--bad'})">${esc(i.msg)}</td></tr>`).join('')}</table></details>` : '<p class="pill ok">Ingen problemer fundet</p>'}
      <div style="max-height:360px;overflow:auto;margin-top:10px"><table><tr><th>Navn</th><th>Telefon</th><th>Adresse</th><th>Aftale</th><th>Betaling</th></tr>${plan.customers.slice(0, 300).map((c) => c.addresses.map((a, j) => `<tr class="small" style="${c.dupeOf ? 'opacity:.5' : ''}"><td>${j ? '' : esc(c.name)}</td><td>${j ? '' : esc(c.phone)}</td><td>${esc(a.street)}</td><td>${a.agreements.map((g) => `${esc(g.service)} · ${g.price ? kr(g.price) : '<span style="color:var(--warn)">pris mangler</span>'} · ${agrDesc(g)}${g.intervalWeeks ? ' · fra ' + fmt(g.anchorDate) : ''}`).join('<br>') || '<span class="mute">ingen</span>'}</td><td>${j ? '' : PAY[c.paymentMethod]}</td></tr>`).join('')).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="pri" data-act="impApply" ${plan.errors ? '' : ''}>Importér ${plan.customers.filter((c) => st.includeDup || !c.dupeOf).length} kunder</button><button data-act="impCancel">Annuller</button>${plan.errors ? '<span class="small" style="color:var(--bad)">Rækker med fejl importeres med de felter der kunne læses – ret gerne filen først.</span>' : ''}</div></div>`;
  }
  if (batches.length) html += `<div class="card"><h2>Tidligere importer</h2><table>${batches.map((b) => `<tr><td>${fmtTs(b.at)}</td><td>${b.counts.customers} kunder · ${b.counts.agreements} aftaler · ${b.counts.visits} besøg${b.issues?.length ? ` · <a href="#" data-act="showIssues" data-id="${b.batchId}">${b.issues.filter((i) => !i.done).length} advarsler</a>` : ''}</td><td>${b.rolledBack ? '<span class="pill">fortrudt</span>' : `<button class="bad" data-act="impUndo" data-id="${b.batchId}">Fortryd</button>`}</td></tr>`).join('')}</table></div>`;
  $view.innerHTML = html;
  document.getElementById('impFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
    try { toast('Læser fil …'); const parsed = await readTable(f); if (!parsed.headers.length) throw new Error('Filen er tom'); ui.imp = { fileName: f.name, parsed, mapping: I.guessMapping(parsed.headers), route: db.routes[0].id }; render(); } catch (err) { toast(err.message); } };
  const loadGdpr = async (files, fileName) => { if (!files.length) throw new Error('Ingen data.json fundet – er det SkvizBiz\' GDPR-udtræk?'); ui.imp = { gdpr: true, fileName, files }; toast(`${files.length} kunder læst`); render(); };
  document.getElementById('impStam').onchange = async (e) => { const fs = [...e.target.files]; if (!fs.length) return;
    try { toast('Læser PDF …'); let cur = ui.imp?.skviz ? ui.imp : { skviz: true, stams: [], gdprMap: null };
      if (ui.imp?.gdpr) { const map = {}; for (const x of ui.imp.files) { try { const o = G.normalize(JSON.parse(x.json)); if (o.number != null) map[String(o.number).padStart(8, '0')] = o; } catch {} } cur.gdprMap = map; cur.gdprName = ui.imp.fileName; }
      cur.overviews ||= [];
      for (const f of fs) { const items = await pdfItems(f);
        if (RS.isRouteSheet(items)) { const sh = RS.parseRouteSheetItems(items); cur.sheets ||= []; cur.sheets = cur.sheets.filter((x) => !(x.date === sh.date && x.routeName === sh.routeName)); cur.sheets.push({ ...sh, fileName: f.name, targetDate: sh.date }); continue; }
        if (SD.isRouteOverview(items)) { const ov = SD.parseRouteOverviewItems(items); cur.overviews = cur.overviews.filter((o) => o.routeName !== ov.routeName); cur.overviews.push({ ...ov, fileName: f.name }); continue; }
        if (!isStamdata(items)) throw new Error(`${f.name} ligner hverken en stamdata-PDF eller en ruteoversigt fra SkvizBiz`); const customers = SD.parseStamdataItems(items);
        const guess = db.routes.find((r) => f.name.toLowerCase().includes(r.name.toLowerCase())); cur.stams.push({ fileName: f.name, routeId: guess?.id || '', customers }); }
      ui.imp = cur; toast(`${cur.stams.reduce((s, x) => s + x.customers.length, 0)} kunder i stamdata · ${cur.overviews.length} ruteoversigter${cur.sheets?.length ? ` · ${cur.sheets.length} rutesedler` : ''}`); render(); } catch (err) { toast(err.message); } };
  $view.querySelectorAll('[data-stroute]').forEach((sl) => (sl.onchange = () => { const f = st.stams[+sl.dataset.stroute];
    if (sl.value === '__new') { const name = prompt('Navn på ny rute (som i SkvizBiz):', f.fileName.replace(/\.pdf$/i, '')); if (!name) return render(); const r = { id: S.uid('r'), name: name.trim(), employeeId: db.employees[0].id, intervalWeeks: 4, anchorDate: D.nextWorkday(todayIso()) };
      const firstAg = f.customers.flatMap((c) => c.agreements).map((a) => I.parseDate(a.next)).filter((d) => d && !Number.isNaN(d)).sort()[0]; if (firstAg) r.anchorDate = firstAg;
      db.routes.push(r); f.routeId = r.id; S.audit(db, ui.user.id, 'route.create', r.id, { name: r.name }); toast(`Rute "${r.name}" oprettet – ret rytme/medarbejder under Admin`); }
    else f.routeId = sl.value; render(); }));
  document.getElementById('impZip').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
    try { toast('Læser zip …'); const ents = await G.unzip(await f.arrayBuffer(), (n) => /(^|\/)data\.json$/i.test(n));
      if (ui.imp?.skviz) { const map = {}; for (const x of ents) { try { const o = G.normalize(JSON.parse(new TextDecoder('utf-8').decode(x.bytes))); if (o.number != null) map[String(o.number).padStart(8, '0')] = o; } catch {} } ui.imp.gdprMap = map; ui.imp.gdprName = f.name; toast(`GDPR: ${Object.keys(map).length} kunder koblet på`); return render(); }
      await loadGdpr(ents.map((x) => ({ name: x.name.split('/').slice(-2, -1)[0] || x.name, json: new TextDecoder('utf-8').decode(x.bytes) })), f.name); } catch (err) { toast(err.message); } };
  document.getElementById('impDir').onchange = async (e) => { const fs = [...e.target.files].filter((f) => /^data\.json$/i.test(f.name));
    try { await loadGdpr(await Promise.all(fs.map(async (f) => ({ name: (f.webkitRelativePath || f.name).split('/').slice(-2, -1)[0] || f.name, json: await f.text() }))), 'mappe'); } catch (err) { toast(err.message); } };
  $view.querySelectorAll('[data-map]').forEach((sl) => (sl.onchange = () => { if (sl.value === '') delete st.mapping[sl.dataset.map]; else st.mapping[sl.dataset.map] = +sl.value; render(); }));
  const ir = document.getElementById('impRoute'); if (ir) ir.onchange = () => { st.route = ir.value; render(); };
  $view.querySelectorAll('[data-sheetdate]').forEach((x) => (x.onchange = () => { if (x.value) { st.sheets[+x.dataset.sheetdate].targetDate = x.value; render(); } }));
  const nw = document.getElementById('impNew'); if (nw) nw.onchange = () => { st.includeNew = nw.checked; render(); };
  const dp = document.getElementById('impDup'); if (dp) dp.onchange = () => { st.includeDup = dp.checked; render(); };
}

/* ---------------- Admin ---------------- */
function admin() {
  const t = todayIso(); const mon = ui.comMonth || t.slice(0, 7); const from = mon + '-01'; const to = D.addDays(D.addDays(from, 32).slice(0, 7) + '-01', -1);
  const rates = Object.fromEntries(db.employees.map((e) => [e.id, e.commissionRate ?? db.settings.commissionRate]));
  const com = D.commission(db.visits, { rates, from, to, inclVat: !!db.settings.commissionInclVat });
  ui._com = { com, mon };
  const perRoute = db.routes.map((r) => { const vs = db.visits.filter((v) => v.routeId === r.id && D.isBillable(v) && v.completion?.at.slice(0, 10) >= from && v.completion?.at.slice(0, 10) <= to); return [r, vs.length, vs.reduce((s, v) => s + v.price, 0)]; });
  $view.innerHTML = `<div class="grid">
    <div class="card"><div class="row"><h2 class="sp">Provision</h2><input type="month" id="comMonth" value="${mon}"></div>
      <table><tr><th>Medarbejder</th><th>Sats %</th><th>Besøg</th><th>Grundlag</th><th>Provision</th></tr>${db.employees.map((e) => { const x = com[e.id] || { visits: 0, base: 0, commission: 0 };
        return `<tr><td>${esc(e.name)}</td><td><input type="number" min="0" max="100" step="0.5" data-rate="${e.id}" value="${Math.round(rates[e.id] * 1000) / 10}" style="width:70px"></td><td>${x.visits}</td><td>${kr(x.base)}</td><td><b>${kr(x.commission)}</b></td></tr>`; }).join('')}</table>
      <label class="small"><input type="checkbox" id="comVat" ${db.settings.commissionInclVat ? 'checked' : ''}> Beregn af beløb inkl. moms</label>
      <div class="row" style="margin-top:8px"><button data-act="comCsv">Eksportér løngrundlag (CSV)</button></div>
      <p class="small mute">Grundlag: udførte/delvist udførte besøg i måneden (udførelsesdato), ekskl. moms. Feriepenge mv. beregnes i lønsystemet. Rabatter/kreditnotaer trækkes ikke fra endnu.</p></div>
    <div class="card"><h2>Omsætning pr. rute (${mon})</h2><table>${perRoute.map(([r, n, s]) => `<tr><td>${esc(r.name)}</td><td>${n}</td><td>${kr(s)}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Integrationer</h2>
      <div>e-conomic: <span class="pill warn">Mock</span></div><div>SMS-gateway: <span class="pill warn">Mock</span></div><div>Google Maps: <span class="pill ok">Links (gratis)</span></div>
      <p class="small mute">Rigtige integrationer kræver en server (nøgler må ikke ligge i browseren). Se docs/PLAN.md.</p></div>
    <div class="card"><h2>Data & backup</h2><div class="row"><button data-act="backup">Download backup (JSON)</button><label class="btn">Gendan…<input type="file" id="restore" accept=".json" hidden></label><button data-act="planMore">Planlæg 6 mdr. frem</button><button class="bad" data-act="reset">Nulstil til testdata</button><button class="bad" data-act="wipe">Start tomt (til rigtige data)</button></div>
      <p class="small mute">Data gemmes på denne enhed (${KV.usingIdb() ? 'IndexedDB' : 'localStorage – begrænset plads'})${syncer ? ' og i den fælles database' : ''}. ${db.customers.length} kunder · ${db.visits.length} besøg · ${db.audit.length} logposter.</p></div>
  </div>
  ${!db.settings.printInvoices ? '' : `<div class="card"><h2>Firma (bruges på A4-fakturaer)</h2><div class="grid">${[['name', 'Firmanavn', 'Sindal Vinduespolering'], ['address', 'Adresse', 'Vej 1, 9870 Sindal'], ['cvr', 'CVR', ''], ['phone', 'Telefon', ''], ['email', 'E-mail', ''], ['bank', 'Bank reg. og konto', '1234 1234567'], ['mobilepay', 'MobilePay-nr.', '']].map(([k, l, ph]) => `<label><span>${l}</span><input data-firm="${k}" value="${esc(db.settings.firm?.[k] || '')}" placeholder="${ph}"></label>`).join('')}</div></div>`}
  <div class="card" id="cloudCard"></div>
  <div class="card" id="ecoCard"></div>
  <div class="card"><h2>Kørsel og Google Maps</h2>
    <div class="grid"><label><span>Firmaets startadresse (her starter og slutter dagen)</span><input id="stAddr" value="${esc(db.settings.start?.address || '')}" placeholder="Vej 1, 9870 Sindal"></label>
      <label><span>Koordinater for startadresse (valgfrit, "57.47, 10.21" – højreklik i Google Maps)</span><input id="stLL" value="${db.settings.start?.lat != null ? db.settings.start.lat + ', ' + db.settings.start.lng : ''}"></label>
      <label><span>Google Maps API-nøgle (Routes API)</span><input id="gKey" type="password" value="${esc(db.settings.googleKey || '')}" placeholder="AIza…"></label></div>
    <p class="small mute">Uden nøgle bruges et skøn (luftlinje × 1,3 ved 50 km/t). Med nøgle hentes rigtige køretider og optimal rækkefølge fra Google. Opret nøglen i Google Cloud, slå <b>Routes API</b> til, og begræns nøglen til <b>${esc(location.host || 'dit domæne')}</b>. Google tager betaling pr. beregning efter en gratis kvote – priser SKAL VERIFICERES. Nøglen gemmes kun i denne browser.</p></div>
  <div class="card"><h2>Medarbejdere</h2>
    <table><tr><th>Navn</th><th>Rolle</th><th>Provision %</th><th>Ruter</th><th></th></tr>${db.employees.filter((e) => !e.inactive).map((e) => `<tr><td><input data-ef="name" data-e="${e.id}" value="${esc(e.name)}"></td>
      <td><select data-ef="role" data-e="${e.id}"><option value="admin" ${e.role === 'admin' ? 'selected' : ''}>Ejer/admin</option><option value="medarbejder" ${e.role !== 'admin' ? 'selected' : ''}>Medarbejder</option></select></td>
      <td><input type="number" min="0" max="100" step="0.5" data-ef="commissionRate" data-e="${e.id}" value="${Math.round((e.commissionRate ?? db.settings.commissionRate) * 1000) / 10}" style="width:70px"></td>
      <td class="small">${db.routes.filter((r) => r.employeeId === e.id).map((r) => esc(r.name)).join(', ') || '–'}</td><td><button class="bad" data-act="empDel" data-id="${e.id}">Fjern</button></td></tr>`).join('')}</table>
    <button data-act="empAdd" style="margin-top:8px">+ Medarbejder</button>
    <p class="small mute">Prototypen har ikke login endnu – brugeren vælges i topbjælken. Medarbejdere ser kun egne ruter og ingen økonomi.</p></div>
  <div class="card"><h2>Ruter</h2>
    <table><tr><th>Navn</th><th>Medarbejder</th><th>Hver … uge</th><th>Næste dato</th></tr>${db.routes.map((r) => `<tr><td><input data-rf="name" data-r="${r.id}" value="${esc(r.name)}"></td><td><select data-rf="employeeId" data-r="${r.id}">${db.employees.filter((x) => !x.inactive).map((e) => `<option value="${e.id}" ${e.id === r.employeeId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></td>
      <td><input type="number" min="1" max="52" data-rf="intervalWeeks" data-r="${r.id}" value="${r.intervalWeeks}" style="width:70px"></td><td><input type="date" data-rf="anchorDate" data-r="${r.id}" value="${D.nextRouteDate(r, todayIso())}"></td></tr>`).join('')}</table>
    <div class="row" style="margin-top:8px"><button data-act="showCheck">Datakontrol</button><button data-act="addRoute">+ Rute</button><button data-act="delEmptyRoutes">Slet ruter uden kunder</button><button data-act="recalcRoutes">Genberegn rytme og dato ud fra kunderne</button></div>
    <p class="small mute">Ændring af rutens dato/rytme flytter ikke eksisterende besøg automatisk – brug Kalender (flyt/forskyd) eller ret aftalerne.</p></div>
  <div class="card"><h2>SMS-skabeloner</h2>${Object.entries(db.templates).map(([k, v]) => `<label><span>${esc(k)} – felter: {navn} {dato} {tid} {nydato}</span><textarea data-tpl="${k}">${esc(v)}</textarea></label>`).join('')}</div>
  <div class="card"><h2>Lukkedage (ferie mv.)</h2><p class="small mute">Helligdage beregnes automatisk. Besøg på lukkedage flyttes til næste arbejdsdag ved planlægning.</p><div class="row"><input type="date" id="cd"><button data-act="addClosed">Tilføj</button></div><div class="small">${db.closedDays.map((d) => `<span class="pill">${d} <a href="#" data-act="rmClosed" data-d="${d}">×</a></span>`).join(' ')}</div></div>
  <div class="card"><h2>Auditlog</h2><div style="max-height:320px;overflow:auto"><table><tr><th>Tid</th><th>Bruger</th><th>Handling</th><th>Ref</th></tr>${db.audit.slice(0, 200).map((a) => `<tr class="small"><td>${fmtTs(a.at)}</td><td>${esc(userName(a.by))}</td><td>${esc(a.action)}</td><td class="mute">${esc(a.ref)} ${esc(JSON.stringify(a.detail).slice(0, 80))}</td></tr>`).join('')}</table></div></div>`;
  document.getElementById('comMonth').onchange = (e) => { ui.comMonth = e.target.value; render(); };
  document.getElementById('comVat').onchange = (e) => { db.settings.commissionInclVat = e.target.checked; S.audit(db, ui.user.id, 'commission.vat', '-', { inclVat: e.target.checked }); render(); };
  $view.querySelectorAll('[data-rate]').forEach((i) => (i.onchange = () => { const v = Number(i.value); if (!(v >= 0 && v <= 100)) return toast('Ugyldig sats'); const e = emp(i.dataset.rate); e.commissionRate = v / 100; S.audit(db, ui.user.id, 'commission.rate', e.id, { rate: v }); render(); }));
  cloudCard(); ecoCard();
  $view.querySelectorAll('[data-firm]').forEach((x) => (x.onchange = () => { db.settings.firm ||= {}; db.settings.firm[x.dataset.firm] = x.value.trim(); save(); toast('Gemt'); }));
  const saveStart = () => { const ll = (document.getElementById('stLL').value.match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/) || []);
    db.settings.start = { address: document.getElementById('stAddr').value.trim(), lat: ll[1] ? +ll[1].replace(',', '.') : null, lng: ll[2] ? +ll[2].replace(',', '.') : null }; save(); toast('Startadresse gemt'); };
  document.getElementById('stAddr').onchange = saveStart; document.getElementById('stLL').onchange = saveStart;
  document.getElementById('gKey').onchange = (e) => { db.settings.googleKey = e.target.value.trim(); S.audit(db, ui.user.id, 'settings.googleKey', '-', { set: !!db.settings.googleKey }); save(); toast(db.settings.googleKey ? 'Nøgle gemt' : 'Nøgle fjernet'); };
  $view.querySelectorAll('[data-ef]').forEach((el) => (el.onchange = () => { const e = emp(el.dataset.e); const f = el.dataset.ef;
    if (f === 'role' && el.value !== 'admin' && db.employees.filter((x) => !x.inactive && x.role === 'admin').length === 1 && e.role === 'admin') { toast('Der skal være mindst én admin'); return render(); }
    e[f] = f === 'commissionRate' ? Math.min(100, Math.max(0, +el.value || 0)) / 100 : el.value.trim(); S.audit(db, ui.user.id, 'employee.edit', e.id, { [f]: e[f] }); render(); }));
  $view.querySelectorAll('[data-rf]').forEach((el) => (el.onchange = () => { const r = route(el.dataset.r); const f = el.dataset.rf; r[f] = f === 'intervalWeeks' ? Math.max(1, +el.value || 1) : el.value; if (f === 'anchorDate') delete r.anchorUnknown; S.audit(db, ui.user.id, 'route.edit', r.id, { [f]: r[f] }); render(); }));
  $view.querySelectorAll('[data-tpl]').forEach((t) => (t.onchange = () => { db.templates[t.dataset.tpl] = t.value; save(); toast('Skabelon gemt'); }));
  document.getElementById('restore').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (!Array.isArray(d.customers) || !Array.isArray(d.visits)) throw new Error('Ugyldig backup'); if (!confirm(`Gendan ${d.customers.length} kunder? Nuværende data overskrives.`)) return; db = d; await save(); location.reload(); } catch (err) { toast(err.message); } };
}

/* ---------------- Dialog-hjælper ---------------- */
function openDlg(html, onSubmit, closeLabel = 'Annuller') {
  const dlg = document.getElementById('dlg'), body = document.getElementById('dlgBody');
  body.innerHTML = html + `<div class="row" style="margin-top:14px"><span class="sp"></span><button value="cancel" formnovalidate>${closeLabel}</button>${onSubmit ? '<button class="pri" value="ok">Gem</button>' : ''}</div><p class="small" id="dlgErr" style="color:var(--bad)"></p>`;
  body.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(body)); body.querySelectorAll('input[type=checkbox]').forEach((c) => (f[c.name] = c.checked));
    try { const r = await onSubmit(f); if (typeof r === 'string') { document.getElementById('dlgErr').textContent = r; return; } if (r === false) return; dlg.close(); render(); }
    catch (err) { document.getElementById('dlgErr').textContent = err.message; }
  };
  dlg.showModal();
}

/* ---------------- Hændelser ---------------- */
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]'); if (tab) { ui.tab = tab.dataset.tab; ui.customer = null; return render(); }
  const cu = e.target.closest('[data-cust]'); if (cu) { e.preventDefault(); document.getElementById('dlg').open && document.getElementById('dlg').close(); ui.tab = 'kunder'; ui.customer = cu.dataset.cust; return render(); }
  const vsl = (e.ctrlKey || e.metaKey || e.shiftKey) && e.target.closest('.vline[data-visit]');
  if (vsl) { e.preventDefault(); ui.visSel ||= new Set(); const id = vsl.dataset.visit; ui.visSel.has(id) ? ui.visSel.delete(id) : ui.visSel.add(id); return render(); }
  const rs = (e.ctrlKey || e.metaKey) && e.target.closest('.rblock[data-rsel]');
  if (rs) { e.preventDefault(); ui.calSel ||= new Set(); const k = rs.dataset.rsel; ui.calSel.has(k) ? ui.calSel.delete(k) : ui.calSel.add(k); return render(); }
  const blk = e.target.closest('.rblock[data-rsel]');
  if (blk && !e.target.closest('button, .vline, .grip') && (e.target === blk || e.target.closest('.rhead, .rmeta'))) { const [rid, d] = blk.dataset.rsel.split('|');
    if (window.innerWidth <= 820) return routeMenu(rid, d);
    ui.calPick = ui.calPick === blk.dataset.rsel ? null : blk.dataset.rsel; ui._rm = { rid, day: d }; ui.calDay = null; return render(); }
  const stb = e.target.closest('[data-st]');
  if (stb) { const id = stb.dataset.st, val = stb.dataset.v; const d = vdraft()[id] || {};
    if (ui.tab === 'mobil') return mobileStatus(id, val);
    vdraft()[id] = { ...d, result: d.result === val ? 'aaben' : val }; save(); return render(); }
  const sl = e.target.closest('[data-smsi]'); if (sl) { const x = ui._smsList[+sl.dataset.smsi]; logManualSms(x.c, x.text, x.v && x.text.includes('i morgen') ? 'varsel:' + x.v.id : undefined); sl.textContent = '✓ Sendt'; sl.classList.remove('pri'); return; }
  const vs_ = e.target.closest('[data-varsel]'); if (vs_) { const v = db.visits.find((x) => x.id === vs_.dataset.varsel); const c = cust(v.customerId); logManualSms(c, vs_.dataset.text, 'varsel:' + v.id); setTimeout(render, 300); return; }
  const rt = e.target.closest('[data-route]'); if (rt) { document.getElementById('dlg').open && document.getElementById('dlg').close(); ui.tab = 'ruter'; ui.routeMode = 'fm'; if (rt.dataset.showmap) ui.hideRouteMap = false; ui.sel = new Set(); ui.route = rt.dataset.route; ui.day = rt.dataset.day || nextRouteDay(route(ui.route)) || todayIso(); return render(); }
  const ch = e.target.closest('.vline[data-visit]'); if (ch) return visitDialog(ch.dataset.visit);
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id; const act = b.dataset.act;
  if (b.tagName === 'A') e.preventDefault();
  try {
    switch (act) {
      case 'back': ui.customer = null; break;
      case 'newCustomer': return customerForm();
      case 'editCustomer': return customerForm(cust(id));
      case 'addAddress': return openDlg(`<h2>Ny adresse</h2><label><span>Adresse</span><input name="street" required></label><label><span>Adgangsforhold</span><input name="access"></label>`, (f) => { db.addresses.push({ id: S.uid('adr'), customerId: id, street: f.street, access: f.access, lat: null, lng: null }); });
      case 'addAgreement': { const adrs = db.addresses.filter((a) => a.customerId === id); return openDlg(`<h2>Ny serviceaftale</h2><label><span>Adresse</span><select name="addressId">${adrs.map((a) => `<option value="${a.id}">${esc(a.street)}</option>`).join('')}</select></label>${agreementFields({})}`, (f) => saveAgreement(null, id, f.addressId, f)); }
      case 'editAgreement': { const a = db.agreements.find((x) => x.id === id); return openDlg(`<h2>Ret aftale</h2><p class="small mute">Ændres interval/startdato/sæson, genplanlægges fremtidige planlagte besøg. Udførte besøg ændres aldrig.</p>${agreementFields(a)}`, (f) => saveAgreement(a, a.customerId, a.addressId, f)); }
      case 'exportCustomer': { download(`kunde-${id}.json`, S.exportCustomer(db, id)); return; }
      case 'deleteCustomer': if (!confirm('Slet kundens persondata? Fakturaer i e-conomic påvirkes ikke.')) return; S.deleteCustomer(db, ui.user, id); ui.customer = null; break;
      case 'sendSms': { const tx = document.getElementById('smsText'); if (!tx.value.trim()) return; b.disabled = true; const m = await S.sendSms(db, ui.user, { customerId: id, text: tx.value.trim(), clientRef: b.dataset.ref || (b.dataset.ref = S.uid('sms')) }, sms); toast(m.status === 'fejlet' ? 'Fejl: ' + m.error : 'Sendt (mock)'); setTimeout(() => S.markDelivered(db, m.providerId, 'leveret') || save(), 1500); break; }
      case 'visit': return visitDialog(id);
      case 'moveFromDlg': document.getElementById('dlg').close(); return moveDialog(id);
      case 'cancelVisit': { const v = db.visits.find((x) => x.id === id); document.getElementById('dlg').close(); return openDlg(`<h2>Aflys besøg ${fmt(v.plannedDate)}</h2><label><span>Årsag</span><input name="note" required></label><label><input type="checkbox" name="notify"> Send SMS til kunden (mock)</label>`, async (f) => { S.registerVisit(db, ui.user, id, { result: 'aflyst', opId: S.uid('op'), note: f.note }); if (f.notify) await S.sendSms(db, ui.user, { customerId: v.customerId, text: `Hej ${cust(v.customerId).name.split(' ')[0]}. Vi må desværre aflyse besøget ${fmt(v.plannedDate)}. Mvh. Sindal Vinduespolering` }, sms); }); }
      case 'wk': ui.weekStart = b.dataset.d === '0' ? mondayOf(todayIso()) : D.addDays(ui.weekStart, +b.dataset.d); break;
      case 'dd': ui.day = D.addDays(ui.day, +b.dataset.d); break;
      case 'notifyWeek': { const vs = db.visits.filter((v) => v.status === 'planlagt' && v.plannedDate >= ui.weekStart && v.plannedDate <= D.addDays(ui.weekStart, 6) && (!ui.calRoute || v.routeId === ui.calRoute));
        return smsListDialog(vs, null, `Varsel til ugens ${vs.length} kunder`, 'Hej {navn}. Vi kommer og pudser dine vinduer {dato}. Svar hvis det ikke passer. Mvh. Sindal Vinduespolering'); }
      case 'up': case 'down': { const st = ui._stops; const i = +b.dataset.i; const j = act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= st.length) return; [st[i], st[j]] = [st[j], st[i]]; setOrder(st.map((v) => v.addressId)); break; }
      case 'applySuggest': setOrder(ui._sug.map((a) => a.id)); toast('Ny fast rækkefølge gemt'); break;
      case 'reg': return regDialog(id, b.dataset.r, b.dataset.cash);
      case 'approve': { const ids = [...$view.querySelectorAll('.qv:checked')].map((x) => x.value); if (!ids.length) return; b.disabled = true; b.textContent = 'Opretter…'; const real = ecoReal(); if (real && !confirm(`Fakturér ${ids.length} besøg i e-conomic? Fakturaerne bogføres${db.settings.economic.sendEmail === false ? '' : ' og sendes til kunderne'} med det samme.`)) { b.disabled = false; return render(); }
        const r = await S.approveAndBook(db, ui.user, ids, ecoApi(), { book: real });
        const n = (st) => r.filter((l) => l.status === st).length; toast(real ? `${n('bogført')} faktura(er) bogført${n('kladde') ? ', ' + n('kladde') + ' kladde(r) mangler bogføring' : ''}${n('fejl') ? ', ' + n('fejl') + ' fejl' : ''}` : `${n('kladde')} kladde(r) oprettet${n('fejl') ? ', ' + n('fejl') + ' fejl' : ''}`); break; }
      case 'retry': { b.disabled = true; const l = await S.retryInvoice(db, ui.user, id, ecoApi()); if (ecoReal() && l.status === 'kladde') await S.bookInvoice(db, ui.user, id, ecoApi()); break; }
      case 'book': b.disabled = true; await S.bookInvoice(db, ui.user, id, ecoApi()); break;
      case 'pay': eco.simulatePayment(db.invoiceLinks.find((l) => l.id === id).invoiceNumber); await S.syncPayments(db, eco); break;
      case 'syncPay': try { await S.syncPayments(db, ecoApi(), ui.user); toast('Betalingsstatus hentet'); } catch (er) { toast('Fejl: ' + er.message); } break;
      case 'fakeInbound': return openDlg(`<h2>Simulér indgående SMS</h2><label><span>Fra nummer</span><select name="from">${db.customers.filter((c) => !c.deleted).map((c) => `<option value="${esc(c.phone)}">${esc(c.name)} (${esc(c.phone)})</option>`).join('')}<option value="+4599887766">Ukendt: +45 99 88 77 66</option></select></label><label><span>Tekst</span><input name="text" value="Det passer fint, tak!" required></label>`, (f) => { S.receiveSms(db, { providerId: S.uid('in'), from: f.from, text: f.text }); });
      case 'comCsv': { const { com, mon } = ui._com; const rows = [['Måned', 'Medarbejder', 'Besøg', 'Grundlag', 'Sats', 'Provision']];
        for (const e of db.employees) { const x = com[e.id]; if (x) rows.push([mon, e.name, x.visits, x.base.toFixed(2).replace('.', ','), String(x.rate * 100).replace('.', ',') + ' %', x.commission.toFixed(2).replace('.', ',')]); }
        const detail = [['Dato', 'Medarbejder', 'Kunde', 'Ydelse', 'Status', 'Pris']]; for (const v of db.visits) { if (!D.isBillable(v) || !v.completion || v.completion.at.slice(0, 7) !== mon) continue; detail.push([v.completion.at.slice(0, 10), emp(v.completion.by)?.name ?? v.completion.by, cust(v.customerId)?.name, v.service, D.RESULTS[v.status], v.price.toFixed(2).replace('.', ',')]); }
        const csv = [...rows, [], ...detail].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = `loengrundlag-${mon}.csv`; a.click(); S.audit(db, ui.user.id, 'commission.export', mon); return; }
      case 'impCancel': ui.imp = null; break;
      case 'gdprUpdate': { const st = ui.imp; if (!confirm(`Opdatér ${st.updates.length} kunder med oplysninger fra GDPR-udtrækket?`)) return;
        const backup = st.updates.map((u) => ({ id: u.customerId, before: Object.fromEntries(Object.keys(u.set).map((k) => [k, db.customers.find((c) => c.id === u.customerId)[k]])) }));
        const n = G.applyGdprUpdates(db, st.updates); let made = 0;
        if (st.includeNew) { const batchId = S.uid('imp'); made = I.applyImportPlan(db, { ...st.plan, customers: st.plan.customers.filter((c) => !c.dupeOf) }, { batchId, uid: S.uid, horizon: D.addDays(todayIso(), 120), today: todayIso() }).customers; }
        S.audit(db, ui.user.id, 'import.gdprUpdate', '-', { updated: n, created: made, backup: backup.length }); (db.gdprBackups ||= []).push({ at: new Date().toISOString(), backup });
        const bt = G.resolveBillTo(db);
        ui.imp = null; toast(`${n} kunder opdateret${made ? `, ${made} oprettet` : ''}${bt.linked ? ` · ${bt.linked} faktureres via en anden konto` : ''}${bt.missing.length ? ` · ${bt.missing.length} betalere ikke fundet` : ''}`); break; }
      case 'sheetApply': { const sp = ui.imp.sheetPlan; const n = sp.items.filter((x) => x.action !== 'skip').length; if (!confirm(`Læg ${n} besøg fra rutesedlerne ind?`)) return;
        const made = RS.applySheetPlan(db, sp, { uid: S.uid }); (db.imports ||= []).push({ batchId: S.uid('imp'), at: new Date().toISOString(), counts: { customers: 0, agreements: 0, visits: made }, kind: 'rutesedler', issues: sp.issues.map((i) => ({ ...i, done: false })) });
        S.audit(db, ui.user.id, 'import.routeSheets', '-', { visits: made }); ui.imp.sheets = []; if (!ui.imp.stams.length && !ui.imp.overviews?.length) ui.imp = null; toast(`${made} besøg lagt ind fra rutesedlerne`); break; }
      case 'stRemove': ui.imp.stams.splice(+b.dataset.i, 1); if (!ui.imp.stams.length && !ui.imp.overviews?.length) ui.imp = null; break;
      case 'ovRemove': ui.imp.overviews.splice(+b.dataset.i, 1); if (!ui.imp.stams.length && !ui.imp.overviews.length) ui.imp = null; break;
      case 'impMakeRoutes': { const pl = ui.imp.plan; let n = 0;
        for (const name of pl.unmatchedRoutes.keys()) { const ags = pl.customers.flatMap((c) => c.addresses[0].agreements).filter((g) => g.routeRaw === name && g.intervalWeeks);
          const iv = ags.length ? Math.min(...ags.map((g) => g.intervalWeeks)) : 4; const anchor = ags.map((g) => g.anchorDate).sort()[0] || D.nextWorkday(todayIso());
          db.routes.push({ id: S.uid('r'), name, employeeId: db.employees[0].id, intervalWeeks: iv, anchorDate: anchor }); n++; }
        S.audit(db, ui.user.id, 'route.createFromImport', '-', { n }); toast(`${n} ruter oprettet – tjek medarbejder og rytme under Admin`); break; }
      case 'impApply': { const st = ui.imp; const n = st.plan.customers.filter((c) => st.includeDup || !c.dupeOf).length; const nu = st.plan.routeUpdates?.length || 0; const nr = st.plan.newRoutes?.length || 0;
        if (!n && !nu && !nr) return toast('Intet at importere'); if (!confirm(`Importér ${n} nye kunder${nu ? `, sæt rute på ${nu} eksisterende kunder` : ''}${nr ? ` og opret ${nr} ruter` : ''}?`)) return;
        const batchId = S.uid('imp'); const rids = st.plan.newRoutes ? SD.materializeRoutes(db, st.plan, { uid: S.uid, today: todayIso(), employeeId: db.employees[0].id, batchId }) : {};
        const c = I.applyImportPlan(db, st.plan, { batchId, uid: S.uid, includeDuplicates: !!st.includeDup, horizon: D.addDays(todayIso(), 120), today: todayIso() });
        const upd = st.plan.routeUpdates ? SD.applyRouteUpdates(db, st.plan, rids, S.uid) : 0;
        if (st.plan.routeOrder) SD.applyRouteOrder(db, st.plan, rids);
        if (st.plan.source === 'skviz') SD.linkBillingFromStamdata(db, st.plan);
        G.resolveBillTo(db);
        if (upd) setTimeout(() => toast(`${c.customers} nye kunder · ${upd} eksisterende aftaler har fået rute · ${Object.keys(rids).length} ruter oprettet`), 50);
        S.audit(db, ui.user.id, 'import.apply', batchId, { file: st.fileName, ...c, routes: Object.keys(rids).length }); ui.imp = null; toast(`${c.customers} kunder, ${c.agreements} aftaler, ${c.visits} besøg importeret`); break; }
      case 'impUndo': if (!confirm('Fortryd importen? Alle kunder fra den slettes.')) return; I.rollbackImport(db, id); S.audit(db, ui.user.id, 'import.rollback', id); toast('Import fortrudt'); break;
      case 'rnext': { const r = route(ui.route); const dir = +b.dataset.d; const ds = routeDays(r);
        let d = dir > 0 ? ds.find((x) => x > ui.day) : ds.filter((x) => x < ui.day).pop();
        if (!d) { d = D.addDays(ui.day, dir); for (let i = 0; i < 400 && !D.routeRuns(r, d); i++) d = D.addDays(d, dir); }
        ui.day = d; ui._routeDayFor = r.id + d; break; }
      case 'rmode': ui.routeMode = b.dataset.m; break;
      case 'extraAdd': return openDlg(`<h2>Ekstra opgave – ${esc(cust(db.visits.find((v) => v.id === id).customerId).name)}</h2>
          <label><span>Opgave</span><input name="text" required placeholder="Fx kælderruder, ovenlys, tagrende …"></label><label><span>Pris ekskl. moms</span><input name="price" type="number" min="0" step="1" required></label><p class="small mute">Kommer med på fakturaen, når besøget færdigmeldes.</p>`,
        (f) => { const d = vdraft()[id] || {}; vdraft()[id] = { ...d, extras: [...(d.extras || []), { text: f.text.trim(), price: Number(f.price) || 0 }] }; });
      case 'extraDel': { const d = vdraft()[id]; d.extras.splice(+b.dataset.i, 1); break; }
      case 'photo': { const a = addr(b.dataset.a); const ph = a?.photos?.find((x) => x.id === b.dataset.src); if (!ph) return;
        return openDlg(`<img src="${ph.src}" style="width:100%;border-radius:10px" alt="">${ph.caption ? `<p>${esc(ph.caption)}</p>` : ''}`, null, 'Luk'); }
      case 'photoDel': { const a = addr(b.dataset.a); if (!confirm('Slet billedet?')) return; a.photos = a.photos.filter((x) => x.id !== b.dataset.p); break; }
      case 'ferie': document.getElementById('dlg').close(); return ferieDialog(b.dataset.d);
      case 'feDay': { const fe = ui._fe; const d = b.dataset.d; if (fe.step === 1 && d !== fe.a) { if (d < fe.a) { fe.b = fe.a; fe.a = d; } else fe.b = d; fe.step = 0; } else { fe.a = fe.b = d; fe.step = 1; } return drawFerie(); }
      case 'feMonth': { const [y, m] = ui._fe.month.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + +b.dataset.v, 1)); ui._fe.month = dt.toISOString().slice(0, 7); return drawFerie(); }
      case 'ferieDel': { const d = b.dataset.d; const lbl = db.closedInfo?.[d]?.label; let a = d, z = d;
        if (lbl) { while (db.closedInfo[D.addDays(a, -1)]?.label === lbl || (D.isClosedDay(D.addDays(a, -1)) && db.closedInfo[D.addDays(a, -3)]?.label === lbl && D.weekday(D.addDays(a, -1)) >= 5)) a = D.addDays(a, -1);
          while (db.closedInfo[D.addDays(z, 1)]?.label === lbl || (D.weekday(D.addDays(z, 1)) >= 5 && db.closedInfo[D.addDays(z, 3)]?.label === lbl)) z = D.addDays(z, 1); }
        if (!confirm(`Fjern ${lbl ? lbl.toLowerCase() + ' ' : ''}${fmt(a)}${a !== z ? '–' + fmt(z) : ''}? Flyttede besøg flyttes ikke tilbage.`)) return;
        for (let x = a; x <= z; x = D.addDays(x, 1)) { db.closedDays = db.closedDays.filter((y) => y !== x); if (db.closedInfo) delete db.closedInfo[x]; }
        document.getElementById('dlg').close(); S.audit(db, ui.user.id, 'calendar.open', `${a}..${z}`); break; }
      case 'moveSelVisits': { const vs2 = [...ui.visSel].map((x) => db.visits.find((v) => v.id === x)).filter(Boolean); ui.visSel = new Set(); return bulkDialog(vs2, `Flyt ${vs2.length} kunder`); }
      case 'clearVisSel': ui.visSel = new Set(); break;
      case 'rmPart': { const { rid, day } = ui._rm; const vs2 = routeStops(rid, day).filter((v) => v.status === 'planlagt' || v.status === 'udsat');
        return openDlg(`<h2>Flyt nogle kunder fra ${esc(route(rid).name)} ${fmt(day)}</h2><p class="small mute">Kun denne gang: kundernes plads i ruten og rytmen fremover ændres ikke.</p>
          ${vs2.map((v) => `<label class="chk"><input type="checkbox" name="v_${v.id}"> ${esc(cust(v.customerId).name)} <span class="small mute">${esc(addr(v.addressId)?.street)}</span></label>`).join('')}
          <label><span>Ny dato</span><input type="date" name="date" required value="${D.nextWorkday(D.addDays(day, 1), db.closedDays)}"></label>`,
          (f) => { const pick = vs2.filter((v) => f['v_' + v.id]); if (!pick.length) return 'Vælg mindst én kunde'; for (const v of pick) S.moveVisit(db, ui.user, v.id, f.date, 'keep'); toast(`${pick.length} kunder flyttet til ${fmt(f.date)} (kun denne gang)`); }); }
      case 'gForgot': { const em = document.querySelector('#gform input[name=email]')?.value.trim(); if (!em) return toast('Skriv din e-mail først'); await cloud.resetPassword(em); toast('Vi har sendt et link til ' + em); return; }
      case 'gBack': gate = 'login'; break;
      case 'gLogout': case 'logout': return logout();
      case 'gUpload': gate = null; db.settings.realData = true; ui.user = users()[0]; render(); toast('Uploader …'); return doSync(true).then(() => toast(syncInfo.error ? 'Fejl: ' + syncInfo.error : 'Data uploadet til den fælles database'));
      case 'gEmpty': setDb(freshDb()); gate = null; ui.user = users()[0]; render(); return doSync(true);
      case 'syncNow': return doSync(true).then(() => toast(syncInfo.error ? 'Fejl: ' + syncInfo.error : 'Synkroniseret'));
      case 'ivCreate': { const code = await cloud.createInvite(member.orgId, document.getElementById('ivRole').value, document.getElementById('ivEmp').value, null); S.audit(db, ui.user.id, 'user.invite', document.getElementById('ivEmp').value);
        openDlg(`<h2>Invitationskode</h2><p style="font-size:30px;font-weight:700;letter-spacing:3px" class="code">${esc(code)}</p><p class="small">Giv koden til medarbejderen. De åbner <b>${esc(location.origin + location.pathname)}</b>, opretter en bruger og indtaster koden.</p>`, null, 'Luk'); return cloudCard(); }
      case 'ecoRetry': ui._ecoOpts = null; return ecoCard();
      case 'ivDel': await cloud.deleteInvite(id); return cloudCard();
      case 'cmRemove': if (!confirm('Fjern brugerens adgang til firmaets data?')) return; await cloud.removeMember(member.orgId, id); S.audit(db, ui.user.id, 'user.remove', id); return cloudCard();
      case 'cfSave': { const url = document.getElementById('cfUrl').value.trim(), key2 = document.getElementById('cfKey').value.trim(); if (!/^https:\/\/.+/.test(url) || !key2) return toast('Udfyld URL og nøgle');
        if (/service_role/.test((() => { try { return atob((key2.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } })()) || /^sb_secret_/.test(key2)) return toast('Det er den hemmelige nøgle – brug den offentlige anon/publishable-nøgle');
        localStorage.setItem('vindue-cloudconf', JSON.stringify({ url, anonKey: key2 })); return bootCloud(); }
      case 'chPw': return changePassword();
      case 'mfaStart': try { ui._mfaNew = await cloud.mfaEnroll('Telefon'); } catch (er) { const g = document.getElementById('gerr'); if (g) g.textContent = danishAuthError(er.message); return; } return render();
      case 'mfaAdd': return addMfaDevice();
      case 'mfaDel': { const mf = await cloud.mfaStatus(); if (mf.factors.length < 2 && member.role === 'admin') return toast('Tilføj en anden enhed først – admin skal have mindst én');
        if (!confirm('Fjern denne enhed fra to-trinslogin?')) return; await cloud.mfaUnenroll(id); toast('Enhed fjernet'); return render(); }
      case 'cfMemory': localStorage.setItem('vindue-cloudconf', JSON.stringify({ url: 'memory', anonKey: '' })); return bootCloud();
      case 'routeMenu': return routeMenu(b.dataset.r, b.dataset.d);
      case 'rmMove': { const { rid, day } = ui._rm; document.getElementById('dlg').close(); return bulkDialog(db.visits.filter((v) => v.routeId === rid && v.plannedDate === day), `Flyt ${route(rid).name} ${fmt(day)}`); }
      case 'rmSms': { const { rid, day } = ui._rm; document.getElementById('dlg').close(); return smsListDialog(db.visits.filter((v) => v.routeId === rid && v.plannedDate === day && v.status === 'planlagt'), null, `SMS til ${route(rid).name} ${fmt(day)}`, 'Hej {navn}. Vi kommer og pudser dine vinduer {dato}. Svar på denne SMS hvis det ikke passer. Mvh. Sindal Vinduespolering'); }
      case 'rmSelect': { const k = ui._rm.rid + '|' + ui._rm.day; ui.calSel ||= new Set(); ui.calSel.has(k) ? ui.calSel.delete(k) : ui.calSel.add(k); document.getElementById('dlg').open && document.getElementById('dlg').close(); break; }
      case 'selWeek': { ui.calSel ||= new Set(); const ws = ui.weekStart; for (const v of db.visits) if (v.routeId && v.plannedDate >= ws && v.plannedDate <= D.addDays(ws, 6) && (!ui.calRoute || v.routeId === ui.calRoute)) ui.calSel.add(v.routeId + '|' + v.plannedDate); break; }
      case 'clearSel': ui.calSel = new Set(); break;
      case 'printSel': ui.printSet = [...ui.calSel]; ui.tab = 'print'; render(); setTimeout(() => window.print(), 300); return;
      case 'dayOpts': return dayOptions(b.dataset.d);
      case 'dayPlan': document.getElementById('dlg').open && document.getElementById('dlg').close(); ui.tab = 'dag'; ui.planDay = b.dataset.d; ui._planMode = db.dayPlans?.[b.dataset.d]?.mode || 'ruter'; break;
      case 'planBack': ui.tab = 'kalender'; break;
      case 'planClear': delete db.dayPlans[ui.planDay]; toast('Dagen følger igen de faste ruter'); break;
      case 'ordOpt': { const { r, rest, startPt, endOpt, fixedFirst, A, so } = ui._ordCtx; if (!rest.length) return;
        b.disabled = true; b.textContent = 'Optimerer …';
        const pre = DP.localOptimal(rest.map((id) => ({ id, addressId: id })), (v) => A(v.id), endOpt === undefined ? startPt : null);
        const k = gKey('opt:' + r.id + '|' + JSON.stringify(so) + '|' + ui._ordEnd, pre, true);
        googleFor(k, pre, { start: startPt, end: endOpt, optimize: true, pointOf: A, onDone: (res) => {
          ui._ord = [...(fixedFirst ? [fixedFirst] : []), ...res.order];
          (ui._google ||= {})[gKey('ord:' + r.id + '|' + JSON.stringify(so) + '|' + ui._ordEnd, res.order)] = res; toast('Optimeret – træk evt. kunder på plads, og tryk Gem'); } });
        return; }
      case 'ordReset': ui._ordFor = null; break;
      case 'ordSave': { const { r, so } = ui._ordCtx; r.order = [...ui._ord, ...(r.order || []).filter((a) => !ui._ord.includes(a))]; r.optStart = so; r.optEnd = ui._ordEnd;
        S.audit(db, ui.user.id, 'route.order', r.id, { n: ui._ord.length, start: so.type }); toast('Rutens faste rækkefølge er gemt'); break; }
      case 'rdFix': { const r = route(ui.route); const ids = routeStops(r.id, ui.day).map((v) => v.addressId); setOrder(ids); toast('Rutens faste rækkefølge opdateret'); break; }
      case 'rdReset': { const r = route(ui.route); setRouteDayOrder(ui.day, fixedRouteOrder(r, routeStops(r.id, ui.day)).map((v) => v.id)); toast('Dagen følger rutens faste rækkefølge'); break; }
      case 'calWeek': ui.calDay = null; ui.calPick = null; break;
      case 'toggleRouteMap': ui.hideRouteMap = !ui.hideRouteMap; break;
      case 'planGoogle': { const day = ui.planDay; const k = gKey(day + 'cur', ui._planOrder); if (ui._google) delete ui._google[k]; googleFor(k, [...ui._planOrder], { start: startPoint(), optimize: false }); break; }
      case 'planOpt': { const day = ui.planDay; const vs = db.visits.filter((v) => v.plannedDate === day && v.status !== 'aflyst' && v.status !== 'forgaeves'); const st = startPoint();
        const pre = DP.localOptimal(vs, (v) => addr(v.addressId) || {}, st); b.disabled = true; b.textContent = 'Optimerer …';
        googleFor(gKey(day + 'opt', pre, true), pre, { start: st, optimize: true, onDone: (res) => { (ui._google ||= {})[gKey(day + 'cur', res.order)] = res; setDayOrder(day, res.order, { legs: res.legs, polylines: res.polylines, legsFor: res.order.join(',') }); toast('Dagen er optimeret – træk evt. kunder på plads'); } }); return; }
      case 'printRoute': document.getElementById('dlg').open && document.getElementById('dlg').close(); ui.tab = 'ruter'; ui.route = b.dataset.r; ui.day = b.dataset.d; ui._routeDayFor = ui.route + ui.day; ui.routeMode = 'sheet'; render(); setTimeout(() => window.print(), 300); return;
      case 'smsTomorrow': { const nd = D.nextWorkday(D.addDays(todayIso(), 1), db.closedDays);
        const mine = db.visits.filter((v) => v.plannedDate === nd && v.status === 'planlagt' && (isAdmin() || route(v.routeId)?.employeeId === ui.user.employeeId));
        return smsListDialog(mine, null, `SMS til ruten ${fmt(nd)} (${mine.length})`, db.templates.varsel); }
      case 'kview': ui.kView = b.dataset.v; ui.customer = null; break;
      case 'fmSet': for (const v of ui._stops) if (ui.sel.has(v.id) && (v.status === 'planlagt' || v.status === 'udsat')) vdraft()[v.id] = { ...(vdraft()[v.id] || {}), result: b.dataset.r }; break;
      case 'fmSplit': return splitDialog(ui._stops.filter((v) => ui.sel.has(v.id) && v.status === 'planlagt'));
      case 'fmSplitOne': { const v = ui._stops.find((x) => x.id === id); if (v.status !== 'planlagt') return; return splitDialog([v]); }
      case 'fmSave': S.audit(db, ui.user.id, 'route.draft', ui._draftKey); toast('Gemt til senere – intet er færdigmeldt endnu'); break;
      case 'fmCommit': {
        const plan = ui._stops.filter((v) => v.status === 'planlagt' || v.status === 'udsat').map((v) => ({ v, d: vdraft()[v.id] || {} })).filter(({ d }) => d.result && d.result !== 'aaben');
        if (!plan.length) return toast('Vælg Udført, Betalt eller Udsæt for mindst én kunde');
        const bad = plan.find(({ d }) => d.result === 'spring' && (d.skip === 'move' || d.skip === 'shift') && !d.moveDate); if (bad) return toast(`Vælg ny dato for ${cust(bad.v.customerId).name}`);
        if (!confirm(`Færdigmeld ${plan.length} kunder? Udførte går i faktureringskøen.`)) return;
        const r = applyDecisions(plan); ui.sel = new Set();
        toast(`${r.done} færdigmeldt${r.moved ? `, ${r.moved} flyttet` : ''}${r.conflicts.length ? ', ' + r.conflicts.length + ' konflikter' : ''}`); break; }
      case 'dayMenu': document.getElementById('dlg').open && document.getElementById('dlg').close(); return bulkDialog(db.visits.filter((v) => v.plannedDate === b.dataset.d && (!ui.calRoute || v.routeId === ui.calRoute)), `Hele ${fmt(b.dataset.d)}`);
      case 'bulk': return bulkDialog(ui._stops.filter((v) => ui.sel.has(v.id)), `${route(ui.route).name} ${fmt(ui.day)}`);
      case 'selAll': { const all = ui._stops.every((v) => ui.sel.has(v.id)); ui._stops.forEach((v) => (all ? ui.sel.delete(v.id) : ui.sel.add(v.id))); break; }
      case 'bulkSms': return smsListDialog(ui._stops.filter((v) => ui.sel.has(v.id)), null, 'SMS til valgte', db.templates.varsel);
      case 'varselSent': return;
      case 'recalcRoutes': { let n = 0; const t = todayIso();
        for (const r of db.routes) { const ags = db.agreements.filter((g) => g.routeId === r.id && g.active && g.intervalWeeks); if (!ags.length) continue;
          const iv = Math.min(...ags.map((g) => g.intervalWeeks));
          // næste rigtige besøgsdato blandt rutens kunder (fra planlagte besøg, ellers aftalens dato)
          const next = db.visits.filter((v) => v.routeId === r.id && v.status === 'planlagt' && v.plannedDate >= t).map((v) => v.rhythmDate).sort()[0] || ags.map((g) => g.anchorDate).sort()[0];
          if (next && (r.intervalWeeks !== iv || !D.routeRuns({ ...r, intervalWeeks: iv }, next) || r.anchorUnknown)) { r.intervalWeeks = iv; r.anchorDate = next; delete r.anchorUnknown; n++; } }
        S.audit(db, ui.user.id, 'route.recalc', '-', { n }); toast(n ? `${n} ruter fik ny rytme/dato – tjek dem mod SkvizBiz` : 'Ruterne passer allerede med kunderne'); break; }
      case 'delEmptyRoutes': { const empty = db.routes.filter((r) => !db.agreements.some((g) => g.routeId === r.id) && !db.visits.some((v) => v.routeId === r.id)); if (!empty.length) return toast('Ingen tomme ruter');
        if (!confirm(`Slet ${empty.length} ruter uden kunder?`)) return; db.routes = db.routes.filter((r) => !empty.includes(r)); S.audit(db, ui.user.id, 'route.deleteEmpty', '-', { n: empty.length }); toast(`${empty.length} ruter slettet`); break; }
      case 'showDbl': return dblDialog();
      case 'showCheck': return checkDialog();
      case 'dblCancel': { const v = db.visits.find((x) => x.id === id); if (!confirm(`Aflys ${v.service} ${fmt(v.plannedDate)}?`)) return; S.registerVisit(db, ui.user, id, { result: 'aflyst', opId: 'dbl:' + id, note: 'Dobbeltbooking' }); save(); document.getElementById('dlg').close(); render(); return dblDialog(); }
      case 'showIssues': return issuesDialog(id);
      case 'issueDone': { const [bid, k] = b.dataset.k.split(':'); const it = db.imports.find((x) => x.batchId === bid).issues[+k]; it.done = !it.done; save(); b.textContent = it.done ? '✓ Løst' : 'Markér løst'; b.closest('tr').style.opacity = it.done ? .45 : 1; return; }
      case 'empAdd': db.employees.push({ id: S.uid('e'), name: 'Ny medarbejder', role: 'medarbejder', commissionRate: db.settings.commissionRate }); break;
      case 'empDel': { const e = emp(id); if (e.role === 'admin' && db.employees.filter((x) => !x.inactive && x.role === 'admin').length === 1) return toast('Der skal være mindst én admin');
        const rs = db.routes.filter((r) => r.employeeId === id); if (!confirm(`Fjern ${e.name}?${rs.length ? ` ${rs.length} ruter flyttes til dig.` : ''} Historik og provision bevares.`)) return;
        rs.forEach((r) => (r.employeeId = ui.user.employeeId)); e.inactive = true; S.audit(db, ui.user.id, 'employee.remove', id); break; }
      case 'addRoute': db.routes.push({ id: S.uid('r'), name: `Ny rute ${db.routes.length + 1}`, employeeId: db.employees[0].id, intervalWeeks: 4, anchorDate: D.nextWorkday(todayIso()) }); break;
      case 'bookVisit': { const a = db.agreements.find((x) => x.id === id); return openDlg(`<h2>Book besøg – ${esc(cust(a.customerId).name)}</h2><p class="small">${esc(a.service)} · ${esc(addr(a.addressId)?.street)}</p><label><span>Dato</span><input type="date" name="date" required value="${D.nextWorkday(D.addDays(todayIso(), 1), db.closedDays)}"></label><label><span>Rute (valgfri)</span><select name="routeId"><option value="">Ingen</option>${db.routes.map((r) => `<option value="${r.id}" ${r.id === a.routeId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`, (f) => { const v = D.manualVisit(a, f.date, db.visits); v.routeId = f.routeId || null; db.visits.push(v); S.audit(db, ui.user.id, 'visit.book', v.id); toast('Besøg booket'); }); }
      case 'print': window.print(); return;
      case 'routesAll': ui.route = null; ui.sel = new Set(); ui.tab = 'kunder'; ui.kView = 'ruter'; break;
      case 'backup': download(`sindal-vinduespolering-backup-${todayIso()}.json`, db); S.audit(db, ui.user.id, 'backup.export', '-'); break;
      case 'planMore': toast(`${S.planAhead(db, D.addDays(todayIso(), 183))} nye besøg planlagt`); break;
      case 'wipe': if (!confirm('Slet ALT i appen (testkunder, ruter, besøg) og start helt tomt? Tag evt. en backup først.')) return; db = freshDb(); save().then(() => location.reload()); return;
      case 'reset': if (!confirm('Slet alle data og indlæs testdata igen?')) return; localStorage.removeItem(KEY + '-ui'); KV.del(dbKey).then(() => location.reload()); return;
      case 'addClosed': { const d = document.getElementById('cd').value; if (d && !db.closedDays.includes(d)) { db.closedDays.push(d); db.closedDays.sort(); db.visits.forEach((v) => { if (v.status === 'planlagt' && v.plannedDate === d) v.plannedDate = D.nextWorkday(d, db.closedDays); }); } break; }
      case 'rmClosed': db.closedDays = db.closedDays.filter((x) => x !== b.dataset.d); break;
      case 'showOverdue': ui.tab = 'mobil'; ui._mobDayFor = null; ui.day = db.visits.filter((v) => (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate < todayIso()).map((v) => v.plannedDate).sort()[0]; break;
    }
  } catch (err) { toast(err.message); }
  render();
});
function setOrder(addressIds) { const r = route(ui.route); r.order = [...addressIds, ...(r.order || []).filter((a) => !addressIds.includes(a))]; S.audit(db, ui.user.id, 'route.order', r.id); }
function download(name, obj) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

/* ---------------- Login og synkronisering ---------------- */
function renderNet() {
  const net = document.getElementById('net'); if (!net) return;
  const pend = syncer ? syncer.pending(db).length : 0;
  const [txt, cls] = !cloud ? [ui.offline ? 'Offline' : 'Kun lokalt', ui.offline ? 'bad' : ''] :
    syncInfo.status === 'syncing' ? ['Synkroniserer …', ''] : syncInfo.status === 'error' ? ['Synk-fejl', 'bad'] : !navigator.onLine ? [`Offline${pend ? ' · ' + pend + ' venter' : ''}`, 'warn'] :
    syncInfo.at ? [`✓ Synk ${new Date(syncInfo.at).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}${pend ? ' · ' + pend + ' venter' : ''}`, 'ok'] : ['Forbundet', 'ok'];
  net.textContent = txt; net.className = 'pill ' + cls; net.title = syncInfo.error || ''; net.style.cursor = cloud ? 'pointer' : ''; net.onclick = cloud ? () => doSync(true) : null;
}
function renderGate() {
  document.getElementById('tabs').hidden = true; renderUserSelect();
  const box = (inner) => `<div class="gate card">${inner}</div>`;
  const conf = cloudConf();
  if (gate === 'loading') { $view.innerHTML = box('<p class="mute">Forbinder …</p>'); return; }
  if (gate === 'login') $view.innerHTML = box(`<h2>Log ind</h2><p class="small mute">Sindal Vinduespolering${conf?.url === 'memory' ? ' · <b>testdatabase i browseren</b>' : ''}</p>
    <form id="gform"><label><span>E-mail</span><input name="email" type="email" autocomplete="username" required value="${esc(ui._gEmail || '')}"></label><label><span>Kodeord</span><input name="pw" type="password" autocomplete="current-password" required minlength="8"></label>
    <div class="row"><button class="pri" value="in">Log ind</button><button value="up">Opret ny bruger</button><span class="sp"></span><button type="button" class="link" data-act="gForgot">Glemt kodeord?</button></div><p class="small" id="gerr" style="color:var(--bad)"></p></form>
    <p class="small mute">Ny medarbejder? Opret en bruger med din egen e-mail, og indtast derefter den invitationskode, du har fået.</p>`);
  if (gate === 'mfa') { const fs = ui._mfa?.factors || [];
    $view.innerHTML = box(`<h2>To-trinslogin</h2><p>Åbn din godkendelses-app, og skriv den 6-cifrede kode for <b>Sindal Vinduespolering</b>.</p>
    <form id="gform">${fs.length > 1 ? `<label><span>Enhed</span><select name="factor">${fs.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label>` : `<input type="hidden" name="factor" value="${esc(fs[0]?.id || '')}">`}
    <label><span>Kode</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus style="font-size:1.4em;letter-spacing:4px;max-width:180px"></label>
    <div class="row"><button class="pri" value="mfa">Bekræft</button><span class="sp"></span><button type="button" class="link" data-act="gLogout">Log ud</button></div><p class="small" id="gerr" style="color:var(--bad)"></p></form>
    <p class="small mute">Mistet telefonen? Se "Mistet enhed" i vindue/supabase/OPSÆTNING.md.</p>`); }
  if (gate === 'mfaEnroll') { const n = ui._mfaNew;
    $view.innerHTML = box(`<h2>Slå to-trinslogin til</h2><p>Som admin kan du se og ændre alle kunder, så kontoen skal beskyttes med en kode fra telefonen ud over kodeordet.</p>
    <ol class="small"><li>Installér en godkendelses-app på telefonen, fx <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> eller din kodeordsmanager (1Password, Bitwarden …).</li>
    <li>Tryk <b>Vis QR-kode</b>, og scan den med appen.</li><li>Skriv den 6-cifrede kode, appen viser.</li></ol>
    ${n ? `${n.qr ? `<p style="text-align:center"><img src="${n.qr}" alt="QR-kode" style="width:200px;height:200px;background:#fff;padding:8px;border-radius:8px"></p>` : ''}
      <p class="small">Kan du ikke scanne? Indtast nøglen manuelt: <b class="code" style="word-break:break-all">${esc(n.secret)}</b></p>
      <form id="gform"><input type="hidden" name="factor" value="${esc(n.id)}"><label><span>Kode fra appen</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus style="font-size:1.4em;letter-spacing:4px;max-width:180px"></label>
      <div class="row"><button class="pri" value="mfaNew">Aktivér</button><span class="sp"></span><button type="button" class="link" data-act="gLogout">Log ud</button></div><p class="small" id="gerr" style="color:var(--bad)"></p></form>`
    : `<div class="row"><button class="pri" data-act="mfaStart">Vis QR-kode</button><span class="sp"></span><button class="link" data-act="gLogout">Log ud</button></div><p class="small" id="gerr" style="color:var(--bad)"></p>`}
    <p class="small mute">Tip: Tilføj senere en ekstra enhed under Admin → Brugere og adgang, så du ikke er låst ude, hvis telefonen bliver væk.</p>`); }
  if (gate === 'confirm') $view.innerHTML = box(`<h2>Tjek din e-mail</h2><p>Vi har sendt et link til <b>${esc(ui._gEmail)}</b>. Klik på det for at bekræfte, og log så ind her.</p><button data-act="gBack">Til login</button>`);
  if (gate === 'recovery') $view.innerHTML = box(`<h2>Nyt kodeord</h2><form id="gform"><label><span>Nyt kodeord (mindst 8 tegn)</span><input name="pw" type="password" autocomplete="new-password" required minlength="8"></label><button class="pri" value="newpw">Gem</button><p class="small" id="gerr" style="color:var(--bad)"></p></form>`);
  if (gate === 'onboard') $view.innerHTML = box(`<h2>Velkommen</h2><p>Du er logget ind som <b>${esc(ui._gEmail)}</b>, men er ikke tilknyttet et firma endnu.</p>
    <form id="gform"><h3>Har du en invitationskode?</h3><div class="row"><input name="code" placeholder="Fx K7M2Q9XA" style="text-transform:uppercase;max-width:180px"><button value="code">Brug kode</button></div>
    <h3 style="margin-top:20px">Eller opret firmaet (kun ejeren)</h3><div class="row"><input name="org" value="Sindal Vinduespolering"><button class="pri" value="org">Opret firma</button></div><p class="small" id="gerr" style="color:var(--bad)"></p></form>
    <p><button data-act="gLogout" class="link">Log ud</button></p>`);
  if (gate === 'firstdata') { const n = db.customers.filter((c) => !c.deleted).length;
    $view.innerHTML = box(`<h2>Firmaet er oprettet ✓</h2><p>Hvad skal der ligge i den fælles database?</p><div class="menu">
      ${db.settings.realData && n ? `<button class="pri" data-act="gUpload">⬆ Upload de data, der ligger på denne computer (${n} kunder)</button>` : ''}
      <button data-act="gEmpty">Start tomt – jeg importerer bagefter</button>${!db.settings.realData ? `<button data-act="gUpload">Upload testdata (til at prøve af)</button>` : ''}</div>`); }
  const f = document.getElementById('gform');
  if (f) f.onsubmit = async (e) => { e.preventDefault(); const v = e.submitter?.value; const fd = Object.fromEntries(new FormData(f)); const out = document.getElementById('gerr'); out.textContent = '';
    try {
      if (v === 'in') { ui._gEmail = fd.email.trim(); await cloud.signIn(ui._gEmail, fd.pw); await afterLogin(); }
      else if (v === 'up') { ui._gEmail = fd.email.trim(); if ((fd.pw || '').length < 8) throw new Error('Kodeord skal være mindst 8 tegn'); const r = await cloud.signUp(ui._gEmail, fd.pw); if (r.needsConfirm) { gate = 'confirm'; render(); } else await afterLogin(); }
      else if (v === 'mfa' || v === 'mfaNew') { await cloud.mfaVerify(fd.factor, fd.code); if (v === 'mfaNew') toast('To-trinslogin er slået til ✓'); await afterLogin(); }
      else if (v === 'newpw') { await cloud.updatePassword(fd.pw); toast('Kodeord gemt'); await afterLogin(); }
      else if (v === 'code') { if (!fd.code.trim()) throw new Error('Indtast koden'); await cloud.acceptInvite(fd.code); await afterLogin(true); }
      else if (v === 'org') { await cloud.createOrg(fd.org); member = null; await afterLogin(false, true); }
    } catch (err2) { out.textContent = danishAuthError(err2.message); } };
}
const danishAuthError = (m) => (/Invalid login credentials/i.test(m) ? 'Forkert e-mail eller kodeord' : /Invalid TOTP|invalid.*code/i.test(m) ? 'Forkert kode – prøv igen (koden skifter hvert 30. sekund)' : /friendly name.*exists/i.test(m) ? 'Der findes allerede en enhed med det navn' : /AAL2 required|aal2/i.test(m) ? 'Kræver to-trinslogin – log ud og ind igen' : /different from the old/i.test(m) ? 'Det nye kodeord skal være forskelligt fra det gamle' : /Password should be/i.test(m) ? 'Kodeordet er for svagt – brug mindst 8 tegn' : /reauthenticat/i.test(m) ? 'Supabase kræver ny bekræftelse – log ud og ind, og prøv igen' : /Email not confirmed/i.test(m) ? 'E-mailen er ikke bekræftet endnu – tjek din indbakke' : /already registered|already exists/i.test(m) ? 'Der findes allerede en bruger med den e-mail – log ind i stedet' : /rate limit/i.test(m) ? 'For mange forsøg – vent lidt og prøv igen' : m);

async function bootCloud() {
  const conf = cloudConf(); if (!conf) return;
  gate = 'loading'; render();
  try { cloud = conf.url === 'memory' ? new MemoryCloud() : await SupabaseCloud.create(conf); }
  catch (e) { gate = null; cloud = null; toast('Kunne ikke forbinde til databasen: ' + e.message); render(); return; }
  cloud.onAuth((ev) => { if (ev === 'PASSWORD_RECOVERY') { gate = 'recovery'; render(); } if (ev === 'SIGNED_OUT' && member) signedOut(); });
  if (/type=recovery/.test(location.hash)) { gate = 'recovery'; render(); return; }
  await afterLogin();
}
/** Efter login: find firma/rolle, start synkronisering. */
async function afterLogin(joined = false, created = false) {
  const sess = await cloud.session(); if (!sess) { gate = 'login'; return render(); }
  ui._gEmail = sess.user.email;
  // To-trinslogin: har brugeren en godkendt enhed, skal koden indtastes før data kan læses (håndhæves også i databasen)
  let mf = null;
  if (cloud.mfaStatus) { mf = await cloud.mfaStatus(); if (mf.next === 'aal2' && mf.current !== 'aal2') { ui._mfa = mf; gate = 'mfa'; return render(); } }
  const m = await cloud.membership(); if (!m) { gate = 'onboard'; return render(); }
  // admin skal have to-trinslogin
  if (created) ui._created = true; else if (ui._created) { created = true; }
  if (m.role === 'admin' && mf && !mf.factors.length) { ui._mfaNew = null; gate = 'mfaEnroll'; return render(); }
  ui._created = false;
  member = { ...m, userId: sess.user.id };
  const sk = `vindue-sync-${m.orgId}-${sess.user.id}`; let st; try { st = await KV.get(sk); } catch {}
  // Lokale data hører til den indloggede bruger (en medarbejder har kun en del af firmaets data)
  const uk = `${KEY}:${sess.user.id}`; const own = await KV.get(uk);
  if (own?.customers) { setDb(own); dbKey = uk; }
  // ny bruger på enheden; har brugeren synket før uden egne lokale data (ældre version), overtages enhedens data
  const first = !own && !st?.lastPull && !st?.hashes;
  st ||= { orgId: m.orgId }; st.orgId = m.orgId;
  syncer = new SY.SyncEngine({ backend: cloud.backend, state: st, role: m.role }); syncer._key = sk;
  if (created) { dbKey = uk; await persist(); KV.del(KEY); gate = 'firstdata'; return render(); }
  if (first) {
    // ny enhed/bruger: data på enheden erstattes af firmaets data
    const n = db.customers.filter((c) => !c.deleted).length;
    if (db.settings.realData && n && m.role === 'admin' && !joined && !confirm(`Data på denne enhed (${n} kunder) erstattes af firmaets fælles data. Fortsæt? (Tryk Annuller og tag en backup under Admin, hvis du er i tvivl.)`)) { await cloud.signOut(); return; }
    setDb(freshDb()); db.settings.realData = true;
  }
  if (dbKey !== uk) { dbKey = uk; await persist(); if (!own) KV.del(KEY); }
  gate = null; ui.user = users()[0]; ui.tab = member.role === 'admin' ? (ui.tab || 'kalender') : 'mobil'; ui._mobDayFor = null;
  render(); await doSync(true);
}
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => doSync(), 2500); }
async function doSync(force) {
  if (!syncer || gate || syncInfo.status === 'syncing') return;
  if (!navigator.onLine && !force) return renderNet();
  syncInfo.status = 'syncing'; renderNet();
  try { stampAudit(); const r = await syncer.sync(db); syncInfo.status = 'ok'; syncInfo.at = Date.now(); syncInfo.error = null;
    await persist(); await KV.set(syncer._key, syncer.s);
    if (r.pulled) { S.planAhead(db, D.addDays(todayIso(), 120)); softRender(); } else renderNet();
    autoEconomic();
  } catch (e) { syncInfo.status = 'error'; syncInfo.error = e.message; renderNet(); if (force) toast('Synkronisering fejlede: ' + e.message); }
}
/** Automatik (kun admin, kun når e-conomic er slået til): fakturér færdigmeldte besøg og hent betalingsstatus. */
let autoBusy = false;
async function autoEconomic() {
  if (autoBusy || !ecoReal() || gate || !navigator.onLine) return; autoBusy = true;
  try {
    if (!db.settings.economic.autoFrom) { db.settings.economic.autoFrom = new Date().toISOString(); await save(); } // allerede slået til før denne version
    const api = ecoApi(); const r = await S.autoInvoice(db, ui.user, api, { from: db.settings.economic.autoFrom });
    const last = +(localStorage.getItem('vindue-paysync') || 0);
    if (Date.now() - last > 3 * 3600e3 && db.invoiceLinks.some((l) => l.status === 'bogført' && l.payment !== 'betalt')) { await S.syncPayments(db, api, ui.user); localStorage.setItem('vindue-paysync', String(Date.now())); r.push(1); }
    if (r.length) { await save(); softRender(); }
  } catch (e) { console.warn('Automatisk fakturering', e); }
  finally { autoBusy = false; }
}
setInterval(() => { if (document.visibilityState === 'visible') autoEconomic(); }, 60000);
/** Tegn kun forfra, når brugeren ikke er i gang med at skrive eller har en dialog åben (ellers når de er færdige). */
let renderPending = false;
const busy = () => document.getElementById('dlg')?.open || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.id !== 'user');
function softRender() { if (busy()) { renderPending = true; renderNet(); } else { renderPending = false; render(); } }
document.addEventListener('focusout', () => setTimeout(() => { if (renderPending && !busy()) softRender(); }, 300));
document.getElementById('dlg')?.addEventListener('close', () => setTimeout(() => { if (renderPending && !busy()) softRender(); }, 300));
/** Logposter skrevet af den indloggede medarbejder mærkes med medarbejder-id (så de må gemmes/ses af vedkommende). */
function stampAudit() { if (!member) return; for (const a of db.audit || []) { if (a.byEmp) continue; if (a.by === member.userId) a.byEmp = member.employeeId || null; } }
async function logout() { if (syncer && syncer.pending(db).length && navigator.onLine) await doSync(true); await cloud.signOut(); await signedOut(); }
/** Skift kodeord (kræver det nuværende, så en ulåst telefon ikke kan overtages). */
function changePassword() {
  openDlg(`<h2>Skift kodeord</h2><p class="small mute">${esc(member.email)}</p>
    <label><span>Nuværende kodeord</span><input name="old" type="password" autocomplete="current-password" required></label>
    <label><span>Nyt kodeord (mindst 8 tegn)</span><input name="pw" type="password" autocomplete="new-password" required minlength="8"></label>
    <label><span>Gentag nyt kodeord</span><input name="pw2" type="password" autocomplete="new-password" required minlength="8"></label>`, async (f) => {
    if (f.pw.length < 8) return 'Kodeord skal være mindst 8 tegn';
    if (f.pw !== f.pw2) return 'De to nye kodeord er ikke ens';
    if (f.pw === f.old) return 'Det nye kodeord er det samme som det gamle';
    if (!(await cloud.checkPassword(member.email, f.old))) return 'Det nuværende kodeord er forkert';
    try { await cloud.updatePassword(f.pw); } catch (e) { return danishAuthError(e.message); }
    toast('Kodeord ændret');
  });
}
/** Efter log ud: gem brugerens data og fjern dem fra skærmen/hukommelsen. */
async function signedOut() { member = null; syncer = null; gate = 'login'; await persist(); if (dbKey !== KEY) { setDb(freshDb()); dbKey = KEY; } render(); }
setInterval(() => { if (syncer && document.visibilityState === 'visible') doSync(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') doSync(); });
window.addEventListener('online', () => doSync());

/** Admin: brugere, invitationer og forbindelse */
/** Admin: forbindelse og opsætning af e-conomic */
async function ecoCard() {
  const el = document.getElementById('ecoCard'); if (!el) return;
  const cfg = (db.settings.economic ||= {});
  const head = `<h2>e-conomic</h2>`;
  if (!cloud?.economic || !member) { el.innerHTML = head + '<p class="small mute">Kræver login i den fælles database (Supabase) – ikke i testdatabasen.</p>'; return; }
  if (member.role !== 'admin') { el.innerHTML = head + '<p class="small mute">Kun admin.</p>'; return; }
  el.innerHTML = head + '<p class="small mute">Forbinder …</p>';
  let info, opts;
  try { info = await cloud.economic('ping'); opts = ui._ecoOpts || (ui._ecoOpts = await cloud.economic('options')); }
  catch (e) { el.innerHTML = head + `<p class="warn-t">${esc(e.message)}</p><p class="small">Opsætning: se <b>vindue/supabase/OPSÆTNING.md → e-conomic</b>. Fakturering kører i øve-udgave, indtil forbindelsen virker.</p><button data-act="ecoRetry">Prøv igen</button>`; return; }
  const sel = (key, list, label, fmt = (x) => `${x.id} · ${x.name}`) => `<label><span>${label}</span><select data-eco="${key}"><option value="">– vælg –</option>${list.map((x) => `<option value="${esc(x.id)}" ${String(cfg[key] ?? '') === String(x.id) ? 'selected' : ''}>${esc(fmt(x))}</option>`).join('')}</select></label>`;
  const need = ['layout', 'paymentTerms', 'vatZone', 'customerGroup', 'product'];
  const missing = need.filter((k) => !cfg[k]);
  el.innerHTML = head + `<p class="small">✓ Forbundet til <b>${esc(info.company || '')}</b> (aftale ${esc(info.agreementNumber)})</p>
    <div class="grid">${sel('customerGroup', opts.customerGroups, 'Kundegruppe for nye kunder')}${sel('paymentTerms', opts.paymentTerms, 'Betalingsbetingelse')}${sel('vatZone', opts.vatZones, 'Momszone')}
    ${sel('layout', opts.layouts, 'Fakturalayout')}${sel('product', opts.products, 'Vare på fakturalinjer', (x) => `${x.id} · ${x.name}`)}</div>
    <h3>Kontant betaling på stedet</h3><div class="grid">${sel('journal', opts.journals, 'Kassekladde')}${sel('cashAccount', opts.accounts.filter((a) => a.type === 'status'), 'Konto for kontant')}</div>
    <label class="small"><input type="checkbox" data-eco="sendEmail" ${cfg.sendEmail === false ? '' : 'checked'}> Send fakturaen pr. mail ved bogføring (kunder med e-mail og fakturatype "Email")</label><br>
    <label class="small"><input type="checkbox" data-eco="enabled" ${cfg.enabled ? 'checked' : ''} ${missing.length ? 'disabled' : ''}> <b>Brug e-conomic til fakturering</b>${missing.length ? ' – udfyld felterne ovenfor først' : ''}</label>
    ${cfg.autoFrom ? `<p class="small">Automatisk fakturering af besøg færdigmeldt efter <b>${fmtTs(cfg.autoFrom)}</b>. Ældre besøg kan faktureres manuelt under Fakturering.</p>` : ''}<p class="small mute">Når den er slået til, laver "Fakturering" rigtige fakturaer i e-conomic. Kunder oprettes automatisk (med samme kundenummer som i appen, når det er ledigt).</p>
    <div class="row"><button data-act="ecoRetry">Genindlæs lister</button></div>`;
  el.querySelectorAll('[data-eco]').forEach((x) => (x.onchange = () => { const k = x.dataset.eco;
    cfg[k] = x.type === 'checkbox' ? x.checked : x.value === '' ? null : (k === 'product' ? x.value : Number(x.value));
    if (k === 'enabled' && x.checked && !cfg.autoFrom) cfg.autoFrom = new Date().toISOString(); // gamle besøg faktureres ikke automatisk
    S.audit(db, ui.user.id, 'economic.settings', k, { value: cfg[k] }); save(); ecoCard(); }));
}
async function cloudCard() {
  const el = document.getElementById('cloudCard'); if (!el) return;
  if (!cloud || !member) { const c = cloudConf();
    el.innerHTML = `<h2>Fælles database og login</h2><p class="small">Appen kører <b>kun lokalt i denne browser</b>. Forbind til Supabase for at få login, medarbejderadgang og samme data på PC og telefon.</p>
      <div class="grid"><label><span>Supabase Project URL</span><input id="cfUrl" value="${esc(c?.url || '')}" placeholder="https://xxxx.supabase.co"></label><label><span>Anon / publishable key</span><input id="cfKey" value="${esc(c?.anonKey || '')}"></label></div>
      <div class="row"><button class="pri" data-act="cfSave">Forbind</button><button data-act="cfMemory">Prøv med testdatabase i browseren</button></div>
      <p class="small mute">Se vindue/supabase/OPSÆTNING.md. Brug kun den offentlige anon-nøgle – aldrig service_role.</p>`; return; }
  el.innerHTML = `<h2>Brugere og adgang</h2><p class="small mute">Firma: <b>${esc(member.orgName || '')}</b> · du er <b>${esc(member.email)}</b> (${member.role}) · ${cloudConf()?.url === 'memory' ? 'testdatabase i browseren' : 'Supabase'}</p><p class="mute small">Henter …</p>`;
  if (member.role !== 'admin') return;
  try {
    const [ms, inv] = await Promise.all([cloud.members(member.orgId), cloud.invites(member.orgId)]);
    el.innerHTML = `<h2>Brugere og adgang</h2><p class="small mute">Firma: <b>${esc(member.orgName || '')}</b> · ${cloudConf()?.url === 'memory' ? 'testdatabase i browseren' : 'Supabase'}</p>
      <table><tr><th>Bruger</th><th>Rolle</th><th>Medarbejder i appen</th><th></th></tr>${ms.map((x) => `<tr><td>${esc(x.email || x.user_id)}</td><td>${x.role === 'admin' ? 'Admin' : 'Medarbejder'}</td><td>${esc(emp(x.employee_id)?.name || '–')}</td><td>${x.user_id === member.userId ? '<span class="small mute">dig</span>' : `<button class="bad small" data-act="cmRemove" data-id="${x.user_id}">Fjern adgang</button>`}</td></tr>`).join('')}</table>
      <h3>Invitér</h3><div class="row"><select id="ivEmp">${db.employees.filter((e) => !e.inactive).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select><select id="ivRole"><option value="medarbejder">Medarbejder</option><option value="admin">Admin</option></select><button class="pri" data-act="ivCreate">Lav invitationskode</button></div>
      <p class="small mute">Giv koden til personen. De åbner appen, opretter en bruger med deres egen e-mail og indtaster koden. Koden virker én gang i 14 dage.</p>
      ${inv.length ? `<table><tr><th>Kode</th><th>Til</th><th>Udløber</th><th></th></tr>${inv.map((i) => `<tr><td><b class="code">${esc(i.code)}</b></td><td>${esc(emp(i.employee_id)?.name || '')} (${i.role})</td><td class="small">${esc(String(i.expires_at).slice(0, 10))}</td><td><button class="small" data-act="ivDel" data-id="${esc(i.code)}">Slet</button></td></tr>`).join('')}</table>` : ''}
      <h3>To-trinslogin (dig)</h3><div id="mfaList" class="small mute">Henter …</div>
      <div class="row" style="margin-top:10px"><button data-act="syncNow">Synkronisér nu</button><button data-act="chPw">Skift kodeord</button><button data-act="logout">Log ud</button></div>`;
    if (cloud.mfaStatus) { const mf = await cloud.mfaStatus(); const box = document.getElementById('mfaList');
      if (box) box.outerHTML = `<table>${mf.factors.map((f) => `<tr><td>🔐 ${esc(f.name)}</td><td class="small mute">tilføjet ${esc(String(f.created || '').slice(0, 10))}</td><td><button class="small" data-act="mfaDel" data-id="${esc(f.id)}">Fjern</button></td></tr>`).join('') || '<tr><td class="mute">Ingen enheder</td></tr>'}</table>
        <div class="row"><button data-act="mfaAdd">+ Tilføj ekstra enhed</button></div><p class="small mute">Anbefalet: to enheder (fx telefon + kodeordsmanager), så du ikke låses ude, hvis telefonen bliver væk.</p>`; }
  } catch (e) { el.innerHTML += `<p class="warn-t">${esc(e.message)}</p>`; }
}
/** Ekstra enhed til to-trinslogin */
async function addMfaDevice() {
  const name = (prompt('Navn på enheden (fx "1Password" eller "Ekstra telefon")', 'Ekstra enhed') || '').trim(); if (!name) return;
  let n; try { n = await cloud.mfaEnroll(name); } catch (e) { return toast(danishAuthError(e.message)); }
  openDlg(`<h2>Tilføj enhed: ${esc(name)}</h2>${n.qr ? `<p style="text-align:center"><img src="${n.qr}" alt="QR-kode" style="width:200px;height:200px;background:#fff;padding:8px;border-radius:8px"></p>` : ''}
    <p class="small">Eller indtast nøglen: <b class="code" style="word-break:break-all">${esc(n.secret)}</b></p>
    <label><span>Kode fra den nye enhed</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>`, async (f) => {
    try { await cloud.mfaVerify(n.id, f.code); } catch (e) { return danishAuthError(e.message); }
    toast('Enhed tilføjet ✓');
  });
}

const sel = document.getElementById('user');
function renderUserSelect() { sel.hidden = !!gate; sel.innerHTML = users().map((u) => `<option value="${u.id}" ${u.id === ui.user?.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('') + (member ? `<option value="__pw">Skift kodeord</option><option value="__logout">Log ud (${esc(member.email)})</option>` : ''); }
renderUserSelect();
sel.onchange = () => { if (sel.value === '__logout') return logout(); if (sel.value === '__pw') { renderUserSelect(); return changePassword(); } ui.user = users().find((u) => u.id === sel.value); ui.customer = null; if (!isAdmin()) ui.tab = 'mobil'; render(); };
window.addEventListener('online', () => { ui.offline = false; flushOutbox(); render(); });
window.addEventListener('offline', () => { ui.offline = true; render(); });
// planlæg løbende 120 dage frem
S.planAhead(db, D.addDays(todayIso(), 120));
render();
bootCloud();
