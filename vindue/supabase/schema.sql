-- Sindal Vinduespolering – databaseskema til Supabase (PostgreSQL).
-- Kør hele filen i Supabase → SQL Editor. Kan køres igen uden at slette data.
--
-- Model: appen arbejder lokalt og synkroniserer "records" (én række pr. kunde, adresse, aftale, rute, besøg …).
-- Adgang styres med Row Level Security:
--   * kun medlemmer af et firma (org) kan læse dets data; medarbejdere kun poster med deres id i emps
--     (kunder/besøg på egne ruter – emps beregnes af appen, se scoper() i js/sync.js)
--   * admin kan ændre alt; medarbejder kan kun ændre besøg, kladder, SMS-log og auditlog
--   * nye brugere kommer ind med en invitationskode, som admin laver i appen

create extension if not exists pgcrypto;

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('admin', 'medarbejder')),
  employee_id text,
  email text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.invites (
  code text primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  role text not null default 'medarbejder' check (role in ('admin', 'medarbejder')),
  employee_id text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_by uuid,
  used_at timestamptz
);

create table if not exists public.records (
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (org_id, kind, id)
);
create index if not exists records_org_updated_idx on public.records(org_id, updated_at);
-- Hvilke medarbejdere (ud over admin) må se posten: null = alle i firmaet, {} = kun admin
alter table public.records add column if not exists emps text[];

-- Tidsstempel og bruger sættes altid af databasen (kan ikke forfalskes af klienten)
create or replace function public.records_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records for each row execute function public.records_touch();

-- Hjælpefunktioner til adgangsregler (security definer, så de kan læse members uden rekursion)
create or replace function public.is_member(o uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where org_id = o and user_id = auth.uid())
$$;
create or replace function public.is_admin(o uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where org_id = o and user_id = auth.uid() and role = 'admin')
$$;
-- Den indloggede brugers medarbejder-id i firmaet
create or replace function public.my_employee(o uuid) returns text language sql stable security definer set search_path = public as $$
  select employee_id from public.members where org_id = o and user_id = auth.uid()
$$;
-- Hvilke typer data en medarbejder må skrive
create or replace function public.employee_may_write(k text) returns boolean language sql immutable as $$
  select k in ('visit', 'vdraft', 'sms', 'audit')
$$;

alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.records enable row level security;

drop policy if exists orgs_select on public.orgs;
create policy orgs_select on public.orgs for select to authenticated using (public.is_member(id));
drop policy if exists orgs_update on public.orgs;
create policy orgs_update on public.orgs for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated using (public.is_member(org_id));
drop policy if exists members_admin_update on public.members;
create policy members_admin_update on public.members for update to authenticated using (public.is_admin(org_id)) with check (public.is_admin(org_id));
drop policy if exists members_admin_delete on public.members;
create policy members_admin_delete on public.members for delete to authenticated using (public.is_admin(org_id) and user_id <> auth.uid());

drop policy if exists invites_admin_all on public.invites;
create policy invites_admin_all on public.invites for all to authenticated using (public.is_admin(org_id)) with check (public.is_admin(org_id));

drop policy if exists records_select on public.records;
create policy records_select on public.records for select to authenticated
  using (public.is_admin(org_id) or (public.is_member(org_id) and (emps is null or public.my_employee(org_id) = any(emps))));
drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert to authenticated
  with check (public.is_admin(org_id) or (public.is_member(org_id) and public.employee_may_write(kind)
    and public.my_employee(org_id) = any(emps)));
drop policy if exists records_update on public.records;
create policy records_update on public.records for update to authenticated
  using (public.is_admin(org_id) or (public.is_member(org_id) and public.employee_may_write(kind) and (emps is null or public.my_employee(org_id) = any(emps))))
  with check (public.is_admin(org_id) or (public.is_member(org_id) and public.employee_may_write(kind)
    and public.my_employee(org_id) = any(emps)));
-- Ingen DELETE-politik: sletning sker som "deleted = true", så historikken kan genskabes.

grant usage on schema public to authenticated;
grant select, update on public.orgs to authenticated;
grant select, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.invites to authenticated;
grant select, insert, update on public.records to authenticated;

-- Opret firma: den første bruger bliver admin. En bruger kan kun være med i ét firma.
create or replace function public.create_org(org_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare o uuid; e text;
begin
  if auth.uid() is null then raise exception 'Ikke logget ind'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'Du er allerede med i et firma'; end if;
  insert into public.orgs(name) values (coalesce(nullif(trim(org_name), ''), 'Mit firma')) returning id into o;
  select email into e from auth.users where id = auth.uid();
  insert into public.members(org_id, user_id, role, employee_id, email) values (o, auth.uid(), 'admin', 'e1', e);
  return o;
end $$;

-- Admin laver en invitationskode (8 tegn, uden forvekslelige tegn)
create or replace function public.create_invite(o uuid, r text, emp text, n text default null) returns text language plpgsql security definer set search_path = public as $$
declare c text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  if not public.is_admin(o) then raise exception 'Kun admin kan invitere'; end if;
  if r not in ('admin', 'medarbejder') then raise exception 'Ugyldig rolle'; end if;
  loop
    c := '';
    for i in 1..8 loop c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.invites where code = c);
  end loop;
  insert into public.invites(code, org_id, role, employee_id, note, created_by) values (c, o, r, emp, n, auth.uid());
  return c;
end $$;

-- Ny bruger indløser kode → bliver medlem med den rolle/medarbejder, admin valgte
create or replace function public.accept_invite(invite_code text) returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.invites; e text;
begin
  if auth.uid() is null then raise exception 'Ikke logget ind'; end if;
  select * into inv from public.invites where code = upper(trim(invite_code)) for update;
  if not found then raise exception 'Ukendt kode'; end if;
  if inv.used_at is not null then raise exception 'Koden er allerede brugt'; end if;
  if inv.expires_at < now() then raise exception 'Koden er udløbet'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'Du er allerede med i et firma'; end if;
  select email into e from auth.users where id = auth.uid();
  insert into public.members(org_id, user_id, role, employee_id, email) values (inv.org_id, auth.uid(), inv.role, inv.employee_id, e);
  update public.invites set used_by = auth.uid(), used_at = now() where code = inv.code;
  return inv.org_id;
end $$;

revoke all on function public.create_org(text) from public;
revoke all on function public.create_invite(uuid, text, text, text) from public;
revoke all on function public.accept_invite(text) from public;
grant execute on function public.create_org(text) to authenticated;
grant execute on function public.create_invite(uuid, text, text, text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.my_employee(uuid) to authenticated;
