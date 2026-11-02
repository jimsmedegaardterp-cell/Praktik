# Arbejdsregler (Sindal Vinduespolering-appen i vindue/)

- Svar på dansk, kort og præcist.
- Spørgsmål stilles i chatten som nummererede lister med bogstav-svarmuligheder (1a, 1b, 2a …), så brugeren kan svare frit og tilføje/rette – brug ikke klik-dialogen (AskUserQuestion).
- Claude merger selv sine PR'er, når tests er grønne – brugeren merger ikke.
  Undtagelse: kræver PR'en at `vindue/supabase/schema.sql` køres i Supabase, så skal brugeren køre SQL'en FØR merge (medmindre ændringen er bagudkompatibel – skriv det).
- Brug aldrig service_role/secret-nøgler. Læg aldrig rigtige kundedata/PDF'er i repoet.
- Bump `?v=N` i vindue/index.html og `VERSION` i vindue/js/app.js ved hver ændring.
