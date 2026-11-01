// Lokal lagring i IndexedDB (plads til mange MB – localStorage har kun ca. 5 MB).
// Falder tilbage til localStorage, hvis IndexedDB ikke kan bruges (fx visse private vinduer).
const DBN = 'sindal-vinduespolering', ST = 'kv';
let opening = null; let ok = typeof indexedDB !== 'undefined';
function open() {
  return (opening ||= new Promise((res, rej) => {
    const r = indexedDB.open(DBN, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('IndexedDB blokeret'));
  }));
}
const req = (mode, fn) => open().then((d) => new Promise((res, rej) => {
  const tx = d.transaction(ST, mode); const q = fn(tx.objectStore(ST)); let out;
  if (q) q.onsuccess = () => (out = q.result);
  tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Skrivning afbrudt'));
}));
const lsGet = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : undefined; } catch { return undefined; } };

/** Hent værdi. Findes den kun i localStorage (gammel version), flyttes den til IndexedDB. */
export async function get(k) {
  if (ok) {
    try {
      const v = await req('readonly', (s) => s.get(k));
      if (v !== undefined) return v;
      const old = lsGet(k);
      if (old !== undefined) { await req('readwrite', (s) => s.put(old, k)); try { localStorage.removeItem(k); } catch {} }
      return old;
    } catch (e) { console.warn('IndexedDB virker ikke – bruger localStorage', e); ok = false; }
  }
  return lsGet(k);
}
export async function set(k, v) {
  if (ok) { try { await req('readwrite', (s) => s.put(v, k)); return; } catch (e) { if (e?.name === 'QuotaExceededError') throw e; console.warn('IndexedDB virker ikke – bruger localStorage', e); ok = false; } }
  localStorage.setItem(k, JSON.stringify(v));
}
export async function del(k) { if (ok) { try { await req('readwrite', (s) => s.delete(k)); } catch {} } try { localStorage.removeItem(k); } catch {} }
export const usingIdb = () => ok;
/** Bed browseren om ikke at slette data ved pladsmangel. */
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
export async function estimate() { try { return await navigator.storage?.estimate?.(); } catch { return null; } }
