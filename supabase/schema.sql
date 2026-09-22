-- =========================================================
-- So You Want To Be A Detective — database schema.
--
-- Run this ONCE in Supabase Dashboard > SQL Editor > New query.
-- Safe to re-run: every statement is idempotent.
--
-- You only need this if you want players answering on their own
-- phones. Without it the app runs in local mode, where the host
-- drives a projector from one machine and keeps score by hand.
--
-- The security model in one paragraph: the anon key that ships
-- in the browser can read a running session's public state and
-- can insert its own team and its own answers. It CANNOT read
-- the quizzes table, so it cannot read the questions or their
-- answers ahead of time, and it cannot set the points on an
-- answer, so it cannot award itself a score. Writing quizzes and
-- marking answers both require a logged-in host.
-- =========================================================


-- ---------------------------------------------------------
-- 1. Quizzes — the case files, including the answers.
--    Never readable with the anon key.
-- ---------------------------------------------------------
create table if not exists quiz_quizzes (
  id          text primary key,
  title       text not null default 'Untitled case',
  data        jsonb not null,            -- the whole quiz document
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists quiz_quizzes_updated_idx
  on quiz_quizzes (updated_at desc);


-- ---------------------------------------------------------
-- 2. Sessions — one running show.
--    `state` is the redacted public blob the host pushes. It is
--    world-readable by design: the projection screen, the
--    leaderboard and every player device render it. The host
--    only ever puts a correct answer in it once the show has
--    reached that question's reveal.
-- ---------------------------------------------------------
create table if not exists quiz_sessions (
  code        text primary key,
  quiz_id     text references quiz_quizzes (id) on delete set null,
  quiz_title  text not null default '',
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------
-- 2b. Venue passwords.
--
--     Kept in their OWN table, never on quiz_sessions, because
--     the session row is world-readable — that is how the
--     projection screen and the leaderboard work. A password
--     sitting in that row would be readable by anyone holding
--     the join code, which is exactly the person it is meant to
--     stop.
--
--     Nothing can read this table with the public key. Players
--     never send their password anywhere it could be read back:
--     they call quiz_join_team() below, which checks it inside
--     the database and returns only the team row.
-- ---------------------------------------------------------
create table if not exists quiz_session_keys (
  session_code    text primary key references quiz_sessions (code) on delete cascade,
  venue_password  text not null default '',
  created_at      timestamptz not null default now()
);


-- ---------------------------------------------------------
-- 3. Teams — who is playing.
-- ---------------------------------------------------------
create table if not exists quiz_teams (
  id            uuid primary key default gen_random_uuid(),
  session_code  text not null references quiz_sessions (code) on delete cascade,
  name          text not null,
  joined_at     timestamptz not null default now()
);

create index if not exists quiz_teams_session_idx
  on quiz_teams (session_code, joined_at);

-- Two teams called "The Usual Suspects" in one show is a
-- leaderboard nobody can read, and the host cannot tell them
-- apart when marking. Case-insensitive so "the yard" cannot
-- shadow "The Yard".
create unique index if not exists quiz_teams_unique_name
  on quiz_teams (session_code, lower(name));


-- ---------------------------------------------------------
-- 4. Answers — one row per team per question.
--
--    `points` and `correct` are the HOST's marks, not the
--    player's claim. The RLS policies below let a player insert
--    and change their own `value`, but only a logged-in host can
--    set the marks. See the trigger after the policies, which
--    enforces that even against a crafted request.
-- ---------------------------------------------------------
create table if not exists quiz_answers (
  id            uuid primary key default gen_random_uuid(),
  session_code  text not null references quiz_sessions (code) on delete cascade,
  question_id   text not null,
  team_id       uuid not null references quiz_teams (id) on delete cascade,
  value         jsonb,                   -- string, number or array, per question type
  wager         integer,
  elapsed_ms    integer,
  points        integer not null default 0,
  correct       boolean,                 -- null = not marked yet
  submitted_at  timestamptz not null default now()
);

-- One answer per team per question: a resubmit updates the row
-- rather than adding a second one, which would double-score.
-- This index is what the client's upsert conflict target needs.
create unique index if not exists quiz_answers_one_per_team
  on quiz_answers (session_code, question_id, team_id);

create index if not exists quiz_answers_session_idx
  on quiz_answers (session_code);


-- ---------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------
alter table quiz_quizzes      enable row level security;
alter table quiz_sessions     enable row level security;
alter table quiz_session_keys enable row level security;
alter table quiz_teams        enable row level security;
alter table quiz_answers      enable row level security;

-- Re-runnable: drop then recreate.
drop policy if exists quiz_quizzes_host_all      on quiz_quizzes;
drop policy if exists quiz_sessions_public_read  on quiz_sessions;
drop policy if exists quiz_sessions_host_write   on quiz_sessions;
drop policy if exists quiz_sessions_host_update  on quiz_sessions;
drop policy if exists quiz_sessions_host_delete  on quiz_sessions;
drop policy if exists quiz_keys_host_all         on quiz_session_keys;
drop policy if exists quiz_keys_host_insert      on quiz_session_keys;
drop policy if exists quiz_keys_host_update      on quiz_session_keys;
drop policy if exists quiz_keys_host_delete      on quiz_session_keys;
drop policy if exists quiz_teams_public_read     on quiz_teams;
drop policy if exists quiz_teams_public_insert   on quiz_teams;
drop policy if exists quiz_teams_host_insert     on quiz_teams;
drop policy if exists quiz_teams_host_delete     on quiz_teams;
drop policy if exists quiz_answers_public_read   on quiz_answers;
drop policy if exists quiz_answers_public_insert on quiz_answers;
drop policy if exists quiz_answers_public_update on quiz_answers;
drop policy if exists quiz_answers_host_update   on quiz_answers;

-- Quizzes: host only, in both directions. This is the policy
-- that keeps the questions and answers out of the browser of
-- anyone who is not logged in.
--
-- "auth.uid() is not null" is the portable way to say "signed
-- in". The older auth.role() = 'authenticated' is deprecated and
-- is not present on newer projects, so it would fail here.
create policy quiz_quizzes_host_all on quiz_quizzes
  for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

-- Sessions: anyone may read (the projection and leaderboard are
-- meant to be openable by anyone with the code), host writes.
create policy quiz_sessions_public_read on quiz_sessions
  for select using (true);

create policy quiz_sessions_host_write on quiz_sessions
  for insert with check (auth.uid() is not null);

create policy quiz_sessions_host_update on quiz_sessions
  for update using (auth.uid() is not null);

create policy quiz_sessions_host_delete on quiz_sessions
  for delete using (auth.uid() is not null);

-- Venue passwords: NO POLICIES AT ALL.
--
-- Row level security is on and nothing grants access, so the
-- table is unreachable by every client — player, control room and
-- signed-in host alike. Nobody can read a venue password back
-- out; to change one you set a new one.
--
-- It is reached only through the two SECURITY DEFINER functions
-- below, which run as their owner and so sit outside these
-- policies: quiz_set_venue_password() writes one and
-- quiz_join_team() checks one. Rows go away with their session,
-- by the cascade on the foreign key.
--
-- One FOR ALL policy would have been shorter and wrong: FOR ALL
-- covers SELECT, which would have let any signed-in account read
-- every venue password.
--
-- This is also why writes go through a function rather than an
-- upsert. PostgREST compiles upsert to INSERT ... ON CONFLICT DO
-- UPDATE, which has to read the conflicting row — so an upsert
-- cannot work against a table that nothing may read.

-- Teams: anyone may read the roster (it goes on the projection).
create policy quiz_teams_public_read on quiz_teams
  for select using (true);

-- But NOT insert. Players join through quiz_join_team() below, so
-- that the venue password is actually enforced; a direct insert
-- policy here would let anyone skip it.
create policy quiz_teams_host_insert on quiz_teams
  for insert with check (auth.uid() is not null);

create policy quiz_teams_host_delete on quiz_teams
  for delete using (auth.uid() is not null);

-- Answers: readable (the projection shows the split across the
-- options, and each player needs their own marks back).
create policy quiz_answers_public_read on quiz_answers
  for select using (true);

-- A player may submit an answer to a live session. The marks
-- must arrive at their defaults — the trigger below is what
-- actually guarantees that, but stating it here means an
-- attempt to insert points is rejected outright.
create policy quiz_answers_public_insert on quiz_answers
  for insert
  with check (
    points = 0
    and correct is null
    and exists (
      select 1 from quiz_sessions s
      where s.code = session_code
        and coalesce(s.state ->> 'phase', 'lobby') <> 'ended'
    )
  );

-- A player may change their answer while the question is open.
create policy quiz_answers_public_update on quiz_answers
  for update
  using (
    exists (
      select 1 from quiz_sessions s
      where s.code = session_code
        and coalesce((s.state -> 'accepting')::text, 'false') = 'true'
        and coalesce(s.state -> 'question' ->> 'id', '') = question_id
    )
  );

create policy quiz_answers_host_update on quiz_answers
  for update using (auth.uid() is not null);


-- ---------------------------------------------------------
-- 5a. Setting tonight's venue password.
--
--     A SECURITY DEFINER function runs as its owner and so
--     bypasses row level security entirely. That means it has to
--     do its own authorisation — the check below is the only
--     thing standing between an anonymous caller and every venue
--     password, so it is not optional, and EXECUTE is granted to
--     signed-in accounts only.
-- ---------------------------------------------------------
create or replace function quiz_set_venue_password(p_code text, p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN';
  end if;

  insert into quiz_session_keys (session_code, venue_password)
  values (upper(btrim(p_code)), btrim(coalesce(p_password, '')))
  on conflict (session_code)
    do update set venue_password = excluded.venue_password;
end;
$$;

revoke all on function quiz_set_venue_password(text, text) from public;
grant execute on function quiz_set_venue_password(text, text) to authenticated;


-- ---------------------------------------------------------
-- 5b. Joining a game.
--
--     The only way a player gets a team row. Runs as the
--     definer, so it can read quiz_session_keys when the caller
--     cannot, checks the venue password inside the database, and
--     returns just the new team.
--
--     The password comparison is trimmed and case-insensitive on
--     purpose: it is a word shouted across a room or printed on
--     a table card, and "Bellchamber" failing because someone
--     typed "bellchamber " is a person who cannot play.
-- ---------------------------------------------------------
create or replace function quiz_join_team(p_code text, p_name text, p_password text default '')
returns quiz_teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required text;
  v_phase    text;
  v_name     text := btrim(coalesce(p_name, ''));
  v_team     quiz_teams;
begin
  if v_name = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  v_name := left(v_name, 40);

  select coalesce(s.state ->> 'phase', 'lobby')
    into v_phase
    from quiz_sessions s
   where s.code = upper(btrim(p_code));

  if v_phase is null then
    raise exception 'NO_SESSION';
  end if;
  if v_phase = 'ended' then
    raise exception 'SESSION_ENDED';
  end if;

  select k.venue_password
    into v_required
    from quiz_session_keys k
   where k.session_code = upper(btrim(p_code));

  if coalesce(btrim(v_required), '') <> '' then
    if lower(btrim(coalesce(p_password, ''))) <> lower(btrim(v_required)) then
      raise exception 'BAD_PASSWORD';
    end if;
  end if;

  insert into quiz_teams (session_code, name)
  values (upper(btrim(p_code)), v_name)
  returning * into v_team;

  return v_team;

exception
  when unique_violation then
    raise exception 'NAME_TAKEN';
end;
$$;

-- Callable by players, who are anonymous. Nothing else about
-- the keys table is reachable by them.
revoke all on function quiz_join_team(text, text, text) from public;
grant execute on function quiz_join_team(text, text, text) to anon, authenticated;


-- ---------------------------------------------------------
-- 6. Marks are the host's alone.
--
--    The update policies above are permissive in different ways
--    (a player may edit their own answer; a host may edit any),
--    and Postgres ORs permissive policies together. So the
--    policy alone cannot express "a player may change `value`
--    but not `points`". This trigger does that: on any update
--    that is not from a logged-in host, the marks are forced
--    back to whatever they already were.
--
--    Without it, a player could set their own score.
-- ---------------------------------------------------------
create or replace function quiz_answers_protect_marks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    new.points  := old.points;
    new.correct := old.correct;
    -- Nor may a player reassign their answer to another team,
    -- or move it to a different question after the fact.
    new.team_id      := old.team_id;
    new.question_id  := old.question_id;
    new.session_code := old.session_code;
  end if;
  return new;
end;
$$;

drop trigger if exists quiz_answers_protect_marks_trg on quiz_answers;
create trigger quiz_answers_protect_marks_trg
  before update on quiz_answers
  for each row execute function quiz_answers_protect_marks();


-- ---------------------------------------------------------
-- 7. Realtime
--
--    The app subscribes to all three live tables. It also polls
--    every few seconds as a floor, so a dropped realtime message
--    on venue wifi delays a screen rather than freezing it.
-- ---------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table quiz_sessions;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table quiz_teams;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table quiz_answers;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Realtime only sends the OLD row on an update if the table is
-- set to replicate it. The app re-reads rather than trusting the
-- payload, so this is not strictly required, but it makes the
-- dashboard's realtime inspector far more useful when debugging
-- a show that is misbehaving.
alter table quiz_sessions replica identity full;
alter table quiz_teams    replica identity full;
alter table quiz_answers  replica identity full;


-- ---------------------------------------------------------
-- 8. Housekeeping
--
--    Sessions accumulate: every show leaves a row, its teams and
--    every answer. Run this by hand now and then, or put it on a
--    schedule with pg_cron if you run shows often.
-- ---------------------------------------------------------
create or replace function quiz_prune_old_sessions(older_than interval default '30 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from quiz_sessions
  where created_at < now() - older_than;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Teams and answers cascade from the session, so this is all it
-- takes:  select quiz_prune_old_sessions('7 days');


-- =========================================================
-- AFTER RUNNING THIS
--
-- 1. Create your host login:
--      Authentication > Users > Add user (email + password)
--
-- 2. Turn OFF public sign-up:
--      Authentication > Providers > Email
--      > "Allow new users to sign up" = off
--
--    The anon key is public — that is how Supabase works. Every
--    write policy above checks "is logged in", not "is a
--    specific person", so leaving sign-up on would let anyone
--    who reads the page source register an account and gain
--    write access to your quizzes.
--
-- 3. Put the project URL and anon key in
--      assets/js/config.js
--    and set  requireLogin: true  in the same file.
--
-- A note on venue passwords: they stop someone who has the join
-- code from somewhere other than your room. They are checked
-- inside the database and are never sent to a browser, but they
-- are one shared word, so treat them as a door policy, not as
-- authentication. The control room's projection link carries the
-- password so the big screen can show it; the public state never
-- does.
-- =========================================================
