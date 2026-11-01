// Fiktive testdata (ingen rigtige kunder). Koordinater omkring Silkeborg.
import { emptyDb, planAhead, uid } from './services.js';
import { addDays, weekday, nextRouteDate } from './domain.js';

export function seedDb(todayIso) {
  const db = emptyDb();
  db.employees = [
    { id: 'e1', name: 'Jim (ejer)', role: 'admin' },
    { id: 'e2', name: 'Mads', role: 'medarbejder' },
  ];
  db.settings.cycleWeeks = 4;
  db.settings.cycleStart = addDays(todayIso, -weekday(todayIso) - 7); // forrige mandag = uge 1
  db.routes = [
    { id: 'r1', name: 'Rute 1 – Silkeborg Nord', employeeId: 'e2', weekday: 0, cycleWeek: 1 },
    { id: 'r2', name: 'Rute 2 – Silkeborg Syd', employeeId: 'e2', weekday: 0, cycleWeek: 2 },
    { id: 'r4', name: 'Rute 4 – Them/Ry', employeeId: 'e2', weekday: 2, cycleWeek: 3 },
    { id: 'r3', name: 'Rute 3 – Erhverv', employeeId: 'e1', weekday: 4, cycleWeek: null },
  ];
  const raw = [
    ['Hanne Jensen', '20 11 22 33', 'Nørrevænget 4, 8600 Silkeborg', 56.180, 9.552, 'Vinduespudsning ud/ind', 450, 8, 'r1', 'Nøgle under potte. Hund i haven.'],
    ['Peter Holm', '21 44 55 66', 'Vestergade 12, 8600 Silkeborg', 56.170, 9.540, 'Vinduespudsning ude', 275, 4, 'r1', ''],
    ['Lise & Ole Mortensen', '22 77 88 99', 'Ålykkevej 7, 8600 Silkeborg', 56.185, 9.560, 'Vinduespudsning ude', 325, 8, 'r1', 'Ring 30 min før'],
    ['Karen Bach', '23 12 34 56', 'Christian 8.s Vej 30, 8600 Silkeborg', 56.172, 9.565, 'Vinduespudsning ud/ind', 520, 12, 'r1', ''],
    ['Bente Lund', '24 98 76 54', 'Ansvej 101, 8600 Silkeborg', 56.155, 9.530, 'Vinduespudsning ude', 300, 4, 'r2', 'Kode til port 1234'],
    ['Thomas Skov', '25 55 44 33', 'Viborgvej 15, 8600 Silkeborg', 56.150, 9.520, 'Vinduespudsning + rammer', 640, 8, 'r2', ''],
    ['Anne Vestergaard', '26 66 77 88', 'Søndergade 3, 8600 Silkeborg', 56.165, 9.548, 'Vinduespudsning ude', 250, 8, 'r2', 'Kun forside'],
    ['Silkeborg Tandklinik ApS', '86 82 00 00', 'Torvet 1, 8600 Silkeborg', 56.169, 9.549, 'Butiksruder', 890, 1, 'r3', 'Før kl. 8'],
    ['Café Søen', '86 81 11 11', 'Havnen 2, 8600 Silkeborg', 56.167, 9.556, 'Butiksruder', 380, 2, 'r3', ''],
  ];
  // anker = førstkommende rutedag fra i dag minus et par uger, så der også er historik
  for (const [name, phone, street, lat, lng, service, price, interval, routeId, access] of raw) {
    const cid = uid('c'), aid = uid('adr'), agid = uid('ag');
    const route = db.routes.find((r) => r.id === routeId);
    const anchor = nextRouteDate(route, addDays(todayIso, -14), db.settings);
    db.customers.push({ id: cid, name, phone, email: '', invoiceEmail: '', notes: '', vatLiable: true, paymentTerms: 'Netto 8 dage', paymentMethod: ['bank', 'mobilepay', 'betalingsservice', 'kontant'][db.customers.length % 4], marketingConsent: false });
    db.addresses.push({ id: aid, customerId: cid, street, lat, lng, access });
    db.agreements.push({ id: agid, customerId: cid, addressId: aid, routeId, service, price, intervalWeeks: interval, anchorDate: anchor, seasonMonths: interval >= 8 ? [3, 4, 5, 6, 7, 8, 9, 10, 11] : [], active: true });
  }
  // Kunde med to adresser og to aftaler (accepttest 3)
  const c = db.customers[0]; const a2 = uid('adr');
  db.addresses.push({ id: a2, customerId: c.id, street: 'Sommerhusvej 9, 8680 Ry', lat: 56.09, lng: 9.76, access: 'Sommerhus' });
  const anchor = nextRouteDate(db.routes.find((r) => r.id === 'r4'), todayIso, db.settings);
  db.agreements.push({ id: uid('ag'), customerId: c.id, addressId: a2, routeId: 'r4', service: 'Vinduespudsning sommerhus', price: 600, intervalWeeks: 12, anchorDate: anchor, seasonMonths: [4, 5, 6, 7, 8, 9], active: true });

  db.templates = {
    varsel: 'Hej {navn}. Vi kommer og pudser dine vinduer i morgen ({dato}). Svar på denne SMS hvis det ikke passer. Mvh. Vinduespudseren',
    forsinket: 'Hej {navn}. Vi er lidt forsinket i dag og forventer at være hos dig ca. kl. {tid}. Mvh. Vinduespudseren',
    aflyst: 'Hej {navn}. Vi må desværre aflyse besøget {dato} pga. vejret. Vi kommer {nydato}. Mvh. Vinduespudseren',
  };
  planAhead(db, addDays(todayIso, 120), addDays(todayIso, -14));
  return db;
}
