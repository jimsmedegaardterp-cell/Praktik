// Rutesedler fra SkvizBiz ("A4-faktura udskrift – Rute for 2026-09-27"): åbne/udskrevne ruter, hvis besøg
// IKKE står i stamdata (dér står "næste gang" efter de åbne opgaver). Importeres efter kunderne.
// Titel: "27/09-2026 søndag uge 39 - Rute: Tagrenderens"
// Kolonner: Nr | Kl. | Adresse | By | Navn | Tlf. | Kont. | Beløb | Bemærkninger | Opgaver | Tid
// Hver opgave starter på linjen med Tid; lange opgavetekster fortsætter på næste linje(r).
import * as D from './domain.js';
import { parsePrice, parseDuration } from './import.js';

const COLS = [[/^nr$/i, 'nr'], [/^kl\.?$/i, 'kl'], [/^adresse$/i, 'street'], [/^by$/i, 'city'], [/^navn$/i, 'name'], [/^tlf/i, 'phone'], [/^kont/i, 'cash'], [/^beløb$/i, 'total'], [/^bemærk/i, 'notes'], [/^opgaver$/i, 'task'], [/^tid$/i, 'dur']];
const TITLE = /^(\d{2})\/(\d{2})-(\d{4})\s+\S+\s+uge\s+\d+\s*-\s*Rute:\s*(.+)$/i;
export const isRouteSheet = (items) => items.some((i) => TITLE.test(String(i.str).trim()));
const normS = (x) => String(x || '').toLowerCase().replace(/[\s,.()]+/g, ' ').trim();

export function parseRouteSheetItems(items) {
  const lines = [];
  for (const it of items.filter((i) => i.str && i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const l = lines.find((L) => L.page === it.page && Math.abs(L.y - it.y) <= 2);
    if (l) l.items.push(it); else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  let date = null, routeName = '', cols = null; const rows = []; let cur = null;
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x); const text = its.map((i) => i.str).join(' ').trim();
    const t = text.match(TITLE); if (t) { date ||= `${t[3]}-${t[2]}-${t[1]}`; routeName ||= t[4].trim(); continue; }
    if (its.some((i) => /^Opgaver$/i.test(i.str)) && its.some((i) => /^Beløb$/i.test(i.str))) { cols = its.map((i) => ({ x: i.x, key: (COLS.find(([re]) => re.test(i.str.trim())) || [0, null])[1] })).filter((c) => c.key); continue; }
    if (!cols || /^Udskrevet den|^Total side|^I alt|^Side \d+ af \d+$|^Forventet kørsel|^Powered by/i.test(text)) continue;
    const cell = {};
    // et tekststykke der løber ind i næste kolonne (fx "9330 Dronninglund Navn Efternavn") deles ved kolonnegrænsen
    const parts = [];
    for (const it of its) {
      const nxt = cols.find((c) => c.x > it.x + 10 && c.x < it.x + (it.w || 0) - 15);
      if (nxt && /\s/.test(it.str) && !/^[\d.,:\s-]+$/.test(it.str)) { const cut = Math.round(((nxt.x - it.x) / it.w) * it.str.length); const k = it.str.lastIndexOf(' ', cut + 1); if (k < 1) { parts.push(it); continue; }
        const a = it.str.slice(0, k).trim(), b = it.str.slice(k).trim();
        if (a && b) { parts.push({ ...it, str: a, w: nxt.x - it.x - 2 }, { ...it, str: b, x: nxt.x, w: it.w - (nxt.x - it.x) }); continue; } }
      parts.push(it);
    }
    for (const it of parts) { const center = it.x + (it.w || 0) / 2; let k = cols[0].key; for (const c of cols) if (c.x <= center + 2) k = c.key;
      if (k === 'nr' && !/^\d+$/.test(it.str.trim())) k = 'kl'; cell[k] = cell[k] ? cell[k] + ' ' + it.str : it.str; }
    if (cell.nr && /^\d+$/.test(cell.nr.trim())) { cur = { nr: +cell.nr, street: cell.street || '', city: cell.city || '', name: cell.name || '', phone: cell.phone || '', total: cell.total || '', notes: cell.notes || '', tasks: [] }; rows.push(cur); }
    else if (!cur) continue;
    else { for (const k of ['street', 'city', 'name', 'phone', 'notes']) if (cell[k]) cur[k] += (k === 'phone' ? '' : ' ') + cell[k]; }
    if (cell.dur) cur.tasks.push({ text: cell.task || '', dur: cell.dur });
    else if (cell.task) { if (cur.tasks.length) cur.tasks[cur.tasks.length - 1].text += ' ' + cell.task; else cur.tasks.push({ text: cell.task, dur: '' }); }
  }
  for (const r of rows) {
    for (const k of ['street', 'city', 'name', 'notes']) r[k] = r[k].replace(/\s+/g, ' ').trim();
    r.totalNum = parsePrice(r.total) || 0;
    r.tasks = r.tasks.map((tk) => { const txt = tk.text.replace(/\s+/g, ' ').trim(); const m = txt.match(/\((\d+)u\)\s*$/i); const once = /\(engangsopgave\)\s*$/i.test(txt);
      const service = txt.replace(/\s*\((\d+u|engangsopgave)\)\s*$/i, '').trim(); const du = parseDuration(tk.dur);
      return { service, intervalWeeks: m ? +m[1] : 0, once, durationMin: du && !Number.isNaN(du) ? du : 15 }; });
  }
  return { date, routeName, rows };
}

