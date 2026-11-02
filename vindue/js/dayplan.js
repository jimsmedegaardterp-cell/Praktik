// Dagsplan: rækkefølge for ALLE dagens besøg på tværs af faste ruter – gemmes pr. dag (db.dayPlans[dato]),
// de faste ruters rækkefølge røres ikke. Køretider: Google Maps Routes API (hvis nøgle) ellers luftlinje-skøn.
const R = 6371, rad = Math.PI / 180;
export const km = (a, b) => { if (a?.lat == null || b?.lat == null) return null; const dLa = (b.lat - a.lat) * rad, dLo = (b.lng - a.lng) * rad;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2)); };
/** Luftlinje-skøn for køretid: vej ≈ 1,3 × luftlinje, 50 km/t. */
export const estLeg = (a, b) => { const k = km(a, b); return k == null ? { sec: null, m: null } : { sec: Math.round((k * 1.3) / 50 * 3600), m: Math.round(k * 1300) }; };

/** "Som faste ruter": ruterne efter hinanden i den rækkefølge de står (rutens faste rækkefølge inde i hver). */
export function routeOrder(visits, routes) {
  const byRoute = new Map(); for (const v of visits) byRoute.set(v.routeId || '', [...(byRoute.get(v.routeId || '') || []), v]);
  const out = [];
  for (const [rid, vs] of byRoute) { const o = routes.find((r) => r.id === rid)?.order || []; vs.sort((a, b) => ((o.indexOf(a.addressId) + 1 || 999) - (o.indexOf(b.addressId) + 1 || 999)) || String(a.id).localeCompare(String(b.id))); out.push(...vs); } // samme sortering som rutesiden
  return out.map((v) => v.id);
}

/** Lokal optimering (nærmeste nabo + 2-opt) på en omkostningsfunktion cost(i,j) over punkter 0..n-1; start = indeks n (depot) eller null. */
export function optimize(n, cost, depot = null) {
  if (n <= 2) return [...Array(n).keys()];
  const left = new Set([...Array(n).keys()]); const tour = [];
  let cur = depot; if (cur == null) { cur = 0; left.delete(0); tour.push(0); }
  while (left.size) { let best = null, bc = Infinity; for (const j of left) { const c = cost(cur, j); if (c < bc) { bc = c; best = j; } } tour.push(best); left.delete(best); cur = best; }
  const len = (t) => { let s = depot != null ? cost(depot, t[0]) + cost(t[t.length - 1], depot) : 0; for (let i = 1; i < t.length; i++) s += cost(t[i - 1], t[i]); return s; };
  let improved = true, guard = 0;
  while (improved && guard++ < 50) { improved = false;
    for (let i = 0; i < tour.length - 1; i++) for (let k = i + 1; k < tour.length; k++) {
      const t2 = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
      if (len(t2) + 1e-9 < len(tour)) { tour.splice(0, tour.length, ...t2); improved = true; } } }
  return tour;
}
/** Optimal rækkefølge med luftlinje (bruges uden Google, og som udgangspunkt for Google ved > 25 stop). */
export function localOptimal(visits, addrOf, start) {
  const pts = visits.map((v) => addrOf(v)); const depot = start?.lat != null ? pts.length : null; const all = depot != null ? [...pts, start] : pts;
  const cost = (i, j) => { const k = km(all[i], all[j]); return k == null ? 50 : k; };
  return optimize(pts.length, cost, depot).map((i) => visits[i].id);
}
/** Saml benene for en rækkefølge (luftlinje). */
export function estimateLegs(stopsInOrder, start) {
  const pts = start?.lat != null ? [start, ...stopsInOrder, start] : stopsInOrder; const legs = [];
  for (let i = 1; i < pts.length; i++) legs.push(estLeg(pts[i - 1], pts[i]));
  return legs;
}
export const sumLegs = (legs) => legs.reduce((s, l) => ({ sec: s.sec + (l.sec || 0), m: s.m + (l.m || 0), unknown: s.unknown + (l.sec == null ? 1 : 0) }), { sec: 0, m: 0, unknown: 0 });

/* ---------------- Google Maps Routes API (computeRoutes) ----------------
 * Verificeret i brug 2/11-2026 (køretider). Maks. 25 mellempunkter pr. kald; pris: se Googles prisliste (gratis kvote pr. måned).
 * Nøglen er en browser-nøgle: begræns den i Google Cloud til HTTP-henvisning (dit GitHub Pages-domæne) og kun Routes API.
 */
const wp = (p) => (p.lat != null ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } } : { address: p.street });
/** Ét kald: origin → (intermediates, evt. optimeret) → destination. Returnerer rækkefølgen af intermediates og benene. */
export async function googleRoute(key, { origin, destination, intermediates, optimize: opt }, fetchFn = fetch) {
  if (intermediates.length > 25) throw new Error('Google kan højst tage 25 mellemstop pr. beregning');
  const body = { origin: wp(origin), destination: wp(destination), intermediates: intermediates.map(wp), travelMode: 'DRIVE', optimizeWaypointOrder: !!opt && intermediates.length > 1, languageCode: 'da', regionCode: 'dk', units: 'METRIC' };
  const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.polyline.encodedPolyline' },
    body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google Maps: ' + (j.error?.message || res.status));
  const r = j.routes?.[0]; if (!r) throw new Error('Google Maps fandt ingen rute');
  const order = r.optimizedIntermediateWaypointIndex?.length && r.optimizedIntermediateWaypointIndex[0] !== -1 ? r.optimizedIntermediateWaypointIndex : intermediates.map((_, k) => k);
  return { order, legs: (r.legs || []).map((l) => ({ sec: parseInt(String(l.duration || '0'), 10), m: l.distanceMeters || 0 })), polyline: r.polyline?.encodedPolyline || null };
}
/**
 * Google for en hel dag. stops er allerede i en god lokal rækkefølge. Deles i sammenhængende bidder (≤ 24 stop):
 * hver bid kører fra forrige bids sidste stop (eller start) og slutter i bidens sidste stop – den sidste bid slutter hjemme.
 * Inden for hver bid må Google optimere rækkefølgen af mellemstoppene. Returnerer { order (indeks i stops), legs }.
 */
export async function googleDay(key, { start, end, stops, optimize: opt }, fetchFn = fetch) {
  const back = end !== undefined ? end : start; // end: undefined = tilbage til start, null = slut ved sidste stop, punkt = slut dér
  const order = []; const legs = []; const polylines = []; const size = 24;
  let from = start || stops[0]; let i = start ? 0 : 1; if (!start) order.push(0);
  while (i < stops.length) {
    const idx = [...Array(Math.min(size, stops.length - i)).keys()].map((k) => i + k);
    const last = i + idx.length >= stops.length;
    let dest, inter;
    if (last && back) { dest = back; inter = idx; } else { dest = stops[idx[idx.length - 1]]; inter = idx.slice(0, -1); }
    const r = await googleRoute(key, { origin: from, destination: dest, intermediates: inter.map((k) => stops[k]), optimize: opt }, fetchFn);
    order.push(...r.order.map((k) => inter[k])); if (!(last && back)) order.push(idx[idx.length - 1]);
    legs.push(...r.legs); if (r.polyline) polylines.push(r.polyline);
    from = stops[order[order.length - 1]]; i += idx.length;
  }
  return { order, legs, polylines };
}
