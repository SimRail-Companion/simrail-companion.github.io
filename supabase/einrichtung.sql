-- SimRail Companion – Einrichtung der Datenbank in Supabase
-- ===========================================================
-- Einmal im Supabase-Dashboard ausführen: SQL Editor -> "New query" ->
-- diesen Text einfügen -> "Run". Kann gefahrlos mehrfach ausgeführt werden.
--
-- Je Konto gibt es genau EINE Zeile mit dem Fortschritt (alle "simrail_..."-
-- Einträge der App als JSON). Die Zeilen-Regeln (Row Level Security) sorgen
-- dafür, dass jeder Spieler nur seine eigene Zeile lesen und ändern kann.

create table if not exists public.fortschritt (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  daten      jsonb       not null default '{}'::jsonb,
  version    integer     not null default 0,
  geaendert  timestamptz not null default now()
);

alter table public.fortschritt enable row level security;

drop policy if exists "fortschritt lesen"   on public.fortschritt;
drop policy if exists "fortschritt anlegen" on public.fortschritt;
drop policy if exists "fortschritt aendern" on public.fortschritt;

create policy "fortschritt lesen"   on public.fortschritt for select
  using (auth.uid() = user_id);
create policy "fortschritt anlegen" on public.fortschritt for insert
  with check (auth.uid() = user_id);
create policy "fortschritt aendern" on public.fortschritt for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Änderungen einspielen: Die App schickt nur, was sich geändert hat
-- ({"simrail_fahrten": "...", "simrail_home": null, ...}; null = löschen).
-- Mit ersetzen = true wird der ganze Stand ersetzt (neues Konto übernimmt
-- den Gast-Fortschritt). Rückgabe: neue Versionsnummer.
create or replace function public.fortschritt_aendern(aenderungen jsonb, ersetzen boolean default false)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  neu jsonb;
  v   integer;
begin
  if auth.uid() is null then
    raise exception 'nicht angemeldet';
  end if;
  if jsonb_typeof(aenderungen) <> 'object' then
    raise exception 'ungültige Daten';
  end if;
  if octet_length(aenderungen::text) > 5 * 1024 * 1024 then
    raise exception 'zu viele Daten';
  end if;

  insert into fortschritt (user_id) values (auth.uid()) on conflict (user_id) do nothing;

  select case when ersetzen then '{}'::jsonb else daten end
    into neu
    from fortschritt where user_id = auth.uid()
    for update;

  -- zusammenführen; Einträge mit null fallen weg (= gelöscht)
  neu := jsonb_strip_nulls(neu || aenderungen);
  if octet_length(neu::text) > 5 * 1024 * 1024 then
    raise exception 'Spielstand zu groß';
  end if;

  update fortschritt
     set daten = neu, version = version + 1, geaendert = now()
   where user_id = auth.uid()
  returning version into v;
  return v;
end;
$$;

revoke all on function public.fortschritt_aendern(jsonb, boolean) from public, anon;
grant execute on function public.fortschritt_aendern(jsonb, boolean) to authenticated;
