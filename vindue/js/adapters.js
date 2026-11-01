// Integrationsadaptere. Prototypen bruger KUN mocks – ingen rigtige fakturaer eller SMS.
// I produktion ligger de rigtige adaptere på serveren (nøgler må aldrig i browseren).
// Grænsefladerne her er de kontrakter resten af appen kender; udbydere kan skiftes uden ændringer andre steder.

/**
 * AccountingProvider
 *  upsertCustomer(customer) -> { externalId }
 *  createDraftInvoice({ idempotencyKey, customerExternalId, lines[] }) -> { draftNumber }
 *  bookInvoice(draftNumber) -> { invoiceNumber }
 *  getInvoiceStatus(invoiceNumber) -> { status: 'åben'|'betalt'|'forfalden', remainder }
 *
 * Rigtig e-conomic-adapter (SKAL VERIFICERES mod aktuel dokumentation før brug):
 *  - Auth via headers X-AppSecretToken + X-AgreementGrantToken (kun server-side).
 *  - REST: /customers, /invoices/drafts, /invoices/booked. e-conomic opfordrer til de nyere
 *    versionerede OpenAPI-API'er; legacy REST er i "feature freeze" (iflg. sekundær kilde, 2026).
 *  - Idempotens: e-conomic er ikke antaget at understøtte idempotensnøgler → vi låser lokalt
 *    (InvoiceLink oprettes FØR kaldet) og slår op på 'references.other' = idempotensnøgle ved genforsøg.
 */
export class MockEconomic {
  constructor(state) { this.s = state; this.s.customers ||= {}; this.s.drafts ||= {}; this.s.booked ||= {}; this.s.byKey ||= {}; this.s.seq ||= { cust: 1000, draft: 1, inv: 20260001 }; this.failNext = 0; }
  async _net() { await new Promise((r) => setTimeout(r, 150)); if (this.failNext > 0) { this.failNext--; throw new Error('Mock: timeout mod e-conomic'); } }
  async upsertCustomer(c) {
    await this._net();
    const hit = Object.values(this.s.customers).find((x) => x.localId === c.id);
    if (hit) { hit.name = c.name; return { externalId: hit.number }; }
    const number = ++this.s.seq.cust;
    this.s.customers[number] = { number, localId: c.id, name: c.name };
    return { externalId: number };
  }
  async createDraftInvoice({ idempotencyKey, customerExternalId, lines }) {
    // Genforsøg med samme nøgle returnerer den eksisterende kladde (simulerer opslag på reference).
    if (this.s.byKey[idempotencyKey]) return { draftNumber: this.s.byKey[idempotencyKey], reused: true };
    await this._net();
    const draftNumber = this.s.seq.draft++;
    this.s.drafts[draftNumber] = { draftNumber, customerExternalId, lines, idempotencyKey };
    this.s.byKey[idempotencyKey] = draftNumber;
    return { draftNumber };
  }
  async bookInvoice(draftNumber) {
    await this._net();
    const d = this.s.drafts[draftNumber];
    if (!d) { const b = Object.values(this.s.booked).find((x) => x.draftNumber === draftNumber); if (b) return { invoiceNumber: b.invoiceNumber, reused: true }; throw new Error('Kladde findes ikke'); }
    const invoiceNumber = this.s.seq.inv++;
    const total = d.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0);
    this.s.booked[invoiceNumber] = { invoiceNumber, draftNumber, total, gross: Math.round(total * 125) / 100, paid: 0 };
    delete this.s.drafts[draftNumber];
    return { invoiceNumber };
  }
  async getInvoiceStatus(invoiceNumber) {
    await this._net();
    const b = this.s.booked[invoiceNumber]; if (!b) throw new Error('Ukendt faktura');
    const remainder = Math.round((b.gross - b.paid) * 100) / 100;
    return { status: remainder <= 0 ? 'betalt' : 'åben', remainder, gross: b.gross };
  }
  /** Kun demo: simuler at kunden betaler (sker i virkeligheden i bank/e-conomic). */
  simulatePayment(invoiceNumber) { const b = this.s.booked[invoiceNumber]; if (b) b.paid = b.gross; }
}

/**
 * SmsProvider
 *  send({ to, text, clientRef }) -> { providerId, status }
 *  parseInbound(httpRequest) -> { providerId, from, text, at }   (verificér signatur!)
 *  parseStatus(httpRequest)  -> { providerId, status }
 *
 * Kandidat: GatewayAPI (dansk, EU) med lejet dansk nummer → kunden kan svare direkte.
 *  Afsender = nummer (ikke firmanavn), firmanavn skrives i teksten. Priser SKAL VERIFICERES.
 */
export class MockSms {
  constructor(state) { this.s = state; this.s.seq ||= 1; this.s.sentRefs ||= {}; }
  async send({ to, text, clientRef }) {
    if (this.s.sentRefs[clientRef]) return { providerId: this.s.sentRefs[clientRef], status: 'afsendt', reused: true };
    await new Promise((r) => setTimeout(r, 120));
    if (!/^\+\d{8,15}$/.test(to)) throw new Error('Ugyldigt nummer');
    const providerId = 'mock-' + this.s.seq++;
    this.s.sentRefs[clientRef] = providerId;
    return { providerId, status: 'afsendt' };
  }
}

/* ---------------- Kort ----------------
 * Gratis: links der åbner Google Maps-appen (ingen API-nøgle, ingen omkostning).
 * Betalt (senere, efter behov): Google Routes API / Route Optimization til køretider – SKAL VERIFICERES pris.
 */
export const mapsDirections = (addr) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}&travelmode=driving`;
export function mapsRoute(addrs) {
  if (!addrs.length) return null;
  const dest = addrs[addrs.length - 1]; const way = addrs.slice(0, -1).slice(0, 9); // Maps-URL tillader op til 9 waypoints
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving` + (way.length ? `&waypoints=${encodeURIComponent(way.join('|'))}` : '');
}
/** Gratis manuel SMS via egen telefon (svar lander på telefonen, ikke i appen). */
export const smsLink = (phone, text) => `sms:${phone}?&body=${encodeURIComponent(text)}`;

/** Simpel ruteforslag uden betalt API: nærmeste-nabo på koordinater (luftlinje). Kun forslag. */
export function suggestOrder(stops, start) {
  const rest = stops.filter((s) => s.lat != null); const none = stops.filter((s) => s.lat == null);
  const out = []; let cur = start || rest[0];
  const dist = (a, b) => { const R = 6371, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  let km = 0;
  while (rest.length) { let bi = 0; for (let i = 1; i < rest.length; i++) if (dist(cur, rest[i]) < dist(cur, rest[bi])) bi = i;
    km += cur === rest[bi] ? 0 : dist(cur, rest[bi]); cur = rest.splice(bi, 1)[0]; out.push(cur); }
  return { order: [...out, ...none], km: Math.round(km * 10) / 10 };
}
export function routeKm(stops) {
  let km = 0; for (let i = 1; i < stops.length; i++) { const a = stops[i - 1], b = stops[i]; if (a.lat == null || b.lat == null) continue;
    const t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
    km += 2 * 6371 * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2)); }
  return Math.round(km * 10) / 10;
}
