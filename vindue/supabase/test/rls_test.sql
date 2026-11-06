\set ON_ERROR_STOP 0
\set QUIET 1
-- helper to act as a user
create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select 'jim opretter firma' as t, public.create_org('Sindal Vinduespolering') is not null as ok;
select 'jim igen (skal fejle)' as t; select public.create_org('Andet');
\set orgq '(select org_id from members where user_id = ''00000000-0000-0000-0000-00000000000a'')'
insert into records(org_id, kind, id, data, emps) select org_id, 'customer', 'c1', '{"name":"Test"}', '{e2}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data, emps) select org_id, 'visit', 'v1', '{"status":"planlagt"}', '{e2}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data, emps) select org_id, 'customer', 'c9', '{"name":"Anden rute"}', '{e3}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data, emps) select org_id, 'visit', 'v9', '{"status":"planlagt"}', '{e3}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data, emps) select org_id, 'audit', 'a0', '{}', '{}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data, emps) select org_id, 'route', 'r1', '{}', null from members where user_id = auth.uid();
select 'jim ser records (6)' as t, count(*) from records;
select 'updated_by sat af db' as t, bool_and(updated_by = auth.uid()) from records;
select 'invitation' as t, length(public.create_invite((select org_id from members limit 1), 'medarbejder', 'e2', 'Mads')) = 8 as ok;
-- Mads indløser
reset role; select code from invites limit 1 \gset
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads ser invitationer' as t, count(*) from invites;
select 'mads ser intet før kode' as t, count(*) from records;
select 'mads indløser (små bogstaver)' as t, public.accept_invite(lower(:'code')) is not null;
reset role; select 'koden brugt' as t, used_by is not null from invites; set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads ser records (c1, v1, r1 = 3)' as t, count(*), string_agg(id, ',' order by id) from records;
update records set data = '{"status":"udfoert"}' where kind = 'visit' and id = 'v1';
update records set data = '{"status":"udfoert"}' where kind = 'visit' and id = 'v9';
reset role; select 'mads kan IKKE ændre besøg på anden rute' as t, data->>'status' from records where id = 'v9'; set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads flytter besøg væk fra sig selv (skal fejle)' as t; update records set emps = '{e3}' where id = 'v1';
select 'mads opretter besøg (upsert)' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'visit', 'v2', '{}', '{e2}' from members where user_id = auth.uid() on conflict (org_id, kind, id) do update set data = excluded.data, emps = excluded.emps;
select 'mads upsert egen auditpost' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'audit', 'a1', '{}', '{e2}' from members where user_id = auth.uid() on conflict (org_id, kind, id) do update set data = excluded.data, emps = excluded.emps;
select 'mads overskriver admins auditpost (skal fejle)' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'audit', 'a0', '{"x":1}', '{}' from members where user_id = auth.uid() on conflict (org_id, kind, id) do update set data = excluded.data, emps = excluded.emps;
select 'mads besøg på anden rute (skal fejle)' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'visit', 'v3', '{}', '{e3}' from members where user_id = auth.uid();
reset role; select 'efter mads' as t, string_agg(id || ':' || coalesce(data::text, ''), ' ' order by id) from records; set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads kan opdatere besøg' as t, data->>'status' from records where id = 'v1';
update records set data = '{"name":"Hacket"}' where kind = 'customer' and id = 'c1';
select 'mads kan IKKE ændre kunde' as t, data->>'name' from records where id = 'c1';
select 'mads indsætter kunde (skal fejle)' as t; insert into records(org_id, kind, id, data) select org_id, 'customer', 'c2', '{}' from members where user_id = auth.uid();
select 'mads laver invitation (skal fejle)' as t; select public.create_invite((select org_id from members limit 1), 'admin', null, null);
select 'mads gør sig selv admin (skal ikke virke)' as t; update members set role = 'admin' where user_id = auth.uid();
select 'mads rolle' as t, role from members where user_id = auth.uid();
delete from records;
select 'mads kan ikke slette' as t, count(*) from records;
-- fremmed
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select 'fremmed ser records' as t, count(*) from records;
select 'fremmed ser members' as t, count(*) from members;
select 'fremmed indløser brugt kode (skal fejle)' as t; select public.accept_invite(:'code');
select 'fremmed skriver i andres firma (skal fejle)' as t; insert into records(org_id, kind, id, data) values ((select id from orgs limit 1), 'customer', 'x', '{}');
select 'fremmed opretter eget firma' as t, public.create_org('Andet firma') is not null;
select 'fremmed ser stadig kun eget' as t, count(*) from records;
-- anon
reset role; set role anon; select pg_temp.as_user('');
select 'anon læser (skal fejle)' as t; select count(*) from records;

-- To-trinslogin
reset role; insert into auth.mfa_factors(user_id, status) values ('00000000-0000-0000-0000-00000000000a', 'verified');
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a'); select set_config('request.jwt.claims', '{"aal":"aal1"}', false);
select 'jim med MFA, uden kode: ser records (0)' as t, count(*) from records;
select 'jim uden kode: ser members (0)' as t, count(*) from members;
select 'jim uden kode skriver (skal fejle)' as t; insert into records(org_id, kind, id, data) values ((select id from orgs where name = 'Sindal Vinduespolering'), 'customer', 'cx', '{}');
select 'jim uden kode laver invitation (skal fejle)' as t; select public.create_invite((select id from orgs where name = 'Sindal Vinduespolering'), 'admin', null, null);
select set_config('request.jwt.claims', '{"aal":"aal2"}', false);
select 'jim med kode: ser records' as t, count(*) > 0 from records;
insert into records(org_id, kind, id, data) select org_id, 'customer', 'cx', '{}' from members where user_id = auth.uid();
select 'jim med kode skriver' as t, count(*) from records where id = 'cx';
select 'mads uden MFA påvirkes ikke' as t; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b'); select set_config('request.jwt.claims', '{"aal":"aal1"}', false);
select 'mads ser stadig egne' as t, count(*) from records;

-- Medarbejdernoter (kind = note)
reset role; set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b'); select set_config('request.jwt.claims', '{"aal":"aal1"}', false);
select 'mads skriver note til egen kunde' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'note', 'n1', '{"text":"Hund"}', '{e2}' from members where user_id = auth.uid();
select 'mads note til anden rute (skal fejle)' as t; insert into records(org_id, kind, id, data, emps) select org_id, 'note', 'n2', '{}', '{e3}' from members where user_id = auth.uid();
reset role; select 'noter i db' as t, string_agg(id, ',') from records where kind = 'note';