/** Find kunden i appen: adresse + postnr. (+ navn som tiebreak, navne kan være forkortet med "..."). */
function findCustomer(db, row) {
  const st = normS(row.street.split(',')[0]); const zip = (row.city.match(/\d{4}/) || [])[0];
  const nm = normS(row.name.replace(/\.\.\.$|…$/, ''));
  const live = db.customers.filter((c) => !c.deleted);
  const byAddr = db.addresses.filter((a) => normS(a.street).startsWith(st) && (!zip || a.street.includes(zip)) && live.some((c) => c.id === a.customerId));
  const cs = [...new Set(byAddr.map((a) => a.customerId))].map((id) => live.find((c) => c.id === id));
  if (cs.length === 1) return { c: cs[0], a: byAddr.find((a) => a.customerId === cs[0].id) };
  const named = (cs.length ? cs : live).filter((c) => normS(c.name).startsWith(nm) || nm.startsWith(normS(c.name)));
  if (named.length === 1) return { c: named[0], a: byAddr.find((a) => a.customerId === named[0].id) || db.addresses.find((a) => a.customerId === named[0].id) };
  if (cs.length > 1 && named.length > 1) return { c: named[0], a: byAddr.find((a) => a.customerId === named[0].id), ambiguous: true };
  return null;
}
/** Bedste aftale til en opgave: tekst (lig/indeholder) + interval. */
function findAgreement(ags, task, used) {
  const t = normS(task.service); let best = null, bs = 0;
  for (const g of ags) { if (used.has(g)) continue; const s = normS(g.service); let sc = 0;
    if (s === t) sc = 10; else if (t.startsWith(s) || s.startsWith(t)) sc = 6 + Math.min(s.length, t.length) / 100; else if (t.includes(s) || s.includes(t)) sc = 4;
    if (sc && (g.intervalWeeks || 0) === task.intervalWeeks) sc += 2;
    if (sc > bs) { best = g; bs = sc; } }
  return best;
}

/**
 * Plan for at lægge rutesedlernes åbne opgaver ind som besøg. sheets: [{ date, routeName, rows, targetDate }]
 * Returnerer { items:[{sheet,row,c,a,task,g,action,price,...}], issues }
 */
export function buildSheetPlan(db, sheets, { today }) {
  const items = []; const issues = [];
  for (const sh of sheets) {
    const day = sh.targetDate || sh.date;
    const route = db.routes.find((r) => r.name.toLowerCase() === String(sh.routeName).toLowerCase());
    if (!route) issues.push({ line: sh.routeName, msg: `Ruten "${sh.routeName}" findes ikke i appen – besøgene lægges uden rute`, warn: true });
    for (const row of sh.rows) {
      const line = `${sh.routeName} nr. ${row.nr}`; const f = findCustomer(db, row);
      if (!f) { issues.push({ line, msg: `${row.name}, ${row.street}: kunden findes ikke i appen – springes over` }); continue; }
      if (f.ambiguous) issues.push({ line, msg: `${row.name}: flere kunder på adressen – valgt ${f.c.name}`, warn: true });
      const ags = db.agreements.filter((g) => g.customerId === f.c.id && g.active !== false); const used = new Set();
      const sumKnown = row.tasks.length === 1 ? row.totalNum : null;
      for (const task of row.tasks) {
        const g = findAgreement(ags, task, used); if (g) used.add(g);
        const near = g && db.visits.find((v) => v.agreementId === g.id && (v.status === 'planlagt' || v.status === 'udsat') && Math.abs(D.diffDays(v.plannedDate, day)) <= Math.max(3, Math.min(21, Math.floor((g.intervalWeeks || 6) * 7 / 2) - 1)));
        const it = { sheet: sh, row, line, c: f.c, a: g ? db.addresses.find((x) => x.id === g.addressId) || f.a : f.a, task, g, routeId: route?.id || g?.routeId || null, day };
        if (near) { it.action = 'skip'; it.reason = `har allerede besøg ${near.plannedDate}`; }
        else if (g) { it.action = 'visit'; it.price = g.price; }
        else { it.action = 'oneoff'; it.price = sumKnown ?? 0;
          issues.push({ line, msg: `${f.c.name}: opgaven "${task.service}"${task.once ? ' (engangsopgave)' : ''} findes ikke som aftale – oprettes som enkeltopgave${sumKnown == null ? ' uden pris (ret prisen)' : ''}`, warn: true }); }
        items.push(it);
      }
      const known = items.filter((x) => x.row === row && x.action !== 'skip').reduce((s, x) => s + (x.price || 0), 0);
      if (row.tasks.length > 1 && Math.abs(known - row.totalNum) > 1) issues.push({ line, msg: `${f.c.name}: aftalernes priser (${known}) ≠ rutesedlens beløb (${row.totalNum})`, warn: true });
    }
  }
  return { items, issues };
}

export function applySheetPlan(db, plan, { uid }) {
  let n = 0;
  for (const it of plan.items) {
    if (it.action === 'skip') continue;
    let g = it.g;
    if (it.action === 'oneoff') {
      g = { id: uid('ag'), customerId: it.c.id, addressId: it.a?.id || db.addresses.find((a) => a.customerId === it.c.id)?.id, routeId: null, service: it.task.service, price: it.price || 0,
        intervalWeeks: 0, durationMin: it.task.durationMin, anchorDate: it.day, seasonMonths: [], active: true, fromSheet: true };
      db.agreements.push(g);
    }
    try {
      const v = D.manualVisit(g, it.day, db.visits);
      Object.assign(v, { routeId: it.routeId, durationMin: it.task.durationMin || g.durationMin, fromSheet: `${it.sheet.routeName} ${it.sheet.date}` });
      db.visits.push(v); n++;
    } catch { /* allerede booket samme dag */ }
  }
  return n;
}
