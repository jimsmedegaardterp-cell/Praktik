// UI for prototypen. Al forretningslogik ligger i domain.js / services.js.
import * as D from './domain.js';
import * as S from './services.js';
import { MockEconomic, MockSms, mapsDirections, mapsRoute, smsLink, suggestOrder, routeKm } from './adapters.js';
import { seedDb } from './seed.js';
import * as I from './import.js';

const KEY = 'vindue-demo-v3'; // v3: ruter med egen rytme
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let db = load();
const eco = new MockEconomic(db.mock.economic);
const sms = new MockSms(db.mock.sms);
const USERS = [{ id: 'u1', name: 'Jim (admin)', role: 'admin', employeeId: 'e1' }, { id: 'u2', name: 'Mads (medarbejder)', role: 'medarbejder', employeeId: 'e2' }];
const ui = { tab: 'overblik', user: USERS[0], weekStart: mondayOf(todayIso()), day: todayIso(), customer: null, route: 'r1', q: '', offline: false, outbox: [], sel: new Set() };
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
const routeWhen = (r) => `hver ${r.intervalWeeks}. uge · næste ${fmt(D.nextRouteDate(r, todayIso()) || todayIso())}`;
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
  ${varselCard()}
  <div class="card"><h2>Dagens ruter – ${fmt(t)}</h2>${dayTable(today)}</div>
  <div class="card"><h2>Kommende 7 dage</h2>${dayTable(db.visits.filter((v) => v.plannedDate > t && v.plannedDate <= D.addDays(t, 7)).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate)), true)}</div>`;
}
function varselCard() {
  const nd = D.nextWorkday(D.addDays(todayIso(), 1), db.closedDays);
  const vs = db.visits.filter((v) => v.plannedDate === nd && v.status === 'planlagt');
  if (!vs.length) return '';
  const sent = new Set(db.smsMessages.filter((m) => m.clientRef?.startsWith('varsel:')).map((m) => m.clientRef.slice(7)));
  const left = vs.filter((v) => !sent.has(v.id)).length;
  return `<div class="card"><h2>SMS-varsler til ${fmt(nd)} ${left ? `<span class="pill warn">${left} mangler</span>` : '<span class="pill ok">alle sendt</span>'}</h2>
    ${vs.map((v) => { const c = cust(v.customerId); const tel = D.normalizePhone(c.phone); const text = D.renderTemplate(db.templates.varsel, { navn: c.name.split(' ')[0], dato: fmt(nd) });
      return `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="sp"><b>${esc(c.name)}</b> <span class="small mute">${esc(addr(v.addressId)?.street)}</span></div>${sent.has(v.id) ? '<span class="pill ok">✓ Sendt</span>' : tel ? `<a class="btn pri" data-varsel="${v.id}" data-text="${esc(text)}" href="${smsLink(tel, text)}">📱 Send varsel</a>` : '<span class="pill bad">intet mobilnr.</span>'}</div>`; }).join('')}</div>`;
}
function dayTable(vs, withDate) {
  if (!vs.length) return '<p class="mute">Ingen besøg.</p>';
  return `<table><tr>${withDate ? '<th>Dato</th>' : ''}<th>Kunde</th><th class="hide-m">Adresse</th><th>Rute</th><th>Pris</th><th>Status</th></tr>${vs.map((v) => `<tr>${withDate ? `<td>${fmt(v.plannedDate)}</td>` : ''}<td><a href="#" data-cust="${v.customerId}">${esc(cust(v.customerId)?.name)}</a></td><td class="hide-m">${esc(addr(v.addressId)?.street)}</td><td>${esc(route(v.routeId)?.name)}</td><td>${kr(v.price)}</td><td>${pill(v.status)}</td></tr>`).join('')}</table>`;
}

/* ---------------- Kunder ---------------- */
function kunder() {
  if (ui.customer && cust(ui.customer)) return kundekort(cust(ui.customer));
  const q = ui.q.toLowerCase();
  const list = db.customers.filter((c) => !c.deleted && (!q || c.name.toLowerCase().includes(q) || String(c.customerNo || c.skvizbizId || '').includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) || db.addresses.some((a) => a.customerId === c.id && a.street.toLowerCase().includes(q))));
  $view.innerHTML = `<div class="card"><div class="row"><input id="q" placeholder="Søg navn, kundenr., telefon, adresse" value="${esc(ui.q)}" class="sp"><button class="pri" data-act="newCustomer">+ Ny kunde</button></div></div>
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
      <div class="small mute">Markedsføringssamtykke: ${c.marketingConsent ? 'ja' : 'nej'}</div>
      ${c.notes ? `<p>${esc(c.notes)}</p>` : ''}
    </div>
    <div class="card"><h2>Adresser</h2>${adrs.map((a) => `<div style="margin-bottom:8px"><b>${esc(a.street)}</b> <a class="small" target="_blank" rel="noopener" href="${mapsDirections(a.street)}">Kør hertil ↗</a>${a.access ? `<div class="small">🔑 ${esc(a.access)}</div>` : ''}</div>`).join('')}<button data-act="addAddress" data-id="${c.id}">+ Adresse</button></div>
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
  const tx = document.getElementById('smsText'), info = document.getElementById('smsInfo'), own = document.getElementById('smsOwn');
  const upd = () => { const p = D.smsParts(tx.value); info.textContent = tx.value ? `${p.chars} tegn · ${p.parts} SMS · ${p.encoding}` : ''; own.href = smsLink(D.normalizePhone(c.phone) || '', tx.value); };
  tx.oninput = upd; upd();
  own.onclick = (e) => { if (!tx.value.trim()) { e.preventDefault(); return toast('Skriv en besked først'); }
    logManualSms(c, tx.value.trim()); setTimeout(render, 300); };
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
function kalender() {
  const ws = ui.weekStart; const days = [0, 1, 2, 3, 4].map((i) => D.addDays(ws, i));
  const rf = ui.calRoute || '';
  const wv = db.visits.filter((v) => v.plannedDate >= ws && v.plannedDate <= D.addDays(ws, 6) && (!rf || v.routeId === rf));
  const live = wv.filter((v) => v.status !== 'aflyst');
  const sum = live.reduce((s, v) => s + v.price, 0);
  $view.innerHTML = `<div class="card row"><button data-act="wk" data-d="-7">« Forrige</button><button data-act="wk" data-d="0">I dag</button><button data-act="wk" data-d="7">Næste »</button><b>Uge ${D.isoWeek(ws)} ${ws.slice(0, 4)}</b>
    <span class="sp"></span><select id="calRoute"><option value="">Alle ruter</option>${db.routes.map((r) => `<option value="${r.id}" ${rf === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    <button data-act="notifyWeek">SMS-varsel til ugens kunder</button></div>
  <div class="card row small"><span>Besøg: <b>${live.length}</b></span><span>Planlagt omsætning: <b>${kr(sum)}</b></span><span>Inkl. moms: <b>${kr(sum * 1.25)}</b></span><span>Tidsforbrug: <b>${D.hm(mins(live))} timer</b></span><span class="mute">Træk en kunde til en anden dag for at flytte. Klik for valg.</span></div>
  <div class="week">${days.map((d) => { const vs = wv.filter((v) => v.plannedDate === d); const closed = D.isClosedDay(d, db.closedDays);
    const groups = new Map(); for (const v of vs) { const k = v.routeId || ''; groups.set(k, [...(groups.get(k) || []), v]); }
    return `<div class="day ${closed ? 'closed' : ''}" data-day="${d}"><div class="row"><b>${fmt(d)}</b><span class="sp"></span>${vs.some((v) => v.status === 'planlagt') ? `<button class="small" data-act="dayMenu" data-d="${d}" title="Flyt/aflys/udfør hele dagen" style="padding:1px 7px">⋯</button>` : ''}</div>${closed ? '<div class="small">Lukkedag</div>' : ''}
      ${[...groups.entries()].map(([rid, gv]) => { const r = route(rid); const order = r?.order || []; gv.sort((a, b) => ((order.indexOf(a.addressId) + 1 || 999) - (order.indexOf(b.addressId) + 1 || 999)));
        return `<div class="rblock"><div class="row" ${r ? `data-route="${r.id}" data-day="${d}" style="cursor:pointer" title="Åbn færdigmelding"` : ''}><b class="sp">${esc(r?.name ?? 'Enkeltbesøg')}</b><span class="badge">${gv.length}</span></div><div class="small">${D.hm(mins(gv))} timer · ${kr(gv.filter((v) => v.status !== 'aflyst').reduce((s, v) => s + v.price, 0))}</div>
        ${gv.map((v) => `<div class="vline ${v.status}" draggable="${v.status === 'planlagt' || v.status === 'udsat'}" data-visit="${v.id}">${esc(cust(v.customerId)?.name)}, ${esc(addr(v.addressId)?.street.split(',')[0])}</div>`).join('')}</div>`; }).join('')}</div>`; }).join('')}</div>`;
  document.getElementById('calRoute').onchange = (e) => { ui.calRoute = e.target.value; render(); };
  $view.querySelectorAll('.vline[draggable=true]').forEach((ch) => ch.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', ch.dataset.visit)));
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

function bulkDialog(vs, title) {
  vs = vs.filter((v) => v.status === 'planlagt' || v.status === 'udsat');
  if (!vs.length) return toast('Vælg mindst ét planlagt besøg');
  const from = vs[0].plannedDate; const nd = D.nextWorkday(D.addDays(from, 1), db.closedDays);
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
  const tpl = tplOverride || (newDate ? db.templates.aflyst : 'Hej {navn}. Vi må desværre aflyse vinduespudsningen {dato}. Vi kommer igen ved næste planlagte besøg. Mvh. Vinduespudseren');
  ui._smsList = visits.map((v) => { const c = cust(v.customerId); return { v, c, text: D.renderTemplate(tpl, { navn: c.name.split(' ')[0], dato: fmt(v.plannedDate), nydato: newDate ? fmt(newDate) : '' }) }; });
  openDlg(`<h2>${esc(title || 'Giv kunderne besked')}</h2><p class="small mute">Tryk på hver kunde – telefonens SMS-app åbner med teksten.</p>
    ${ui._smsList.map((x, i) => `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="sp"><b>${esc(x.c.name)}</b><div class="small mute">${esc(x.text)}</div></div><a class="btn pri" data-smsi="${i}" href="${smsLink(D.normalizePhone(x.c.phone), x.text)}">📱 Send</a></div>`).join('') || '<p class="mute">Ingen</p>'}`, null, 'Færdig');
}
function logManualSms(c, text, clientRef) {
  if (clientRef && db.smsMessages.some((m) => m.clientRef === clientRef)) return;
  db.smsMessages.push({ id: S.uid('m'), clientRef, dir: 'ud', customerId: c.id, phone: D.normalizePhone(c.phone), text, kind: 'service', status: 'sendt fra telefon', at: new Date().toISOString(), by: ui.user.id, ...D.smsParts(text) });
  S.audit(db, ui.user.id, 'sms.manual', c.id); save();
}

/* ---------------- Ruter & kort ---------------- */
function routeStops(routeId, day) {
  const r = route(routeId);
  const vs = db.visits.filter((v) => v.routeId === routeId && v.plannedDate === day);
  const order = r.order || [];
  return vs.sort((a, b) => ((order.indexOf(a.addressId) + 1 || 999) - (order.indexOf(b.addressId) + 1 || 999)) || a.id.localeCompare(b.id));
}
const RES = [['aaben', '0', 'Åben – ikke behandlet'], ['udfoert', '1', 'Udført'], ['kontant', '2', 'Udført + betalt kontant'], ['spring', '3', 'Spring over / flyt']];
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
  if (!routeStops(r.id, ui.day).length && !D.routeRuns(r, ui.day)) ui.day = D.nextRouteDate(r, todayIso()) || ui.day;
  const day = ui.day; const key = r.id + '|' + day;
  const stops = routeStops(r.id, day); const pts = stops.map((v) => addr(v.addressId));
  const sug = suggestOrder(pts); const cur = routeKm(pts);
  const live = stops.filter((v) => v.status !== 'aflyst'); const total = live.reduce((s, v) => s + v.price, 0);
  db.drafts ||= {}; const dr = (db.drafts[key] ||= {});
  const mode = ui.routeMode || 'fm';
  const head = `<div class="card row noprint"><button data-act="routesAll">← Alle ruter</button><select id="rsel">${db.routes.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <button data-act="rnext" data-d="-1">← Forrige gang</button><input type="date" id="rday" value="${day}"><button data-act="rnext" data-d="1">Næste gang →</button><span class="sp"></span>
    <button data-act="rmode" data-m="fm" class="${mode === 'fm' ? 'pri' : ''}">Færdigmelding</button><button data-act="rmode" data-m="sheet" class="${mode === 'sheet' ? 'pri' : ''}">Rutesedel</button></div>
  ${D.routeRuns(r, day) ? '' : '<div class="warnbox noprint">Ruten kører ikke normalt denne dag.</div>'}`;
  const nSel = stops.filter((v) => ui.sel.has(v.id)).length;
  const est = live.reduce((s, v) => s + v.price * ((v.split?.length ? v.split : defaultSplit(v)).reduce((t, x) => t + x.pct, 0) / 100), 0);
  const stats = `<div class="row small" style="margin:6px 0"><span>${stops.length} besøg</span><span>Oms.: <b>${kr(total)}</b> (${kr(total * 1.25)} inkl. moms)</span><span>Tid: <b>${D.hm(mins(stops))}</b></span><span>Kørsel ca. <b>${Math.round(cur * 1.3)} km</b></span><span>Provision ca. <b>${kr(Math.round(est))}</b></span>${mins(live) ? `<span>Oms./time: <b>${kr(Math.round(total / (mins(live) / 60)))}</b></span>` : ''}</div>`;
  if (mode === 'fm') {
    $view.innerHTML = head + `<div class="card"><h2>Færdigmelding – ${esc(r.name)} ${fmt(day)} ${day.slice(0, 4)}</h2>${stats}
    ${stops.length ? `<div class="row noprint" style="margin:6px 0"><button data-act="selAll">${stops.every((v) => ui.sel.has(v.id)) ? 'Fravælg alle' : 'Vælg alle'}</button><span class="small mute">${nSel} valgt:</span>
      <button data-act="fmSet" data-r="aaben">0 Åben</button><button data-act="fmSet" data-r="udfoert">1 Udført</button><button data-act="fmSet" data-r="kontant">2 Kontant</button><button data-act="fmSet" data-r="spring">3 Spring over</button><button data-act="fmSplit">Fordel provision…</button><button data-act="bulkSms">📱 SMS</button></div>
    <div style="overflow-x:auto"><table class="fm"><tr><th></th><th>Nr</th>${RES.map(([, n, t]) => `<th class="c" title="${t}">${n}</th>`).join('')}<th>Kontant</th><th>Navn</th><th>Adresse</th><th>Opgave</th><th>Faktura</th><th>Provision</th></tr>
    ${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId); const done = v.status !== 'planlagt' && v.status !== 'udsat'; const d = dr[v.id] || {};
      const res = done ? doneRes(v) : d.result || 'aaben'; const sp = done ? (v.split ?? []) : (d.split ?? defaultSplit(v));
      return `<tr class="${res !== 'aaben' ? 'res-' + res : ''} ${done ? 'locked' : ''}"><td><input type="checkbox" data-sel="${v.id}" ${ui.sel.has(v.id) ? 'checked' : ''}></td><td>${i + 1}</td>
        ${RES.map(([k]) => `<td class="c"><input type="radio" name="res-${v.id}" data-res="${v.id}" value="${k}" ${res === k ? 'checked' : ''} ${done ? 'disabled' : ''}></td>`).join('')}
        <td><input type="number" min="0" step="1" class="cash" data-cash="${v.id}" value="${done ? v.completion?.cashAmount || '' : d.cashAmount ?? ''}" placeholder="${c.paymentMethod === 'kontant' || res === 'kontant' ? kr(Math.round(v.price * 1.25)) : ''}" ${done ? 'disabled' : ''}></td>
        <td><a href="#" data-cust="${c.id}">${esc(c.name)}</a></td><td class="small">${esc(a.street)}${a.access ? `<div class="mute">🔑 ${esc(a.access)}</div>` : ''}</td>
        <td>${done ? `<span class="small">${esc(STATUS[v.status]?.[0])}: ${esc(v.service)}</span>` : res === 'spring' ? `<select data-skip="${v.id}">${skipOptions(v, d)}</select>${d.skip === 'move' || d.skip === 'shift' ? `<input type="date" data-mdate="${v.id}" value="${d.moveDate || ''}" style="margin-top:3px">` : ''}`
          : `<select data-svc="${v.id}">${[...new Set([d.service || v.service, ...services()])].map((x) => `<option value="${esc(x)}" ${x === (d.service || v.service) ? 'selected' : ''}>${res === 'aaben' ? '' : 'Færdigmeld: '}${esc(x)}</option>`).join('')}</select>`}</td>
        <td title="${esc(PAY[c.paymentMethod] ?? '')}">${PAYICON[c.paymentMethod] ?? '📧'}</td><td class="small"><a href="#" data-act="fmSplitOne" data-id="${v.id}">${splitTxt(sp)}</a></td></tr>`; }).join('')}</table></div>
    <div class="small mute" style="margin-top:6px">0 = åben (røres ikke) · 1 = udført · 2 = udført og betalt kontant · 3 = spring over/flyt (vælg i opgavemenuen). Låste rækker er allerede færdigmeldt.</div>
    <div class="row" style="margin-top:10px"><div class="cashbox"><b>Kontante betalinger</b> · i alt <b>${kr(stops.reduce((s, v) => { const d = dr[v.id] || {}; return s + (v.completion?.cashAmount || (d.result === 'kontant' ? (d.cashAmount ?? Math.round(v.price * 125) / 100) : 0)); }, 0))}</b> · bogføres dags dato på kasse-konto ${esc(db.settings.cashAccount || '18100 – Kasse')} <span class="mute">(i e-conomic – SKAL VERIFICERES)</span></div><span class="sp"></span><button data-act="fmSave">💾 Gem til senere</button><button class="pri" data-act="fmCommit">✓ Gem og udfør færdigmelding</button></div>` : '<p class="mute">Ingen besøg på ruten denne dag.</p>'}</div>`;
  } else {
    $view.innerHTML = head + `<div class="card sheet"><div class="row"><h2 class="sp">${fmt(day)} ${day.slice(0, 4)} uge ${D.isoWeek(day)} – Rute: ${esc(r.name)}</h2><button class="noprint" data-act="print">🖨 Udskriv</button><a class="btn noprint" target="_blank" rel="noopener" href="${pts.length ? mapsRoute(pts.map((p) => p.street)) : '#'}">Vis på Google Maps ↗</a></div><div class="small mute">${esc(emp(r.employeeId)?.name)} · ${routeWhen(r)} · udskrevet ${fmtTs(new Date().toISOString())}</div>${stats}
    ${stops.length ? `<table><tr><th>Nr</th><th>Adresse</th><th>Navn</th><th>Tlf.</th><th>Kont.</th><th style="text-align:right">Beløb</th><th>Bemærkninger</th><th>Opgave</th><th>Tid</th><th class="noprint"></th></tr>${stops.map((v, i) => { const c = cust(v.customerId), a = addr(v.addressId); const ag = db.agreements.find((x) => x.id === v.agreementId);
      return `<tr class="${v.status === 'aflyst' ? 'struck' : ''}"><td>${i + 1}</td><td>${esc(a.street)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${c.paymentMethod === 'kontant' ? '✓' : ''}</td><td style="text-align:right">${kr(v.price)}</td><td class="small">${esc(a.access)}</td><td class="small">${esc(v.service)} (${ag?.intervalWeeks ? ag.intervalWeeks + 'u' : 'enkelt'})</td><td>${D.hm(v.durationMin ?? 15)}</td><td class="noprint"><button data-act="up" data-i="${i}">↑</button><button data-act="down" data-i="${i}">↓</button></td></tr>`; }).join('')}
      <tr><td colspan="5"><b>I alt (ekskl. moms)</b></td><td style="text-align:right"><b>${kr(total)}</b></td><td colspan="2"></td><td><b>${D.hm(mins(stops))}</b></td><td class="noprint"></td></tr></table>
    <div class="row noprint" style="margin-top:8px"><button data-act="applySuggest" ${sug.km >= cur ? 'disabled' : ''}>Brug foreslået rækkefølge${sug.km < cur ? ` (sparer ca. ${Math.round((cur - sug.km) * 1.3)} km)` : ''}</button><span class="small mute">Kørsel = luftlinje × 1,3. Rigtige køretider kræver Google Routes API.</span></div>` : '<p class="mute">Ingen besøg på ruten denne dag.</p>'}</div>`;
  }
  document.getElementById('rsel').onchange = (e) => { ui.route = e.target.value; ui.day = D.nextRouteDate(route(ui.route), todayIso()) || todayIso(); ui.sel = new Set(); render(); };
  document.getElementById('rday').onchange = (e) => { ui.day = e.target.value; render(); };
  $view.querySelectorAll('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? ui.sel.add(c.dataset.sel) : ui.sel.delete(c.dataset.sel); render(); }));
  const upd = (id, f) => { dr[id] = { ...(dr[id] || {}), ...f }; };
  $view.querySelectorAll('[data-res]').forEach((x) => (x.onchange = () => { upd(x.dataset.res, { result: x.value }); render(); }));
  $view.querySelectorAll('[data-cash]').forEach((x) => (x.onchange = () => { upd(x.dataset.cash, { cashAmount: x.value === '' ? null : +x.value, ...(x.value ? { result: 'kontant' } : {}) }); render(); }));
  $view.querySelectorAll('[data-skip]').forEach((x) => (x.onchange = () => { upd(x.dataset.skip, { skip: x.value }); render(); }));
  $view.querySelectorAll('[data-mdate]').forEach((x) => (x.onchange = () => { upd(x.dataset.mdate, { moveDate: x.value }); save(); }));
  $view.querySelectorAll('[data-svc]').forEach((x) => (x.onchange = () => { upd(x.dataset.svc, { service: x.value }); save(); }));
  ui._stops = stops; ui._sug = sug.order; ui._draft = dr; ui._draftKey = key;
}
function splitDialog(visits) {
  if (!visits.length) return toast('Vælg mindst én kunde');
  const cur = ui._draft[visits[0].id]?.split ?? defaultSplit(visits[0]);
  const pctOf = (eid) => cur.find((x) => x.employeeId === eid)?.pct ?? 0;
  openDlg(`<h2>Fordeling af provision – ${visits.length} kunde(r)</h2><p class="small mute">Beløb ekskl. moms. Resten tilfalder firmaet.</p>
    <table><tr><th>Medarbejder</th><th>%-sats</th><th style="text-align:right">Beløb</th></tr>${db.employees.map((e) => `<tr><td>${esc(e.name)}</td><td><input type="number" min="0" max="100" step="0.5" name="p_${e.id}" value="${pctOf(e.id)}" style="width:80px"></td><td style="text-align:right">${kr(visits.reduce((s, v) => s + v.price, 0) * pctOf(e.id) / 100)}</td></tr>`).join('')}</table>`,
  (f) => { const split = db.employees.map((e) => ({ employeeId: e.id, pct: Number(f['p_' + e.id]) || 0 })).filter((x) => x.pct > 0);
    if (split.reduce((s, x) => s + x.pct, 0) > 100) return 'Fordelingen må højst være 100 %';
    for (const v of visits) ui._draft[v.id] = { ...(ui._draft[v.id] || {}), split }; });
}
function ruteOversigt() {
  const t = todayIso(); const end = D.addDays(t, 364);
  // årsoverblik: generér (uden at gemme) alle besøg 12 mdr. frem
  const load = new Map(); let maxN = 1;
  for (const ag of db.agreements) for (const v of [...D.generateVisits(ag, t, end, [], db.closedDays), ...db.visits.filter((x) => x.agreementId === ag.id && x.manual && x.plannedDate >= t)]) { const n = (load.get(v.plannedDate) || 0) + 1; load.set(v.plannedDate, n); maxN = Math.max(maxN, n); }
  const weeks = []; for (let w = D.addDays(t, -D.weekday(t)); w <= end; w = D.addDays(w, 7)) weeks.push(w);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const rows = db.routes.map((r) => { const ags = db.agreements.filter((a) => a.routeId === r.id && a.active); const next = D.nextRouteDate(r, t);
    return { r, n: new Set(ags.map((a) => a.customerId)).size, year: ags.reduce((s, a) => s + D.annualRevenue(a), 0), min: ags.filter((a) => next && D.generateVisits(a, next, next).length).reduce((s, a) => s + (a.durationMin ?? 15), 0), next }; });
  const tot = rows.reduce((s, x) => s + x.year, 0);
  $view.innerHTML = `<div class="card"><div class="row"><h2 class="sp">Faste ruter (${db.routes.length})</h2><button data-act="addRoute">+ Opret rute</button></div>
    <div style="overflow-x:auto"><table class="heat"><tr><td></td>${weeks.map((w) => `<td class="hm">${D.toDate(w).getUTCDate() <= 7 ? MONTHS[D.month(w) - 1] : ''}</td>`).join('')}</tr>
    ${['M', 'T', 'O', 'T', 'F'].map((dn, i) => `<tr><td class="hm">${dn}</td>${weeks.map((w) => { const d = D.addDays(w, i); const n = load.get(d) || 0; return `<td title="${fmt(d)}: ${n} besøg" style="background:${n ? `rgba(31,95,139,${0.15 + 0.85 * n / maxN})` : 'var(--chip)'}"></td>`; }).join('')}</tr>`).join('')}</table></div>
    <p class="small mute">Belastning pr. dag de næste 12 måneder (mørkere = flere besøg).</p></div>
  <div class="card"><table class="clickable"><tr><th>Rutenavn</th><th>Medarbejder</th><th>Rytme</th><th>Størrelse</th><th>Næste</th><th style="text-align:right">Oms./år</th><th style="text-align:right">Inkl. moms</th><th>Tid næste gang</th></tr>
    ${rows.map((x) => `<tr data-route="${x.r.id}"><td><b>${esc(x.r.name)}</b></td><td>${esc(emp(x.r.employeeId)?.name)}</td><td>hver ${x.r.intervalWeeks}. uge</td><td>${x.n} kunder</td><td>${x.next ? fmt(x.next) + ' ' + x.next.slice(0, 4) : '–'}</td><td style="text-align:right">${kr(Math.round(x.year))}</td><td style="text-align:right">${kr(Math.round(x.year * 1.25))}</td><td>${D.hm(x.min)}</td></tr>`).join('')}
    <tr><td colspan="5"><b>Total</b></td><td style="text-align:right"><b>${kr(Math.round(tot))}</b></td><td style="text-align:right"><b>${kr(Math.round(tot * 1.25))}</b></td><td></td></tr></table>
    <p class="small mute">Oms./år er beregnet ud fra aftalernes pris, interval og sæson.</p></div>`;
}
/* ---------------- Mobil dagsrute ---------------- */
function mobil() {
  const day = ui.day; const myRoutes = db.routes.filter((r) => isAdmin() || r.employeeId === ui.user.employeeId);
  const stops = myRoutes.flatMap((r) => routeStops(r.id, day));
  const pending = new Set(ui.outbox.map((o) => o.visitId));
  $view.innerHTML = `<div class="row" style="margin-bottom:10px"><button data-act="dd" data-d="-1">←</button><b class="sp" style="text-align:center">${fmt(day)} · ${stops.filter((v) => v.status !== 'planlagt').length}/${stops.length} · ${D.hm(mins(stops))} t</b><button data-act="dd" data-d="1">→</button></div>
  <div class="row small" style="margin-bottom:10px"><label><input type="checkbox" id="off" ${ui.offline ? 'checked' : ''}> Simulér offline</label>${ui.outbox.length ? `<span class="pill warn">${ui.outbox.length} registrering(er) venter på net</span>` : ''}</div>
  ${stops.map((v) => { const c = cust(v.customerId), a = addr(v.addressId); const done = v.status !== 'planlagt' || pending.has(v.id); const tel = D.normalizePhone(c.phone);
    return `<div class="stop ${done ? 'done' : ''}"><div class="row"><h3 class="sp">${esc(c.name)}</h3>${pending.has(v.id) ? '<span class="pill warn">Venter på sync</span>' : pill(v.status)}</div>
    <div>${esc(a.street)}</div>${a.access ? `<div class="small">🔑 ${esc(a.access)}</div>` : ''}<div class="small mute">${esc(v.service)} · ${kr(v.price)} · ${v.durationMin ?? 15} min</div>
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
  <div class="card"><h2>Ruter</h2>
    <table><tr><th>Navn</th><th>Medarbejder</th><th>Hver … uge</th><th>Næste dato</th></tr>${db.routes.map((r) => `<tr><td><input data-rf="name" data-r="${r.id}" value="${esc(r.name)}"></td><td><select data-rf="employeeId" data-r="${r.id}">${db.employees.map((e) => `<option value="${e.id}" ${e.id === r.employeeId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></td>
      <td><input type="number" min="1" max="52" data-rf="intervalWeeks" data-r="${r.id}" value="${r.intervalWeeks}" style="width:70px"></td><td><input type="date" data-rf="anchorDate" data-r="${r.id}" value="${D.nextRouteDate(r, todayIso())}"></td></tr>`).join('')}</table>
    <button data-act="addRoute" style="margin-top:8px">+ Rute</button>
    <p class="small mute">Ændring af rutens dato/rytme flytter ikke eksisterende besøg automatisk – brug Kalender (flyt/forskyd) eller ret aftalerne.</p></div>
  <div class="card"><h2>SMS-skabeloner</h2>${Object.entries(db.templates).map(([k, v]) => `<label><span>${esc(k)} – felter: {navn} {dato} {tid} {nydato}</span><textarea data-tpl="${k}">${esc(v)}</textarea></label>`).join('')}</div>
  <div class="card"><h2>Lukkedage (ferie mv.)</h2><p class="small mute">Helligdage beregnes automatisk. Besøg på lukkedage flyttes til næste arbejdsdag ved planlægning.</p><div class="row"><input type="date" id="cd"><button data-act="addClosed">Tilføj</button></div><div class="small">${db.closedDays.map((d) => `<span class="pill">${d} <a href="#" data-act="rmClosed" data-d="${d}">×</a></span>`).join(' ')}</div></div>
  <div class="card"><h2>Auditlog</h2><div style="max-height:320px;overflow:auto"><table><tr><th>Tid</th><th>Bruger</th><th>Handling</th><th>Ref</th></tr>${db.audit.slice(0, 200).map((a) => `<tr class="small"><td>${fmtTs(a.at)}</td><td>${esc(USERS.find((u) => u.id === a.by)?.name ?? a.by)}</td><td>${esc(a.action)}</td><td class="mute">${esc(a.ref)} ${esc(JSON.stringify(a.detail).slice(0, 80))}</td></tr>`).join('')}</table></div></div>`;
  document.getElementById('comMonth').onchange = (e) => { ui.comMonth = e.target.value; render(); };
  document.getElementById('comVat').onchange = (e) => { db.settings.commissionInclVat = e.target.checked; S.audit(db, ui.user.id, 'commission.vat', '-', { inclVat: e.target.checked }); render(); };
  $view.querySelectorAll('[data-rate]').forEach((i) => (i.onchange = () => { const v = Number(i.value); if (!(v >= 0 && v <= 100)) return toast('Ugyldig sats'); const e = emp(i.dataset.rate); e.commissionRate = v / 100; S.audit(db, ui.user.id, 'commission.rate', e.id, { rate: v }); render(); }));
  $view.querySelectorAll('[data-rf]').forEach((el) => (el.onchange = () => { const r = route(el.dataset.r); const f = el.dataset.rf; r[f] = f === 'intervalWeeks' ? Math.max(1, +el.value || 1) : el.value; S.audit(db, ui.user.id, 'route.edit', r.id, { [f]: r[f] }); render(); }));
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
  const sl = e.target.closest('[data-smsi]'); if (sl) { const x = ui._smsList[+sl.dataset.smsi]; logManualSms(x.c, x.text); sl.textContent = '✓ Sendt'; sl.classList.remove('pri'); return; }
  const vs_ = e.target.closest('[data-varsel]'); if (vs_) { const v = db.visits.find((x) => x.id === vs_.dataset.varsel); const c = cust(v.customerId); logManualSms(c, vs_.dataset.text, 'varsel:' + v.id); setTimeout(render, 300); return; }
  const rt = e.target.closest('[data-route]'); if (rt) { ui.tab = 'ruter'; ui.routeMode = 'fm'; ui.sel = new Set(); ui.route = rt.dataset.route; ui.day = rt.dataset.day || D.nextRouteDate(route(ui.route), todayIso()) || todayIso(); return render(); }
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
      case 'cancelVisit': { const v = db.visits.find((x) => x.id === id); document.getElementById('dlg').close(); return openDlg(`<h2>Aflys besøg ${fmt(v.plannedDate)}</h2><label><span>Årsag</span><input name="note" required></label><label><input type="checkbox" name="notify"> Send SMS til kunden (mock)</label>`, async (f) => { S.registerVisit(db, ui.user, id, { result: 'aflyst', opId: S.uid('op'), note: f.note }); if (f.notify) await S.sendSms(db, ui.user, { customerId: v.customerId, text: `Hej ${cust(v.customerId).name.split(' ')[0]}. Vi må desværre aflyse besøget ${fmt(v.plannedDate)}. Mvh. Vinduespudseren` }, sms); }); }
      case 'wk': ui.weekStart = b.dataset.d === '0' ? mondayOf(todayIso()) : D.addDays(ui.weekStart, +b.dataset.d); break;
      case 'dd': ui.day = D.addDays(ui.day, +b.dataset.d); break;
      case 'notifyWeek': { const vs = db.visits.filter((v) => v.status === 'planlagt' && v.plannedDate >= ui.weekStart && v.plannedDate <= D.addDays(ui.weekStart, 6) && (!ui.calRoute || v.routeId === ui.calRoute));
        return smsListDialog(vs, null, `Varsel til ugens ${vs.length} kunder`, 'Hej {navn}. Vi kommer og pudser dine vinduer {dato}. Svar hvis det ikke passer. Mvh. Vinduespudseren'); }
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
      case 'rnext': { const r = route(ui.route); let d = D.addDays(ui.day, +b.dataset.d); for (let i = 0; i < 400 && !D.routeRuns(r, d); i++) d = D.addDays(d, +b.dataset.d); ui.day = d; break; }
      case 'rmode': ui.routeMode = b.dataset.m; break;
      case 'fmSet': for (const v of ui._stops) if (ui.sel.has(v.id) && v.status === 'planlagt') ui._draft[v.id] = { ...(ui._draft[v.id] || {}), result: b.dataset.r }; break;
      case 'fmSplit': return splitDialog(ui._stops.filter((v) => ui.sel.has(v.id) && v.status === 'planlagt'));
      case 'fmSplitOne': { const v = ui._stops.find((x) => x.id === id); if (v.status !== 'planlagt') return; return splitDialog([v]); }
      case 'fmSave': S.audit(db, ui.user.id, 'route.draft', ui._draftKey); toast('Gemt til senere – intet er færdigmeldt endnu'); break;
      case 'fmCommit': {
        const plan = ui._stops.filter((v) => v.status === 'planlagt').map((v) => ({ v, d: ui._draft[v.id] || {} })).filter(({ d }) => d.result && d.result !== 'aaben');
        if (!plan.length) return toast('Ingen kunder er markeret 1, 2 eller 3');
        const bad = plan.find(({ d }) => d.result === 'spring' && (d.skip === 'move' || d.skip === 'shift') && !d.moveDate); if (bad) return toast(`Vælg ny dato for ${cust(bad.v.customerId).name}`);
        if (!confirm(`Færdigmeld ${plan.length} kunder? Udførte går i faktureringskøen.`)) return;
        const ent = []; let moved = 0;
        for (const { v, d } of plan) {
          const split = d.split ?? defaultSplit(v);
          if (d.result === 'udfoert') ent.push({ visitId: v.id, result: 'udfoert', service: d.service, split });
          else if (d.result === 'kontant') ent.push({ visitId: v.id, result: 'udfoert', service: d.service, split, cashAmount: d.cashAmount ?? Math.round(v.price * 125) / 100 });
          else if ((d.skip || 'skip') === 'skip') ent.push({ visitId: v.id, result: 'aflyst', note: 'Sprunget over' });
          else if (d.skip === 'forgaeves') ent.push({ visitId: v.id, result: 'forgaeves', note: 'Forgæves besøg' });
          else { S.moveVisit(db, ui.user, v.id, d.skip === 'reinsert' ? D.nextWorkday(D.addDays(v.plannedDate, 1), db.closedDays) : d.moveDate, d.skip === 'shift' ? 'shift' : 'keep'); moved++; }
        }
        const r = S.finishRoute(db, ui.user, ent); for (const { v } of plan) delete ui._draft[v.id]; ui.sel = new Set();
        toast(`${r.done} færdigmeldt${moved ? `, ${moved} flyttet` : ''}${r.conflicts.length ? ', ' + r.conflicts.length + ' konflikter' : ''}`); break; }
      case 'dayMenu': return bulkDialog(db.visits.filter((v) => v.plannedDate === b.dataset.d && (!ui.calRoute || v.routeId === ui.calRoute)), `Hele ${fmt(b.dataset.d)}`);
      case 'bulk': return bulkDialog(ui._stops.filter((v) => ui.sel.has(v.id)), `${route(ui.route).name} ${fmt(ui.day)}`);
      case 'selAll': { const all = ui._stops.every((v) => ui.sel.has(v.id)); ui._stops.forEach((v) => (all ? ui.sel.delete(v.id) : ui.sel.add(v.id))); break; }
      case 'bulkSms': return smsListDialog(ui._stops.filter((v) => ui.sel.has(v.id)), null, 'SMS til valgte', db.templates.varsel);
      case 'varselSent': return;
      case 'addRoute': db.routes.push({ id: S.uid('r'), name: `Ny rute ${db.routes.length + 1}`, employeeId: db.employees[0].id, intervalWeeks: 4, anchorDate: D.nextWorkday(todayIso()) }); break;
      case 'bookVisit': { const a = db.agreements.find((x) => x.id === id); return openDlg(`<h2>Book besøg – ${esc(cust(a.customerId).name)}</h2><p class="small">${esc(a.service)} · ${esc(addr(a.addressId)?.street)}</p><label><span>Dato</span><input type="date" name="date" required value="${D.nextWorkday(D.addDays(todayIso(), 1), db.closedDays)}"></label><label><span>Rute (valgfri)</span><select name="routeId"><option value="">Ingen</option>${db.routes.map((r) => `<option value="${r.id}" ${r.id === a.routeId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`, (f) => { const v = D.manualVisit(a, f.date, db.visits); v.routeId = f.routeId || null; db.visits.push(v); S.audit(db, ui.user.id, 'visit.book', v.id); toast('Besøg booket'); }); }
      case 'print': window.print(); return;
      case 'routesAll': ui.route = null; ui.sel = new Set(); break;
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
