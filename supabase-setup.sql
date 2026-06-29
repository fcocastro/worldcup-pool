-- ===========================================================================
-- World Cup Family Pool — Supabase schema
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run
-- ===========================================================================

-- Players: name + a soft PIN (so people can't overwrite each other's picks) +
-- their tiebreaker guess (total goals in both semifinals + the final).
create table if not exists players (
  name        text primary key,
  pin         text not null,
  tiebreaker  integer
);

-- One row per (player, match) — the team that player picked to win that match.
create table if not exists picks (
  player     text not null references players(name) on delete cascade,
  match_id   integer not null,
  pick       text not null,
  updated_at timestamptz default now(),
  primary key (player, match_id)
);

-- One row per match: who won and the score. Filled by the API action or admin.
create table if not exists results (
  match_id  integer primary key,
  winner    text,
  score_a   integer,
  score_b   integer,
  updated_at timestamptz default now()
);

-- Per-match pick lock, toggled by the commissioner in the Admin tab. A row with
-- locked = true means players can no longer change their pick for that match.
create table if not exists match_locks (
  match_id integer primary key,
  locked   boolean not null default true
);

-- Full tournament match history (group stage + knockouts), used for the
-- hover-over-a-team game history. Populated by the GitHub Action from the API.
create table if not exists games (
  id          text primary key,   -- the API's match id
  utc_date    text,
  stage       text,               -- GROUP_STAGE, LAST_16, QUARTER_FINALS, ...
  home        text,
  away        text,
  home_score  integer,
  away_score  integer,
  status      text
);

-- ---------------------------------------------------------------------------
-- Row Level Security. This is a family pool, so we allow the public anon key
-- to read/write. The PINs (checked in the browser) are the soft guardrail.
-- The GitHub Action uses the service_role key, which bypasses RLS entirely.
-- ---------------------------------------------------------------------------
alter table players enable row level security;
alter table picks   enable row level security;
alter table results enable row level security;
alter table games   enable row level security;
alter table match_locks enable row level security;

-- (drop-before-create so this whole file is safe to re-run)
drop policy if exists "anon read players"   on players;
drop policy if exists "anon write players"  on players;
drop policy if exists "anon update players" on players;
drop policy if exists "anon delete players" on players;
create policy "anon read players"   on players for select using (true);
create policy "anon write players"  on players for insert with check (true);
create policy "anon update players" on players for update using (true) with check (true);
create policy "anon delete players" on players for delete using (true);

drop policy if exists "anon read picks"    on picks;
drop policy if exists "anon write picks"   on picks;
drop policy if exists "anon update picks"  on picks;
drop policy if exists "anon delete picks"  on picks;
create policy "anon read picks"    on picks for select using (true);
create policy "anon write picks"   on picks for insert with check (true);
create policy "anon update picks"  on picks for update using (true) with check (true);
create policy "anon delete picks"  on picks for delete using (true);

drop policy if exists "anon read results"   on results;
drop policy if exists "anon write results"  on results;
drop policy if exists "anon update results" on results;
create policy "anon read results"   on results for select using (true);
create policy "anon write results"  on results for insert with check (true);
create policy "anon update results" on results for update using (true) with check (true);

drop policy if exists "anon read games" on games;
create policy "anon read games" on games for select using (true);

drop policy if exists "anon read locks"   on match_locks;
drop policy if exists "anon write locks"  on match_locks;
drop policy if exists "anon update locks" on match_locks;
create policy "anon read locks"   on match_locks for select using (true);
create policy "anon write locks"  on match_locks for insert with check (true);
create policy "anon update locks" on match_locks for update using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Seed the two Round-of-32 results that were already final at setup time.
-- (Delete these two lines if you'd rather start clean.)
-- ---------------------------------------------------------------------------
insert into results (match_id, winner, score_a, score_b) values
  (73, 'Canada', 1, 0),
  (76, 'Brazil', 2, 1)
on conflict (match_id) do nothing;
