// Forbindelse til den fælles database (Supabase, EU).
// "anonKey" er den OFFENTLIGE nøgle (anon/publishable) – den må gerne ligge her; adgang styres af reglerne i supabase/schema.sql.
// Læg ALDRIG "service_role"-nøglen her.
// Tom url = appen kører kun lokalt i browseren (som før). url "memory" = testdatabase i browseren.
export const SUPABASE = { url: '', anonKey: '' };
