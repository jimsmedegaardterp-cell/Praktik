// Fiktive testdata (ingen rigtige kunder). Bynavne i Vendsyssel, men personer og adresser er opdigtede.
import { emptyDb, planAhead, uid } from './services.js';
import { addDays, weekday, nextRouteDate } from './domain.js';

export const DEFAULT_TEMPLATES = {
  varsel: 'Hej {navn}. Vi kommer og pudser dine vinduer i morgen ({dato}). Svar på denne SMS hvis det ikke passer. Mvh. Sindal Vinduespolering',
  forsinket: 'Hej {navn}. Vi er lidt forsinket i dag og forventer at være hos dig ca. kl. {tid}. Mvh. Sindal Vinduespolering',
  aflyst: 'Hej {navn}. Vi må desværre flytte besøget {dato}. Vi kommer i stedet {nydato}. Mvh. Sindal Vinduespolering',
};
/** Tom database til rigtige data: kun ejeren som bruger, ingen kunder/ruter. */
export function freshDb() {
  const db = emptyDb();
  db.employees = [{ id: 'e1', name: 'Jim (ejer)', role: 'admin', commissionRate: 0 }];
  db.templates = { ...DEFAULT_TEMPLATES };
  db.settings.realData = true;
  return db;
}

export function seedDb(todayIso) {
  const db = emptyDb();
  db.employees = [
    { id: 'e1', name: 'Jim (ejer)', role: 'admin', commissionRate: 0 },
    { id: 'e2', name: 'Mads', role: 'medarbejder' },
  ];
  // Ruter: egen rytme + næste dato (som "faste ruter" i SkvizBiz)
  const mon = addDays(todayIso, -weekday(todayIso));
  db.routes = [
    { id: 'r1', name: 'Sindal', employeeId: 'e2', intervalWeeks: 4, anchorDate: addDays(mon, 7) },
    { id: 'r2', name: 'Hjørring', employeeId: 'e2', intervalWeeks: 4, anchorDate: addDays(mon, 8) },
    { id: 'r3', name: 'Bindslev', employeeId: 'e1', intervalWeeks: 4, anchorDate: addDays(mon, 9) },
    { id: 'r4', name: 'Lønstrup', employeeId: 'e2', intervalWeeks: 4, anchorDate: addDays(mon, 0) },
    { id: 'r5', name: 'Erhverv', employeeId: 'e1', intervalWeeks: 2, anchorDate: addDays(mon, 4) },
  ];
  const raw = [
    // navn, mobil, adresse, lat, lng, opgave, pris, interval, rute, min, bemærkning
    ['Hanne Testesen', '20 11 22 33', 'Prøvevej 4, 9870 Sindal', 57.471, 10.205, 'Vinduesvask', 228, 4, 'r1', 25, 'Alt på huset og udestuen'],
    ['Peter Demo', '21 44 55 66', 'Eksempelgade 12, 9870 Sindal', 57.468, 10.199, 'Vinduesvask', 216, 4, 'r1', 20, 'Alt udvendigt'],
    ['Lise & Ole Fiktiv', '22 77 88 99', 'Opdigtet Allé 7, 9870 Sindal', 57.474, 10.212, 'Vinduesvask', 272, 8, 'r1', 30, 'Ring 30 min før'],
    ['Karen Prøve', '23 12 34 56', 'Testparken 30, 9870 Sindal', 57.466, 10.190, 'Vinduesvask', 188, 4, 'r1', 17, 'Parkér på bagsiden'],
    ['Bente Udkast', '24 98 76 54', 'Skitsevej 101, 9800 Hjørring', 57.458, 9.985, 'Vinduesvask', 164, 4, 'r2', 17, 'Kode til låge 1234'],
    ['Thomas Model', '25 55 44 33', 'Mønstergade 15, 9800 Hjørring', 57.462, 9.975, 'Vinduesvask', 308, 8, 'r2', 19, 'Alt på stuehuset'],
    ['Anne Kladde', '26 66 77 88', 'Udkastvej 3, 9800 Hjørring', 57.455, 9.995, 'Vinduesvask', 176, 4, 'r2', 15, 'Kun forside'],
    ['Søren Skabelon', '27 11 00 22', 'Formvej 9, 9881 Bindslev', 57.541, 10.200, 'Vinduesvask', 232, 4, 'r3', 15, ''],
    ['Grethe Attrap', '28 22 11 33', 'Kopivej 2, 9881 Bindslev', 57.545, 10.210, 'Vinduesvask', 252, 8, 'r3', 40, 'Minus gavlen med ét lags glas'],
    ['Inger Pilot', '29 33 22 44', 'Strandprøven 60, 9800 Lønstrup', 57.478, 9.800, 'Vinduesvask', 228, 4, 'r4', 25, 'Alt på huset og galleriet'],
    ['Kim Forsøg', '30 44 33 55', 'Klitudkast 12, 9800 Lønstrup', 57.481, 9.806, 'Vinduesvask', 216, 4, 'r4', 20, 'Pas på, der kommer vand ind foroven'],
    ['Fiktiv Tandklinik ApS', '96 00 00 01', 'Torvet 1, 9800 Hjørring', 57.457, 9.982, 'Butiksruder', 390, 2, 'r5', 30, 'Før kl. 8'],
    ['Café Prøvehavn', '96 00 00 02', 'Havnen 2, 9850 Hirtshals', 57.592, 9.962, 'Butiksruder', 280, 2, 'r5', 20, ''],
  ];
  for (const [name, phone, street, lat, lng, service, price, interval, routeId, dur, access] of raw) {
    const cid = uid('c'), aid = uid('adr');
    const route = db.routes.find((r) => r.id === routeId);
    const anchor = nextRouteDate(route, addDays(todayIso, -28));
    db.customers.push({ id: cid, customerNo: String(61000000 + db.customers.length * 1117), name, phone, email: '', notes: '', vatLiable: true, paymentTerms: 'Netto 8 dage',
      paymentMethod: ['bank', 'mobilepay', 'betalingsservice', 'kontant'][db.customers.length % 4], marketingConsent: false,
      group: /ApS|Café/.test(name) ? 'Erhverv' : 'Privat kunder', invoiceType: db.customers.length % 5 === 3 ? 'sms' : 'email', invoiceInterval: 'besoeg', paymentDays: 8,
      smsBefore: db.customers.length % 2 === 0, callBefore: /Ring/.test(access), rememberNext: db.customers.length === 1 ? 'Kunden vil have pudset kælderruder med – aftal pris' : '' });
    db.addresses.push({ id: aid, customerId: cid, street, lat, lng, access });
    db.agreements.push({ id: uid('ag'), customerId: cid, addressId: aid, routeId, service, price, intervalWeeks: interval, durationMin: dur, anchorDate: anchor, seasonMonths: [], active: true });
  }
  // Kunde med to adresser og to aftaler (accepttest 3)
  const c = db.customers[0]; const a2 = uid('adr');
  db.addresses.push({ id: a2, customerId: c.id, street: 'Sommerhusprøven 9, 9850 Hirtshals', lat: 57.585, lng: 9.95, access: 'Sommerhus – nøgle i skuret' });
  db.agreements.push({ id: uid('ag'), customerId: c.id, addressId: a2, routeId: 'r5', service: 'Vinduesvask sommerhus', price: 400, intervalWeeks: 12, durationMin: 35,
    anchorDate: nextRouteDate(db.routes[4], todayIso), seasonMonths: [4, 5, 6, 7, 8, 9, 10, 11], active: true });
  // "Ikke fast"-kunde
  const cf = uid('c'), af = uid('adr');
  db.customers.push({ id: cf, customerNo: '61999999', name: 'Ole Tilkald', phone: '31 00 99 88', email: '', notes: 'Ringer selv når der skal pudses', vatLiable: true, paymentTerms: 'Netto 8 dage', paymentMethod: 'mobilepay', marketingConsent: false });
  db.addresses.push({ id: af, customerId: cf, street: 'Efteraftalevej 5, 9870 Sindal', lat: 57.47, lng: 10.22, access: '' });
  db.agreements.push({ id: uid('ag'), customerId: cf, addressId: af, routeId: null, service: 'Vinduesvask', price: 450, intervalWeeks: 0, durationMin: 45, anchorDate: todayIso, seasonMonths: [], active: true });

  db.templates = {
    varsel: 'Hej {navn}. Vi kommer og pudser dine vinduer i morgen ({dato}). Svar på denne SMS hvis det ikke passer. Mvh. Sindal Vinduespolering',
    forsinket: 'Hej {navn}. Vi er lidt forsinket i dag og forventer at være hos dig ca. kl. {tid}. Mvh. Sindal Vinduespolering',
    aflyst: 'Hej {navn}. Vi må desværre aflyse besøget {dato} pga. vejret. Vi kommer {nydato}. Mvh. Sindal Vinduespolering',
  };
  planAhead(db, addDays(todayIso, 120), addDays(todayIso, -28));
  return db;
}
