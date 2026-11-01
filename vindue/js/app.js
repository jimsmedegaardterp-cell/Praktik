// UI for prototypen. Al forretningslogik ligger i domain.js / services.js.
import * as D from './domain.js';
import * as S from './services.js';
import { MockEconomic, MockSms, mapsDirections, mapsRoute, smsLink, suggestOrder, routeKm } from './adapters.js';
import { seedDb } from './seed.js';
import * as I from './import.js';

const KEY = 'vindue-demo-v1';
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let db = load();
const eco = new MockEconomic(db.mock.economic);
const sms = new MockSms(db.mock.sms);
const USERS = [{ id: 'u1', name: 'Jim (admin)', role: 'admin', employeeId: 'e1' }, { id: 'u2', name: 'Mads (medarbejder)', role: 'medarbejder', employeeId: 'e2' }];
const ui = { tab: 'overblik', user: USERS[0], weekStart: mondayOf(todayIso()), day: todayIso(), customer: null, route: 'r1', q: '', offline: false, outbox: [] };
try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY + '-ui')) || {}); ui.user = USERS.find((u) => u.id === ui.user?.id) || USERS[0]; } catch {}

function load() {
  try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r); } catch {}
  const d = seedDb(todayIso()); return d;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); localStorage.setItem(KEY + '-ui', JSON.stringify({ tab: ui.tab, user: { id: ui.user.id }, route: ui.route, outbox: ui.outbox })); } catch {}
}
function mondayOf(iso) { return D.addDays(iso, -D.weekday(iso)); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kr = (n) => (n ?? 0).toLocaleString('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' kr';
const DAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const fmt = (iso) => { const d = D.toDate(iso); return `${DAYS[D.weekday(iso)]}. ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const fmtTs = (ts) => new Date(ts).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });
const cust = (id) => db.customers.find((c) => c.id === id);
const addr = (id) => db.addresses.find((a) => a.id === id);
const route = (id) => db.routes.find((r) => r.id === id);
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
  ['overblik', 'Overblik', true], ['kunder', 'Kunder', true], ['kalender', 'Kalender', true], ['ruter', 'Ruter & kort', true],
  ['mobil', '📱 Dagsrute', false], ['faktura', 'Fakturering', true], ['sms', 'Beskeder', true], ['import', 'Import', true], ['admin', 'Admin', true],
];
function renderTabs() {
  const tabs = TABS.filter(([, , adm]) => !adm || isAdmin());
  if (!tabs.some(([k]) => k === ui.tab)) ui.tab = tabs[0][0];
  const unread = db.smsMessages.filter((m) => m.dir === 'ind' && !m.read).length;
  document.getElementById('tabs').innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${n}${k === 'sms' && unread ? ` <span class="pill bad">${unread}</span>` : ''}</button>`).join('');
}
function render() {
  renderTabs();
  const net = document.getElementById('net'); net.textContent = ui.offline ? `Offline${ui.outbox.length ? ` · ${ui.outbox.length} i kø` : ''}` : 'Online'; net.className = 'pill ' + (ui.offline ? 'bad' : 'ok');
  ({ overblik, kunder, kalender, ruter, mobil, faktura, sms: beskeder, import: importView, admin })[ui.tab]();
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
  ${dbl.length ? `<div class="warnbox">⚠️ ${dbl.length} mulige dobbeltbookinger (samme adresse samme dag).</div>` : ''}
  ${overdue.length ? `<div class="warnbox">⚠️ ${overdue.length} besøg i fortiden er ikke registreret. <button data-act="showOverdue">Vis</button></div>` : ''}
  <div class="card"><h2>Dagens ruter – ${fmt(t)}</h2>${dayTable(today)}</div>
  <div class="card"><h2>Kommende 7 dage</h2>${dayTable(db.visits.filter((v) => v.plannedDate > t && v.plannedDate <= D.addDays(t, 7)).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate)), true)}</div>`;
}
function dayTable(vs, withDate) {
  if (!vs.length) return '<p class="mute">Ingen besøg.</p>';
  return `<table><tr>${withDate ? '<th>Dato</th>' : ''}<th>Kunde</th><th class="hide-m">Adresse</th><th>Rute</th><th>Pris</th><th>Status</th></tr>${vs.map((v) => `<tr>${withDate ? `<td>${fmt(v.plannedDate)}</td>` : ''}<td><a href="#" data-cust="${v.customerId}">${esc(cust(v.customerId)?.name)}</a></td><td class="hide-m">${esc(addr(v.addressId)?.street)}</td><td>${esc(route(v.routeId)?.name.split('–')[0])}</td><td>${kr(v.price)}</td><td>${pill(v.status)}</td></tr>`).join('')}</table>`;
}

/* ---------------- Kunder ---------------- */
function kunder() {
  if (ui.customer && cust(ui.customer)) return kundekort(cust(ui.customer));
  const q = ui.q.toLowerCase();
  const list = db.customers.filter((c) => !c.deleted && (!q || c.name.toLowerCase().includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) || db.addresses.some((a) => a.customerId === c.id && a.street.toLowerCase().includes(q))));
  $view.innerHTML = `<div class="card"><div class="row"><input id="q" placeholder="Søg navn, telefon, adresse" value="${esc(ui.q)}" class="sp"><button class="pri" data-act="newCustomer">+ Ny kunde</button></div></div>
  <div class="card list">${list.map((c) => { const ags = db.agreements.filter((a) => a.customerId === c.id && a.active); const next = db.visits.filter((v) => v.customerId === c.id && v.status === 'planlagt' && v.plannedDate >= todayIso()).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))[0];
    return `<div class="item" data-cust="${c.id}"><div><b>${esc(c.name)}</b><div class="small mute">${esc(db.addresses.filter((a) => a.customerId === c.id).map((a) => a.street).join(' · '))}</div></div><div class="small" style="text-align:right">${ags.map((a) => `${a.intervalWeeks} uger`).join(', ')}<div class="mute">${next ? 'Næste: ' + fmt(next.plannedDate) : ''}</div></div></div>`; }).join('') || '<p class="mute">Ingen kunder</p>'}</div>`;
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
    <div class="card"><h2>${esc(c.name)}</h2>
      <div>📞 <a href="tel:${esc(D.normalizePhone(c.phone) || '')}">${esc(c.phone)}</a></div>
      ${c.email ? `<div>✉️ ${esc(c.email)}</div>` : ''}
      <div class="small mute">${esc(PAY[c.paymentMethod] ?? 'Bankoverførsel')} · ${esc(c.paymentTerms)} · ${c.vatLiable ? 'Momspligtig' : 'Momsfri'} · e-conomic kundenr.: ${c.economicNumber ?? '<i>ikke oprettet</i>'}</div>
      <div class="small mute">Markedsføringssamtykke: ${c.marketingConsent ? 'ja' : 'nej'}</div>
      ${c.notes ? `<p>${esc(c.notes)}</p>` : ''}
    </div>
    <div class="card"><h2>Adresser</h2>${adrs.map((a) => `<div style="margin-bottom:8px"><b>${esc(a.street)}</b> <a class="small" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">Kør hertil ↗</a>${a.access ? `<div class="small">🔑 ${esc(a.access)}</div>` : ''}</div>`).join('')}<button data-act="addAddress" data-id="${c.id}">+ Adresse</button></div>
  </div>
  <div class="card"><h2>Serviceaftaler</h2><table><tr><th>Ydelse</th><th>Adresse</th><th>Interval</th><th>Sæson</th><th>Rute</th><th>Pris</th><th></th></tr>
    ${ags.map((a) => `<tr><td>${esc(a.service)}${a.active ? '' : ' <span class="pill">inaktiv</span>'}</td><td>${esc(addr(a.addressId)?.street)}</td><td>${a.intervalWeeks} uger · ${DAYS[D.weekday(a.anchorDate)]}</td><td class="small">${a.seasonMonths?.length ? `md. ${Math.min(...a.seasonMonths)}–${Math.max(...a.seasonMonths)}` : 'Hele året'}</td><td>${esc(route(a.routeId)?.name.split('–')[0])}</td><td>${kr(a.price)}</td><td><button data-act="editAgreement" data-id="${a.id}">Ret</button></td></tr>`).join('')}
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
  const tx = document.getElementById('smsText'), info = document.getElementById('smsInfo'), own = document.getElementById('smsOwn');
  const upd = () => { const p = D.smsParts(tx.value); info.textContent = tx.value ? `${p.chars} tegn · ${p.parts} SMS · ${p.encoding}` : ''; own.href = smsLink(D.normalizePhone(c.phone) || '', tx.value); };
  tx.oninput = upd; upd();
  own.onclick = (e) => { if (!tx.value.trim()) { e.preventDefault(); return toast('Skriv en besked først'); }
    db.smsMessages.push({ id: S.uid('m'), dir: 'ud', customerId: c.id, phone: D.normalizePhone(c.phone), text: tx.value.trim(), kind: 'service', status: 'sendt fra telefon', at: new Date().toISOString(), by: ui.user.id, ...D.smsParts(tx.value) });
    S.audit(db, ui.user.id, 'sms.manual', c.id); save(); setTimeout(render, 300); };
  document.getElementById('tpl').onchange = (e) => { const tpl = db.templates[e.target.value]; if (!tpl) return; const nv = vs.filter((v) => v.status === 'planlagt' && v.plannedDate >= t).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))[0];
    tx.value = D.renderTemplate(tpl, { navn: c.name.split(' ')[0], dato: nv ? fmt(nv.plannedDate) : '', tid: '', nydato: '' }); upd(); };
}
const msgHtml = (m) => `<div class="msg ${m.dir}">${esc(m.text)}<div class="meta">${fmtTs(m.at)} · ${m.dir === 'ud' ? esc(m.status) + (m.parts > 1 ? ` · ${m.parts} dele` : '') + (m.error ? ' · ' + esc(m.error) : '') : esc(m.phone)}</div></div>`;

