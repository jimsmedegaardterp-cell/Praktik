// Supabase Edge Function: sikker bro mellem appen og e-conomic (REST API).
// Nøglerne ligger KUN her som hemmeligheder (ECONOMIC_APP_SECRET, ECONOMIC_GRANT) – aldrig i browseren.
// Kun admin (med to-trinslogin, når det er slået til) må kalde funktionen, og kun med de handlinger der er listet nedenfor.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const API = 'https://restapi.e-conomic.com';
const ORIGINS = (Deno.env.get('APP_ORIGINS') || 'https://jimsmedegaardterp-cell.github.io,http://localhost:8765').split(',');

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ORIGINS.includes(origin) ? origin : ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});

class EcoError extends Error { constructor(msg: string, public status = 400, public detail: unknown = null) { super(msg); } }

async function eco(path: string, { method = 'GET', body, idem }: { method?: string; body?: unknown; idem?: string } = {}) {
  const app = Deno.env.get('ECONOMIC_APP_SECRET'), grant = Deno.env.get('ECONOMIC_GRANT');
  if (!app || !grant) throw new EcoError('e-conomic er ikke forbundet (hemmelighederne ECONOMIC_APP_SECRET/ECONOMIC_GRANT mangler i Supabase)', 412);
  const headers: Record<string, string> = { 'X-AppSecretToken': app, 'X-AgreementGrantToken': grant, 'Content-Type': 'application/json' };
  if (idem && method !== 'GET') headers['Idempotency-Key'] = idem.slice(0, 200);
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    // e-conomic fejl: { message, errors: { felt: { errors: [{ errorMessage }] } } } – saml til en læsbar tekst
    const msgs: string[] = [];
    const walk = (o: any) => { if (!o || typeof o !== 'object') return; if (o.errorMessage) msgs.push(o.errorMessage); for (const v of Object.values(o)) walk(v); };
    walk(data?.errors);
    throw new EcoError(`e-conomic ${r.status}: ${[data?.message, ...msgs].filter(Boolean).join(' · ') || text.slice(0, 300)}`, r.status >= 500 ? 502 : 400, data);
  }
  return data;
}
const all = async (path: string) => { const out: any[] = []; let url = path + (path.includes('?') ? '&' : '?') + 'pagesize=1000';
  for (let i = 0; i < 20 && url; i++) { const d = await eco(url); out.push(...(d.collection || [])); url = d.pagination?.nextPage ? d.pagination.nextPage.replace(API, '') : ''; } return out; };

