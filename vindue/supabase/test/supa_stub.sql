create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','jim@test.dk'),('00000000-0000-0000-0000-00000000000b','mads@test.dk'),('00000000-0000-0000-0000-00000000000c','fremmed@test.dk');