function customerForm(c) {
  const isNew = !c; c ||= { name: '', phone: '', email: '', notes: '', paymentTerms: 'Netto 8 dage', vatLiable: true, marketingConsent: false };
  openDlg(`<h2>${isNew ? 'Ny kunde' : 'Rediger kunde'}</h2>
    <label><span>Navn *</span><input name="name" required value="${esc(c.name)}"></label>
    <label><span>Mobil *</span><input name="phone" required value="${esc(c.phone)}" inputmode="tel"></label>
    <label><span>E-mail (faktura)</span><input name="email" type="email" value="${esc(c.email)}"></label>
    <div class="row"><label><span>Betalingsform</span><select name="paymentMethod">${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${k === (c.paymentMethod || 'bank') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label><span>Betalingsbetingelser</span><input name="paymentTerms" value="${esc(c.paymentTerms)}"></label></div>
    <label><input type="checkbox" name="vatLiable" ${c.vatLiable ? 'checked' : ''}> Momspligtig</label>
    <label><input type="checkbox" name="marketingConsent" ${c.marketingConsent ? 'checked' : ''}> Samtykke til markedsførings-SMS</label>
    <label><span>Bemærkning (undgå følsomme oplysninger)</span><textarea name="notes">${esc(c.notes)}</textarea></label>
    ${isNew ? `<h3>Første adresse og aftale</h3><label><span>Adresse *</span><input name="street" required placeholder="Vej 1, 8600 Silkeborg"></label>${agreementFields({})}` : ''}`,
  (f) => {
    if (!D.normalizePhone(f.phone)) return 'Ugyldigt telefonnummer';
    const dup = db.customers.find((x) => x !== c && !x.deleted && D.normalizePhone(x.phone) === D.normalizePhone(f.phone));
    if (dup && !confirm(`${dup.name} har samme nummer. Opret alligevel?`)) return false;
    Object.assign(c, { name: f.name.trim(), phone: f.phone.trim(), email: f.email.trim(), notes: f.notes, paymentTerms: f.paymentTerms, paymentMethod: f.paymentMethod, vatLiable: !!f.vatLiable, marketingConsent: !!f.marketingConsent });
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
  const nm = D.addDays(todayIso(), 7 - D.weekday(todayIso()));
  return `<label><span>Ydelse</span><input name="service" value="${esc(a.service ?? 'Vinduespudsning ude')}"></label>
  <div class="row"><label><span>Pris ekskl. moms</span><input name="price" type="number" min="0" step="1" value="${a.price ?? 300}" style="width:110px"></label>
  <label><span>Interval (uger)</span><select name="intervalWeeks">${[1, 2, 3, 4, 6, 8, 10, 12, 16, 26, 52].map((n) => `<option ${n === (a.intervalWeeks ?? 4) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
  <label><span>Rute</span><select name="routeId">${db.routes.map((r) => `<option value="${r.id}" ${r.id === a.routeId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label></div>
  <div class="row"><label><span>Første besøg (bestemmer ugedag)</span><input name="anchorDate" type="date" value="${a.anchorDate ?? nm}"></label>
  <label><span>Sæson fra–til (måned)</span><input name="sFrom" type="number" min="1" max="12" value="${a.seasonMonths?.length ? Math.min(...a.seasonMonths) : 1}" style="width:60px"> – <input name="sTo" type="number" min="1" max="12" value="${a.seasonMonths?.length ? Math.max(...a.seasonMonths) : 12}" style="width:60px"></label></div>
  ${a.id ? `<label><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> Aktiv</label>` : `<label><span>Adgangsforhold</span><input name="access" placeholder="Nøgle, kode, hund …"></label>`}`;
}
function saveAgreement(a, customerId, addressId, f) {
  const price = Number(f.price); if (!(price >= 0)) return 'Ugyldig pris';
  const sf = +f.sFrom, st = +f.sTo; const months = []; for (let m = sf; ; m = (m % 12) + 1) { months.push(m); if (m === st || months.length > 12) break; }
  const vals = { service: f.service, price, intervalWeeks: +f.intervalWeeks, routeId: f.routeId, anchorDate: f.anchorDate, seasonMonths: months.length >= 12 ? [] : months };
  if (!a) { a = { id: S.uid('ag'), customerId, addressId, active: true, ...vals }; db.agreements.push(a); }
  else {
    const rhythmChanged = a.intervalWeeks !== vals.intervalWeeks || a.anchorDate !== vals.anchorDate || JSON.stringify(a.seasonMonths) !== JSON.stringify(vals.seasonMonths) || a.active !== !!f.active;
    Object.assign(a, vals, { active: !!f.active });
    // fremtidige planlagte besøg får ny pris/rute; ved ændret rytme genplanlægges de
    const t = todayIso();
    if (rhythmChanged) db.visits = db.visits.filter((v) => !(v.agreementId === a.id && v.status === 'planlagt' && v.plannedDate >= t));
    else db.visits.forEach((v) => { if (v.agreementId === a.id && v.status === 'planlagt' && v.plannedDate >= t) Object.assign(v, { price, routeId: a.routeId, service: a.service }); });
  }
  if (a.active) { const mine = db.visits.filter((v) => v.agreementId === a.id); db.visits.push(...D.generateVisits(a, todayIso() > a.anchorDate ? todayIso() : a.anchorDate, D.addDays(todayIso(), 120), mine, db.closedDays)); }
  S.audit(db, ui.user.id, 'agreement.save', a.id, vals);
}

/* ---------------- Kalender (uge) ---------------- */
function kalender() {
  const ws = ui.weekStart; const days = [0, 1, 2, 3, 4].map((i) => D.addDays(ws, i));
  const rf = ui.calRoute || '';
  $view.innerHTML = `<div class="card row"><button data-act="wk" data-d="-7">←</button><b>Uge ${D.isoWeek(ws)} · ${fmt(ws)}–${fmt(D.addDays(ws, 4))} ${ws.slice(0, 4)}</b><button data-act="wk" data-d="7">→</button><button data-act="wk" data-d="0">I dag</button>
    <span class="sp"></span><select id="calRoute"><option value="">Alle ruter</option>${db.routes.map((r) => `<option value="${r.id}" ${rf === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    <button data-act="notifyWeek">SMS-varsel til ugens kunder</button></div>
  <p class="small mute">Træk et besøg til en anden dag for at flytte det. Klik for flere valg.</p>
  <div class="week">${days.map((d) => { const vs = db.visits.filter((v) => v.plannedDate === d && (!rf || v.routeId === rf)); const closed = D.isClosedDay(d, db.closedDays);
    return `<div class="day ${closed ? 'closed' : ''}" data-day="${d}"><div class="row"><b>${fmt(d)}</b><span class="sp"></span><span class="small mute">${vs.length} · ${kr(vs.filter((v) => v.status !== 'aflyst').reduce((s, v) => s + v.price, 0))}</span></div>${closed ? '<div class="small">Lukkedag</div>' : ''}
      ${vs.map((v) => `<div class="chip ${v.status}" draggable="${v.status === 'planlagt' || v.status === 'udsat'}" data-visit="${v.id}"><b>${esc(cust(v.customerId)?.name)}</b><div class="small mute">${esc(addr(v.addressId)?.street.split(',')[0])} · ${kr(v.price)}</div></div>`).join('')}</div>`; }).join('')}</div>`;
  document.getElementById('calRoute').onchange = (e) => { ui.calRoute = e.target.value; render(); };
  $view.querySelectorAll('.chip[draggable=true]').forEach((ch) => ch.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', ch.dataset.visit)));
  $view.querySelectorAll('.day').forEach((d) => {
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('drop'); });
    d.addEventListener('dragleave', () => d.classList.remove('drop'));
    d.addEventListener('drop', (e) => { e.preventDefault(); d.classList.remove('drop'); const id = e.dataTransfer.getData('text/plain'); if (id) moveDialog(id, d.dataset.day); });
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
    if (f.notify) await S.sendSms(db, ui.user, { customerId: v.customerId, text: `Hej ${cust(v.customerId).name.split(' ')[0]}. Vores besøg er flyttet til ${fmt(f.date)}. Svar gerne hvis det ikke passer. Mvh. Vinduespudseren` }, sms);
    toast(f.mode === 'shift' ? 'Serien er forskudt' : 'Besøget er flyttet');
  });
}

/* ---------------- Ruter & kort ---------------- */
function routeStops(routeId, day) {
  const r = route(routeId);
  const vs = db.visits.filter((v) => v.routeId === routeId && v.plannedDate === day);
  const order = r.order || [];
  return vs.sort((a, b) => ((order.indexOf(a.addressId) + 1 || 999) - (order.indexOf(b.addressId) + 1 || 999)) || a.id.localeCompare(b.id));
}
function ruter() {
  const r = route(ui.route); const day = ui.day;
  const stops = routeStops(r.id, day); const pts = stops.map((v) => addr(v.addressId));
  const sug = suggestOrder(pts); const cur = routeKm(pts);
  $view.innerHTML = `<div class="card row"><select id="rsel">${db.routes.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <input type="date" id="rday" value="${day}"><span class="small mute">Medarbejder: ${esc(emp(r.employeeId)?.name)} · fast dag: ${DAYS[r.weekday]}</span></div>
  <div class="card"><h2>${esc(r.name)} – ${fmt(day)}</h2>
    ${stops.length ? `<table><tr><th>#</th><th>Kunde</th><th>Adresse</th><th>Status</th><th></th></tr>${stops.map((v, i) => `<tr><td>${i + 1}</td><td>${esc(cust(v.customerId).name)}</td><td>${esc(addr(v.addressId).street)}</td><td>${pill(v.status)}</td><td><button data-act="up" data-i="${i}">↑</button><button data-act="down" data-i="${i}">↓</button></td></tr>`).join('')}</table>
    <p>Nuværende rækkefølge ≈ <b>${cur} km</b> (luftlinje). Forslag ≈ <b>${sug.km} km</b>${sug.km < cur ? ` – sparer ca. ${Math.round((cur - sug.km) * 10) / 10} km` : ''}.</p>
    <div class="row"><button data-act="applySuggest" ${sug.km >= cur ? 'disabled' : ''}>Godkend forslag som fast rækkefølge</button><a class="btn pri" target="_blank" rel="noopener" href="${mapsRoute(pts.map((p) => p.street))}">Åbn rute i Google Maps ↗</a></div>
    <p class="small mute">Forslaget er beregnet lokalt (nærmeste nabo, luftlinje) og ændrer intet før du godkender. Rigtige køretider kræver Google Routes API – se docs/COSTS.md.</p>` : '<p class="mute">Ingen besøg på ruten denne dag.</p>'}
  </div>`;
  document.getElementById('rsel').onchange = (e) => { ui.route = e.target.value; const rr = route(ui.route); let d = todayIso(); while (D.weekday(d) !== rr.weekday) d = D.addDays(d, 1); ui.day = d; render(); };
  document.getElementById('rday').onchange = (e) => { ui.day = e.target.value; render(); };
  ui._stops = stops; ui._sug = sug.order;
}

/* ---------------- Mobil dagsrute ---------------- */
function mobil() {
  const day = ui.day; const myRoutes = db.routes.filter((r) => isAdmin() || r.employeeId === ui.user.employeeId);
  const stops = myRoutes.flatMap((r) => routeStops(r.id, day));
  const pending = new Set(ui.outbox.map((o) => o.visitId));
  $view.innerHTML = `<div class="row" style="margin-bottom:10px"><button data-act="dd" data-d="-1">←</button><b class="sp" style="text-align:center">${fmt(day)} · ${stops.filter((v) => v.status !== 'planlagt').length}/${stops.length}</b><button data-act="dd" data-d="1">→</button></div>
  <div class="row small" style="margin-bottom:10px"><label><input type="checkbox" id="off" ${ui.offline ? 'checked' : ''}> Simulér offline</label>${ui.outbox.length ? `<span class="pill warn">${ui.outbox.length} registrering(er) venter på net</span>` : ''}</div>
  ${stops.map((v) => { const c = cust(v.customerId), a = addr(v.addressId); const done = v.status !== 'planlagt' || pending.has(v.id); const tel = D.normalizePhone(c.phone);
    return `<div class="stop ${done ? 'done' : ''}"><div class="row"><h3 class="sp">${esc(c.name)}</h3>${pending.has(v.id) ? '<span class="pill warn">Venter på sync</span>' : pill(v.status)}</div>
    <div>${esc(a.street)}</div>${a.access ? `<div class="small">🔑 ${esc(a.access)}</div>` : ''}<div class="small mute">${esc(v.service)}${isAdmin() || true ? ' · ' + kr(v.price) : ''}</div>
    <div class="quick"><a class="btn" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">🧭 Kør</a><a class="btn" href="tel:${tel}">📞 Ring</a><a class="btn" href="${smsLink(tel, `Hej ${c.name.split(' ')[0]}, vi er på vej og er hos dig om ca. 15 min. Mvh. Vinduespudseren`)}">💬 På vej</a></div>
    ${c.paymentMethod === 'kontant' ? `<div class="small"><span class="pill warn">💰 Betaler kontant · ${kr(v.price * 1.25)} inkl. moms</span></div>` : ''}
    ${v.completion?.cashPaid ? '<div class="small"><span class="pill ok">Kontant modtaget</span></div>' : ''}
    ${done ? '' : `<div class="big">${c.paymentMethod === 'kontant' ? `<button class="udfoert" data-act="reg" data-r="udfoert" data-cash="1" data-id="${v.id}">✓ Udført + betalt kontant</button><button data-act="reg" data-r="udfoert" data-id="${v.id}" style="grid-column:1/-1">✓ Udført – ikke betalt endnu</button>` : `<button class="udfoert" data-act="reg" data-r="udfoert" data-id="${v.id}">✓ Udført</button>`}
      <button data-act="reg" data-r="delvis" data-id="${v.id}">Delvist</button><button data-act="reg" data-r="forgaeves" data-id="${v.id}">Forgæves</button>
      <button data-act="reg" data-r="udsat" data-id="${v.id}">Udsat</button><button data-act="reg" data-r="aflyst" data-id="${v.id}">Aflyst</button></div>`}</div>`; }).join('') || '<p class="mute">Ingen besøg denne dag.</p>'}`;
  document.getElementById('off').onchange = (e) => { ui.offline = e.target.checked; if (!ui.offline) flushOutbox(); render(); };
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
    ${q.length ? `<table><tr><th><input type="checkbox" id="all" checked></th><th>Udført</th><th>Kunde</th><th class="hide-m">Ydelse</th><th>Af</th><th>Pris</th></tr>${q.map((v) => `<tr><td><input type="checkbox" class="qv" value="${v.id}" checked></td><td>${fmt(v.completion.at.slice(0, 10))}</td><td>${esc(cust(v.customerId).name)}</td><td class="hide-m small">${esc(v.service)}${v.status === 'delvis' ? ' (delvis)' : ''}${v.completion.priceChanged ? ' <span class="pill warn">pris ændret</span>' : ''}${v.completion.note ? `<br>💬 ${esc(v.completion.note)}` : ''}</td><td>${esc(emp(v.completion.by)?.name ?? v.completion.by)}<div class="small mute">${esc(PAY[cust(v.customerId).paymentMethod] ?? '')}${v.completion.cashPaid ? ' <span class="pill ok">kontant modtaget</span>' : ''}</div></td><td>${kr(v.price)}</td></tr>`).join('')}</table>
    ${q.some((v) => v.completion.cashPaid) ? '<p class="small mute">Kontant modtaget: fakturaen oprettes som normalt; registrér indbetalingen i e-conomic (kassekladde). Automatisk registrering SKAL VERIFICERES.</p>' : ''}
    <div class="row" style="margin-top:10px"><button class="pri" data-act="approve">Godkend valgte → opret kladder i e-conomic (mock)</button><label class="small"><input type="checkbox" id="fail" ${eco.failNext ? 'checked' : ''}> Simulér timeout ved næste kald</label></div>` : '<p class="mute">Intet klar til fakturering. Registrér et besøg som udført i 📱 Dagsrute.</p>'}</div>
  <div class="card"><div class="row"><h2 class="sp">Fakturaer (e-conomic mock)</h2><button data-act="syncPay">Hent betalingsstatus</button></div>
    ${links.length ? `<table><tr><th>Kunde</th><th>Besøg</th><th>Beløb</th><th>e-conomic</th><th>Status</th><th></th></tr>${links.map((l) => `<tr><td>${esc(cust(l.customerId)?.name)}</td><td>${l.visitIds.length}</td><td>${kr(l.total)}${l.gross ? `<div class="small mute">${kr(l.gross)} inkl. moms</div>` : ''}</td><td class="small">${l.invoiceNumber ? 'Faktura ' + l.invoiceNumber : l.draftNumber ? 'Kladde ' + l.draftNumber : '–'}${l.error ? `<div style="color:var(--bad)">${esc(l.error)}</div>` : ''}</td>
      <td><span class="pill ${INV[l.status]}">${l.status}</span> ${l.payment ? `<span class="pill ${l.payment === 'betalt' ? 'ok' : 'warn'}">${l.payment}</span>` : ''}</td>
      <td>${l.status === 'fejl' ? `<button data-act="retry" data-id="${l.id}">Prøv igen</button>` : ''}${l.status === 'kladde' ? `<button data-act="book" data-id="${l.id}">Bogfør & send</button>` : ''}${l.status === 'bogført' && l.payment !== 'betalt' ? `<button class="small" data-act="pay" data-id="${l.id}" title="Kun demo">Simulér betaling</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="mute">Ingen endnu.</p>'}
    <p class="small mute">Status vises først som "kladde"/"bogført", når (mock-)e-conomic har bekræftet. Bogføring, moms, bank og betalinger ligger i e-conomic – appen henter kun status.</p></div>`;
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
  let html = `<div class="card"><h2>Import fra SkvizBiz</h2>
    <p class="small">1) Eksportér kunder fra SkvizBiz som Excel eller CSV. 2) Vælg filen. 3) Tjek at kolonnerne passer. 4) Se forhåndsvisningen. 5) Importér. Intet gemmes før trin 5, og importen kan fortrydes.</p>
    <div class="row"><input type="file" id="impFile" accept=".csv,.txt,.xlsx,.xls"><a class="btn" href="docs/eksempel-import.csv" download>Hent eksempelfil</a></div></div>`;
  if (st) {
    const p = st.parsed;
    html += `<div class="card"><h2>Kolonner i ${esc(st.fileName)} (${p.rows.length} rækker)</h2><div class="grid">${Object.entries(I.FIELDS).map(([f, label]) => `<label><span>${esc(label)}</span><select data-map="${f}"><option value="">– ikke i filen –</option>${p.headers.map((h, i) => `<option value="${i}" ${st.mapping[f] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div>
      <label><span>Standardrute for kunder uden rute</span><select id="impRoute">${db.routes.map((r) => `<option value="${r.id}" ${st.route === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label></div>`;
    const plan = I.buildImportPlan(p, st.mapping, db, { defaultRouteId: st.route || db.routes[0].id, today: todayIso() }); st.plan = plan;
    const nAgr = plan.customers.reduce((s, c) => s + c.addresses.reduce((t, a) => t + a.agreements.length, 0), 0);
    html += `<div class="card"><h2>Forhåndsvisning</h2>
      <p><b>${plan.customers.length}</b> kunder · <b>${plan.customers.reduce((s, c) => s + c.addresses.length, 0)}</b> adresser · <b>${nAgr}</b> aftaler${plan.skipped ? ` · ${plan.skipped} tomme rækker sprunget over` : ''}</p>
      ${plan.duplicates.length ? `<div class="warnbox">${plan.duplicates.length} findes allerede (samme kundenr./telefon) og springes over: ${plan.duplicates.slice(0, 8).map((d) => esc(d.name)).join(', ')}${plan.duplicates.length > 8 ? ' …' : ''}<br><label><input type="checkbox" id="impDup" ${st.includeDup ? 'checked' : ''}> Importér dem alligevel</label></div>` : ''}
      ${plan.issues.length ? `<details ${plan.errors ? 'open' : ''}><summary>${plan.errors} fejl, ${plan.issues.length - plan.errors} advarsler</summary><table>${plan.issues.slice(0, 200).map((i) => `<tr class="small"><td>Linje ${i.line}</td><td style="color:var(${i.warn ? '--warn' : '--bad'})">${esc(i.msg)}</td></tr>`).join('')}</table></details>` : '<p class="pill ok">Ingen problemer fundet</p>'}
      <div style="max-height:360px;overflow:auto;margin-top:10px"><table><tr><th>Navn</th><th>Telefon</th><th>Adresse</th><th>Aftale</th><th>Betaling</th></tr>${plan.customers.slice(0, 300).map((c) => c.addresses.map((a, j) => `<tr class="small" style="${c.dupeOf ? 'opacity:.5' : ''}"><td>${j ? '' : esc(c.name)}</td><td>${j ? '' : esc(c.phone)}</td><td>${esc(a.street)}</td><td>${a.agreements.map((g) => `${esc(g.service)} · ${kr(g.price)} · ${g.intervalWeeks} uger · fra ${fmt(g.anchorDate)}`).join('<br>') || '<span class="mute">ingen</span>'}</td><td>${j ? '' : PAY[c.paymentMethod]}</td></tr>`).join('')).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="pri" data-act="impApply" ${plan.errors ? '' : ''}>Importér ${plan.customers.filter((c) => st.includeDup || !c.dupeOf).length} kunder</button><button data-act="impCancel">Annuller</button>${plan.errors ? '<span class="small" style="color:var(--bad)">Rækker med fejl importeres med de felter der kunne læses – ret gerne filen først.</span>' : ''}</div></div>`;
  }
  if (batches.length) html += `<div class="card"><h2>Tidligere importer</h2><table>${batches.map((b) => `<tr><td>${fmtTs(b.at)}</td><td>${b.counts.customers} kunder · ${b.counts.agreements} aftaler · ${b.counts.visits} besøg</td><td>${b.rolledBack ? '<span class="pill">fortrudt</span>' : `<button class="bad" data-act="impUndo" data-id="${b.batchId}">Fortryd</button>`}</td></tr>`).join('')}</table></div>`;
  $view.innerHTML = html;
  document.getElementById('impFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
    try { const parsed = I.parseCsv(await readFile(f)); if (!parsed.headers.length) throw new Error('Filen er tom'); ui.imp = { fileName: f.name, parsed, mapping: I.guessMapping(parsed.headers), route: db.routes[0].id }; render(); } catch (err) { toast(err.message); } };
  $view.querySelectorAll('[data-map]').forEach((sl) => (sl.onchange = () => { if (sl.value === '') delete st.mapping[sl.dataset.map]; else st.mapping[sl.dataset.map] = +sl.value; render(); }));
  const ir = document.getElementById('impRoute'); if (ir) ir.onchange = () => { st.route = ir.value; render(); };
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
    <div class="card"><h2>Data & backup</h2><div class="row"><button data-act="backup">Download backup (JSON)</button><label class="btn">Gendan…<input type="file" id="restore" accept=".json" hidden></label><button data-act="planMore">Planlæg 6 mdr. frem</button><button class="bad" data-act="reset">Nulstil demo</button></div>
      <p class="small mute">Prototypen gemmer i denne browser (localStorage). ${db.customers.length} kunder · ${db.visits.length} besøg · ${db.audit.length} logposter.</p></div>
  </div>
  <div class="card"><h2>SMS-skabeloner</h2>${Object.entries(db.templates).map(([k, v]) => `<label><span>${esc(k)} – felter: {navn} {dato} {tid} {nydato}</span><textarea data-tpl="${k}">${esc(v)}</textarea></label>`).join('')}</div>
  <div class="card"><h2>Lukkedage (ferie mv.)</h2><p class="small mute">Helligdage beregnes automatisk. Besøg på lukkedage flyttes til næste arbejdsdag ved planlægning.</p><div class="row"><input type="date" id="cd"><button data-act="addClosed">Tilføj</button></div><div class="small">${db.closedDays.map((d) => `<span class="pill">${d} <a href="#" data-act="rmClosed" data-d="${d}">×</a></span>`).join(' ')}</div></div>
  <div class="card"><h2>Auditlog</h2><div style="max-height:320px;overflow:auto"><table><tr><th>Tid</th><th>Bruger</th><th>Handling</th><th>Ref</th></tr>${db.audit.slice(0, 200).map((a) => `<tr class="small"><td>${fmtTs(a.at)}</td><td>${esc(USERS.find((u) => u.id === a.by)?.name ?? a.by)}</td><td>${esc(a.action)}</td><td class="mute">${esc(a.ref)} ${esc(JSON.stringify(a.detail).slice(0, 80))}</td></tr>`).join('')}</table></div></div>`;
  document.getElementById('comMonth').onchange = (e) => { ui.comMonth = e.target.value; render(); };
  document.getElementById('comVat').onchange = (e) => { db.settings.commissionInclVat = e.target.checked; S.audit(db, ui.user.id, 'commission.vat', '-', { inclVat: e.target.checked }); render(); };
  $view.querySelectorAll('[data-rate]').forEach((i) => (i.onchange = () => { const v = Number(i.value); if (!(v >= 0 && v <= 100)) return toast('Ugyldig sats'); const e = emp(i.dataset.rate); e.commissionRate = v / 100; S.audit(db, ui.user.id, 'commission.rate', e.id, { rate: v }); render(); }));
  $view.querySelectorAll('[data-tpl]').forEach((t) => (t.onchange = () => { db.templates[t.dataset.tpl] = t.value; save(); toast('Skabelon gemt'); }));
  document.getElementById('restore').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (!Array.isArray(d.customers) || !Array.isArray(d.visits)) throw new Error('Ugyldig backup'); if (!confirm(`Gendan ${d.customers.length} kunder? Nuværende data overskrives.`)) return; db = d; save(); location.reload(); } catch (err) { toast(err.message); } };
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
  const ch = e.target.closest('.chip[data-visit]'); if (ch) return visitDialog(ch.dataset.visit);
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
      case 'cancelVisit': { const v = db.visits.find((x) => x.id === id); document.getElementById('dlg').close(); return openDlg(`<h2>Aflys besøg ${fmt(v.plannedDate)}</h2><label><span>Årsag</span><input name="note" required></label><label><input type="checkbox" name="notify"> Send SMS til kunden (mock)</label>`, async (f) => { S.registerVisit(db, ui.user, id, { result: 'aflyst', opId: S.uid('op'), note: f.note }); if (f.notify) await S.sendSms(db, ui.user, { customerId: v.customerId, text: `Hej ${cust(v.customerId).name.split(' ')[0]}. Vi må desværre aflyse besøget ${fmt(v.plannedDate)}. Mvh. Vinduespudseren` }, sms); }); }
      case 'wk': ui.weekStart = b.dataset.d === '0' ? mondayOf(todayIso()) : D.addDays(ui.weekStart, +b.dataset.d); break;
      case 'dd': ui.day = D.addDays(ui.day, +b.dataset.d); break;
      case 'notifyWeek': { const vs = db.visits.filter((v) => v.status === 'planlagt' && v.plannedDate >= ui.weekStart && v.plannedDate <= D.addDays(ui.weekStart, 6) && (!ui.calRoute || v.routeId === ui.calRoute));
        if (!vs.length || !confirm(`Send varsel (mock) til ${vs.length} kunder?`)) return;
        let n = 0; for (const v of vs) { const c = cust(v.customerId); const m = await S.sendSms(db, ui.user, { customerId: c.id, clientRef: `varsel:${v.id}`, text: D.renderTemplate(db.templates.varsel, { navn: c.name.split(' ')[0], dato: fmt(v.plannedDate) }) }, sms); if (m.status !== 'fejlet') n++; }
        toast(`${n} varsler sendt (mock). Gensendelse sender ikke dubletter.`); break; }
      case 'up': case 'down': { const st = ui._stops; const i = +b.dataset.i; const j = act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= st.length) return; [st[i], st[j]] = [st[j], st[i]]; setOrder(st.map((v) => v.addressId)); break; }
      case 'applySuggest': setOrder(ui._sug.map((a) => a.id)); toast('Ny fast rækkefølge gemt'); break;
      case 'reg': return regDialog(id, b.dataset.r, b.dataset.cash);
      case 'approve': { const ids = [...$view.querySelectorAll('.qv:checked')].map((x) => x.value); if (!ids.length) return; b.disabled = true; b.textContent = 'Opretter…'; const r = await S.approveInvoices(db, ui.user, ids, eco); toast(`${r.filter((l) => l.status === 'kladde').length} kladde(r) oprettet${r.some((l) => l.status === 'fejl') ? ', ' + r.filter((l) => l.status === 'fejl').length + ' fejl' : ''}`); break; }
      case 'retry': b.disabled = true; await S.retryInvoice(db, ui.user, id, eco); break;
      case 'book': b.disabled = true; await S.bookInvoice(db, ui.user, id, eco); break;
      case 'pay': eco.simulatePayment(db.invoiceLinks.find((l) => l.id === id).invoiceNumber); await S.syncPayments(db, eco); break;
      case 'syncPay': await S.syncPayments(db, eco); toast('Betalingsstatus hentet'); break;
      case 'fakeInbound': return openDlg(`<h2>Simulér indgående SMS</h2><label><span>Fra nummer</span><select name="from">${db.customers.filter((c) => !c.deleted).map((c) => `<option value="${esc(c.phone)}">${esc(c.name)} (${esc(c.phone)})</option>`).join('')}<option value="+4599887766">Ukendt: +45 99 88 77 66</option></select></label><label><span>Tekst</span><input name="text" value="Det passer fint, tak!" required></label>`, (f) => { S.receiveSms(db, { providerId: S.uid('in'), from: f.from, text: f.text }); });
      case 'comCsv': { const { com, mon } = ui._com; const rows = [['Måned', 'Medarbejder', 'Besøg', 'Grundlag', 'Sats', 'Provision']];
        for (const e of db.employees) { const x = com[e.id]; if (x) rows.push([mon, e.name, x.visits, x.base.toFixed(2).replace('.', ','), String(x.rate * 100).replace('.', ',') + ' %', x.commission.toFixed(2).replace('.', ',')]); }
        const detail = [['Dato', 'Medarbejder', 'Kunde', 'Ydelse', 'Status', 'Pris']]; for (const v of db.visits) { if (!D.isBillable(v) || !v.completion || v.completion.at.slice(0, 7) !== mon) continue; detail.push([v.completion.at.slice(0, 10), emp(v.completion.by)?.name ?? v.completion.by, cust(v.customerId)?.name, v.service, D.RESULTS[v.status], v.price.toFixed(2).replace('.', ',')]); }
        const csv = [...rows, [], ...detail].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = `loengrundlag-${mon}.csv`; a.click(); S.audit(db, ui.user.id, 'commission.export', mon); return; }
      case 'impCancel': ui.imp = null; break;
      case 'impApply': { const st = ui.imp; const n = st.plan.customers.filter((c) => st.includeDup || !c.dupeOf).length; if (!confirm(`Importér ${n} kunder?`)) return;
        const batchId = S.uid('imp'); const c = I.applyImportPlan(db, st.plan, { batchId, uid: S.uid, includeDuplicates: !!st.includeDup, horizon: D.addDays(todayIso(), 120), today: todayIso() });
        S.audit(db, ui.user.id, 'import.apply', batchId, { file: st.fileName, ...c }); ui.imp = null; toast(`${c.customers} kunder, ${c.agreements} aftaler, ${c.visits} besøg importeret`); break; }
      case 'impUndo': if (!confirm('Fortryd importen? Alle kunder fra den slettes.')) return; I.rollbackImport(db, id); S.audit(db, ui.user.id, 'import.rollback', id); toast('Import fortrudt'); break;
      case 'backup': download(`vinduesdrift-backup-${todayIso()}.json`, db); S.audit(db, ui.user.id, 'backup.export', '-'); break;
      case 'planMore': toast(`${S.planAhead(db, D.addDays(todayIso(), 183))} nye besøg planlagt`); break;
      case 'reset': if (!confirm('Slet alle demodata og start forfra?')) return; localStorage.removeItem(KEY); localStorage.removeItem(KEY + '-ui'); location.reload(); return;
      case 'addClosed': { const d = document.getElementById('cd').value; if (d && !db.closedDays.includes(d)) { db.closedDays.push(d); db.closedDays.sort(); db.visits.forEach((v) => { if (v.status === 'planlagt' && v.plannedDate === d) v.plannedDate = D.nextWorkday(d, db.closedDays); }); } break; }
      case 'rmClosed': db.closedDays = db.closedDays.filter((x) => x !== b.dataset.d); break;
      case 'showOverdue': ui.tab = 'mobil'; ui.day = db.visits.filter((v) => (v.status === 'planlagt' || v.status === 'udsat') && v.plannedDate < todayIso()).map((v) => v.plannedDate).sort()[0]; break;
    }
  } catch (err) { toast(err.message); }
  render();
});
function setOrder(addressIds) { const r = route(ui.route); r.order = [...addressIds, ...(r.order || []).filter((a) => !addressIds.includes(a))]; S.audit(db, ui.user.id, 'route.order', r.id); }
function download(name, obj) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

const sel = document.getElementById('user');
sel.innerHTML = USERS.map((u) => `<option value="${u.id}" ${u.id === ui.user.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
sel.onchange = () => { ui.user = USERS.find((u) => u.id === sel.value); ui.customer = null; if (!isAdmin()) ui.tab = 'mobil'; render(); };
window.addEventListener('online', () => { ui.offline = false; flushOutbox(); render(); });
window.addEventListener('offline', () => { ui.offline = true; render(); });
// planlæg løbende 120 dage frem
S.planAhead(db, D.addDays(todayIso(), 120));
render();