const num = (v: unknown, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new EcoError(`Ugyldigt ${name}`); return n; };
const str = (v: unknown, max: number) => (v == null ? undefined : String(v).slice(0, max) || undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** Kundedata fra appen → e-conomic-felter (kun det nødvendige). */
function customerBody(c: any, s: any) {
  return clean({
    name: str(c.name, 255) || 'Uden navn', address: str(c.address, 510), zip: str(c.zip, 30), city: str(c.city, 50), country: 'Danmark',
    email: str(c.email, 255), mobilePhone: str(c.mobilePhone, 50), telephoneAndFaxNumber: str(c.phone, 255),
    corporateIdentificationNumber: str(c.cvr, 40), ean: str(c.ean, 13), currency: 'DKK',
    customerGroup: { customerGroupNumber: num(s.customerGroup, 'kundegruppe') }, paymentTerms: { paymentTermsNumber: num(s.paymentTerms, 'betalingsbetingelse') },
    vatZone: { vatZoneNumber: num(s.vatZone, 'momszone') }, layout: s.layout ? { layoutNumber: num(s.layout, 'layout') } : undefined,
  });
}

const OPS: Record<string, (p: any) => Promise<unknown>> = {
  /** Test forbindelsen */
  async ping() { const d = await eco('/self'); return { agreementNumber: d.agreementNumber, company: d.company?.name, userName: d.userName }; },
  /** Lister til opsætningen i appen */
  async options() {
    const [layouts, paymentTerms, vatZones, customerGroups, products, journals, accounts] = await Promise.all([
      all('/layouts'), all('/payment-terms'), all('/vat-zones'), all('/customer-groups'), all('/products'), all('/journals'), all('/accounts')]);
    const pick = (xs: any[], id: string, label = 'name') => xs.map((x) => ({ id: x[id], name: x[label] }));
    return { layouts: pick(layouts, 'layoutNumber'), paymentTerms: pick(paymentTerms, 'paymentTermsNumber'), vatZones: pick(vatZones, 'vatZoneNumber'),
      customerGroups: pick(customerGroups, 'customerGroupNumber'), products: products.map((x) => ({ id: x.productNumber, name: x.name, price: x.salesPrice })),
      journals: pick(journals, 'journalNumber'), accounts: accounts.filter((a) => a.accountType === 'status' || a.accountType === 'profitAndLoss').map((a) => ({ id: a.accountNumber, name: a.name, type: a.accountType })) };
  },
  /** Opret eller opdatér kunde. Bruger appens kundenummer, hvis det er et tal og ledigt/samme kunde. */
  async upsertCustomer({ customer, settings, number }) {
    const body = customerBody(customer, settings);
    if (number) { const n = num(number, 'kundenummer'); const cur = await eco(`/customers/${n}`); await eco(`/customers/${n}`, { method: 'PUT', body: { ...cur, ...body } }); return { customerNumber: n }; }
    const wanted = /^\d{1,9}$/.test(String(customer.customerNo || '')) ? Number(customer.customerNo) : undefined;
    if (wanted) {
      try { const cur = await eco(`/customers/${wanted}`); if ((cur.name || '').trim().toLowerCase() === (body.name as string).trim().toLowerCase()) { await eco(`/customers/${wanted}`, { method: 'PUT', body: { ...cur, ...body } }); return { customerNumber: wanted, linked: true }; } }
      catch (e) { if (!(e instanceof EcoError) || e.status !== 400 || !/404/.test(e.message)) throw e;
        const d = await eco('/customers', { method: 'POST', body: { ...body, customerNumber: wanted }, idem: `cust:${customer.id}` }); return { customerNumber: d.customerNumber }; }
    }
    const d = await eco('/customers', { method: 'POST', body, idem: `cust:${customer.id}` }); return { customerNumber: d.customerNumber };
  },
  /** Fakturakladde */
  async createDraft({ customerNumber, recipient, lines, reference, date, heading, settings, idem }) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 200) throw new EcoError('Ugyldige linjer');
    const body = clean({
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10), currency: 'DKK',
      customer: { customerNumber: num(customerNumber, 'kundenummer') }, paymentTerms: { paymentTermsNumber: num(settings.paymentTerms, 'betalingsbetingelse') },
      layout: { layoutNumber: num(settings.layout, 'layout') },
      recipient: clean({ name: str(recipient?.name, 250) || 'Kunde', address: str(recipient?.address, 250), zip: str(recipient?.zip, 50), city: str(recipient?.city, 250), vatZone: { vatZoneNumber: num(settings.vatZone, 'momszone') } }),
      references: clean({ other: str(reference, 250) }), notes: heading ? { heading: str(heading, 250) } : undefined,
      lines: lines.map((l: any, i: number) => clean({ lineNumber: i + 1, sortKey: i + 1, description: str(l.description, 2500) || 'Vinduespolering',
        quantity: Number(l.quantity) || 1, unitNetPrice: Math.round(Number(l.unitNetPrice) * 100) / 100, product: { productNumber: String(l.productNumber || settings.product) } })),
    });
    const d = await eco('/invoices/drafts', { method: 'POST', body, idem });
    return { draftNumber: d.draftInvoiceNumber, net: d.netAmount, gross: d.grossAmount };
  },
  /** Bogfør kladde (og send pr. mail, hvis valgt) */
  async book({ draftNumber, sendBy, idem }) {
    const n = num(draftNumber, 'kladdenummer');
    const body = clean({ draftInvoice: { draftInvoiceNumber: n }, sendBy: sendBy === 'Email' ? 'Email' : undefined });
    try { const d = await eco('/invoices/booked', { method: 'POST', body, idem }); return { invoiceNumber: d.bookedInvoiceNumber, gross: d.grossAmount, remainder: d.remainder }; }
    catch (e) {
      // allerede bogført (fx genforsøg efter netværksfejl) → find fakturaen via kladdens reference
      if (e instanceof EcoError && /404|not found|findes ikke/i.test(e.message)) return { alreadyBooked: true };
      throw e;
    }
  },
  /** Find bogført faktura ud fra vores reference (bruges hvis svar på bogføring gik tabt) */
  async findBooked({ reference }) {
    const d = await eco(`/invoices/booked?filter=references.other$eq:${encodeURIComponent(String(reference).slice(0, 250))}`);
    const x = d.collection?.[0]; return x ? { invoiceNumber: x.bookedInvoiceNumber, gross: x.grossAmount, remainder: x.remainder } : null;
  },
  /** Status (restbeløb) for bogførte fakturaer */
  async status({ numbers }) {
    if (!Array.isArray(numbers) || numbers.length > 200) throw new EcoError('Ugyldig liste');
    const out: Record<string, unknown> = {};
    for (const n of numbers) { try { const d = await eco(`/invoices/booked/${num(n, 'fakturanummer')}`); out[n] = { gross: d.grossAmount, remainder: d.remainder, dueDate: d.dueDate }; } catch (e) { out[n] = { error: (e as Error).message }; } }
    return out;
  },
  /** Betaling på stedet (kontant/MobilePay) → indbetaling i kassekladden (bogføres i e-conomic) */
  async payment({ journal, account, customerNumber, invoiceNumber, amount, date, text, idem }) {
    const d0 = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const body = { accountingYear: { year: d0.slice(0, 4) }, journal: { journalNumber: num(journal, 'kassekladde') },
      entries: { customerPayments: [clean({ customer: { customerNumber: num(customerNumber, 'kundenummer') }, customerInvoice: num(invoiceNumber, 'fakturanummer'),
        amount: Math.abs(Math.round(Number(amount) * 100) / 100), /* positivt som dokumentationens eksempel – SKAL VERIFICERES: kundens saldo skal falde */ contraAccount: { accountNumber: num(account, 'konto') }, currency: { code: 'DKK' }, date: d0, text: str(text, 250) })] } };
    const d = await eco(`/journals/${body.journal.journalNumber}/vouchers`, { method: 'POST', body, idem });
    return { voucher: Array.isArray(d) ? d[0]?.voucherNumber : d?.voucherNumber };
  },
};

Deno.serve(async (req) => {
  const h = { ...cors(req.headers.get('origin')), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  try {
    if (req.method !== 'POST') throw new EcoError('Kun POST', 405);
    // Hvem kalder? Brug brugerens egen session, så databasens adgangsregler (inkl. to-trinslogin) gælder.
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false } });
    const { data: u } = await sb.auth.getUser(); if (!u?.user) throw new EcoError('Ikke logget ind', 401);
    const { data: m } = await sb.from('members').select('org_id, role').eq('user_id', u.user.id).maybeSingle();
    if (!m) throw new EcoError('Ingen adgang', 403);
    const { data: ok } = await sb.rpc('is_admin', { o: m.org_id }); if (!ok) throw new EcoError('Kun admin (med to-trinslogin) kan bruge e-conomic', 403);
    const { op, ...p } = await req.json();
    const fn = OPS[op]; if (!fn) throw new EcoError('Ukendt handling', 400);
    return new Response(JSON.stringify({ ok: true, data: await fn(p) }), { headers: h });
  } catch (e) {
    const st = e instanceof EcoError ? e.status : 500;
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message, detail: e instanceof EcoError ? e.detail : null }), { status: 200, headers: { ...h, 'X-Status': String(st) } });
  }
});
