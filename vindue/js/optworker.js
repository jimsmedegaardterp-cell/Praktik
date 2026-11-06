// Baggrundsberegning af ruteoptimering (så appen ikke fryser under lange beregninger).
const v = new URL(import.meta.url).searchParams.get('v') || '';
const O = await import('./optimizer.js' + (v ? '?v=' + v : ''));
self.onmessage = (e) => {
  const { db, opts, extra } = e.data;
  try { self.postMessage({ ok: true, res: O.optimizeAll(db, opts, extra || {}) }); }
  catch (err) { self.postMessage({ ok: false, error: err.message }); }
};
self.postMessage({ ready: true });
