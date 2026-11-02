# Arbejdsregler (Sindal Vinduespolering-appen i vindue/)

- Svar på dansk, kort og præcist.
- Claude merger selv sine PR'er, når tests er grønne – brugeren merger ikke.
  Undtagelse: kræver PR'en at `vindue/supabase/schema.sql` køres i Supabase, så skal brugeren køre SQL'en FØR merge (medmindre ændringen er bagudkompatibel – skriv det).
- Brug aldrig service_role/secret-nøgler. Læg aldrig rigtige kundedata/PDF'er i repoet.
- Bump `?v=N` i vindue/index.html og `VERSION` i vindue/js/app.js ved hver ændring.
