// Kort i appen (Leaflet + OpenStreetMap). Viser alle stop nummereret og – når Google har beregnet ruten – den rigtige vejrute.
let loading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return (loading ||= new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet-1.9.4/leaflet.css'; document.head.append(css);
    const s = document.createElement('script'); s.src = 'vendor/leaflet-1.9.4/leaflet.js'; s.onload = () => res(window.L); s.onerror = () => rej(new Error('Kunne ikke hente kortet')); document.head.append(s);
  }));
}

/** Googles "encoded polyline" → [[lat,lng], …] */
export function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      const d = res & 1 ? ~(res >> 1) : res >> 1; if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const maps = new WeakMap();
/**
 * Tegn kort i el. stops = [{ lat, lng, n, title, sub, done }], start = { lat, lng } | null, polylines = [encoded, …] (fra Google).
 * Uden polylines tegnes stiplede lige linjer mellem stoppene.
 */
export async function showRouteMap(el, { stops, start, polylines }) {
  if (!el) return;
  const L = await loadLeaflet(); if (!el.isConnected) return;
  maps.get(el)?.remove();
  const m = L.map(el, { scrollWheelZoom: false }); maps.set(el, m);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(m);
  const pts = stops.filter((s) => s.lat != null && s.lng != null); const bounds = [];
  const icon = (txt, cls) => L.divIcon({ className: 'mk ' + (cls || ''), html: `<span>${txt}</span>`, iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26] });
  if (start?.lat != null) { L.marker([start.lat, start.lng], { icon: icon('⌂', 'home'), title: 'Start' }).addTo(m); bounds.push([start.lat, start.lng]); }
  for (const s of pts) {
    L.marker([s.lat, s.lng], { icon: icon(s.n, s.done ? 'done' : ''), title: s.title }).addTo(m).bindPopup(`<b>${s.n}. ${esc(s.title)}</b><br>${esc(s.sub || '')}`);
    bounds.push([s.lat, s.lng]);
  }
  if (polylines?.length) { for (const p of polylines) { const ll = decodePolyline(p); L.polyline(ll, { color: '#d32f2f', weight: 4, opacity: 0.85 }).addTo(m); bounds.push(...ll); } }
  else if (pts.length > 1) { const ll = [...(start?.lat != null ? [[start.lat, start.lng]] : []), ...pts.map((s) => [s.lat, s.lng])]; L.polyline(ll, { color: '#1565c0', weight: 2, dashArray: '5 6', opacity: 0.7 }).addTo(m); }
  if (bounds.length) m.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 }); else m.setView([57.47, 10.2], 10);
  const missing = stops.length - pts.length;
  if (missing) { const c = L.control({ position: 'bottomleft' }); c.onAdd = () => { const d = L.DomUtil.create('div', 'mk-note'); d.textContent = `${missing} adresse${missing > 1 ? 'r' : ''} uden koordinater vises ikke`; return d; }; c.addTo(m); }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
