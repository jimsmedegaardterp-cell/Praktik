\set ON_ERROR_STOP 0
\set QUIET 1
-- helper to act as a user
create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select 'jim opretter firma' as t, public.create_org('Sindal Vinduespolering') is not null as ok;
select 'jim igen (skal fejle)' as t; select public.create_org('Andet');
\set orgq '(select org_id from members where user_id = ''00000000-0000-0000-0000-00000000000a'')'
insert into records(org_id, kind, id, data) select org_id, 'customer', 'c1', '{"name":"Test"}' from members where user_id = auth.uid();
insert into records(org_id, kind, id, data) select org_id, 'visit', 'v1', '{"status":"planlagt"}' from members where user_id = auth.uid();
select 'jim ser records' as t, count(*) from records;
select 'updated_by sat af db' as t, bool_and(updated_by = auth.uid()) from records;
select 'invitation' as t, length(public.create_invite((select org_id from members limit 1), 'medarbejder', 'e2', 'Mads')) = 8 as ok;
-- Mads indløser
reset role; select code from invites limit 1 \gset
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads ser invitationer' as t, count(*) from invites;
select 'mads ser intet før kode' as t, count(*) from records;
select 'mads indløser (små bogstaver)' as t, public.accept_invite(lower(:'code')) is not null;
reset role; select 'koden brugt' as t, used_by is not null from invites; set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select 'mads ser records' as t, count(*) from records;
update records set data = '{"status":"udfoert"}' where kind = 'visit' and id = 'v1';
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
