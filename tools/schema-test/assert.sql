-- =========================================================
-- Does the schema actually do what the README claims?
--
-- Everything runs inside one transaction and is rolled back, so
-- the harness leaves no rows behind.
-- =========================================================
begin;

create temporary table results (n serial, label text, ok boolean) on commit drop;

-- SECURITY DEFINER so the recorder keeps working after `set role
-- anon`, which otherwise cannot write the results table. Only the
-- recorder is elevated: the statements under test run as whatever
-- role is current, which is the whole point.
create or replace function ck(p_label text, p_ok boolean) returns void
language plpgsql security definer as $$
begin
  insert into results (label, ok) values (p_label, coalesce(p_ok, false));
end $$;

-- Assert that a statement is REFUSED. `expect` is the error text
-- we require; a statement that fails for some other reason is not
-- a pass, it is a different bug.
-- Deliberately NOT security definer: the statement under test has
-- to run as the current role or the test proves nothing.
create or replace function ck_refused(p_label text, p_sql text, p_expect text default '')
returns void language plpgsql as $$
begin
  execute p_sql;
  perform ck(p_label || ' [was allowed]', false);
exception when others then
  if p_expect = '' or position(lower(p_expect) in lower(sqlerrm)) > 0 then
    perform ck(p_label, true);
  else
    perform ck(p_label || ' [wrong error: ' || sqlerrm || ']', false);
  end if;
end $$;

create or replace function ck_allowed(p_label text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform ck(p_label, true);
exception when others then
  perform ck(p_label || ' [refused: ' || sqlerrm || ']', false);
end $$;


-- ---------------------------------------------------------
-- Structure
-- ---------------------------------------------------------
select ck('all five tables exist', (
  select count(*) = 5 from pg_tables
   where schemaname = 'public'
     and tablename in ('quiz_quizzes','quiz_sessions','quiz_session_keys',
                       'quiz_teams','quiz_answers')));

select ck('row level security is on for every table', (
  select bool_and(rowsecurity) from pg_tables
   where schemaname = 'public' and tablename like 'quiz\_%'));

select ck('quiz_join_team is SECURITY DEFINER', (
  select bool_and(prosecdef) from pg_proc where proname = 'quiz_join_team'));

select ck('the marks-protection trigger is installed', (
  select count(*) = 1 from pg_trigger
   where tgname = 'quiz_answers_protect_marks_trg' and not tgisinternal));

-- 'ALL' has to be in this list: a FOR ALL policy covers SELECT,
-- and checking only for cmd = 'SELECT' misses it entirely. That
-- gap is what let a readable venue-password table pass as
-- write-only.
select ck('no policy on quiz_session_keys grants SELECT', (
  select count(*) = 0 from pg_policies
   where tablename = 'quiz_session_keys' and cmd in ('SELECT', 'ALL')));

select ck('quiz_teams has no INSERT policy for anyone not signed in', (
  select count(*) = 1 from pg_policies
   where tablename = 'quiz_teams' and cmd = 'INSERT'
     and with_check like '%auth.uid()%'));

select ck('one team name per session, case-insensitively', (
  select count(*) = 1 from pg_indexes
   where tablename = 'quiz_teams' and indexdef ilike '%lower(name)%' and indexdef ilike '%unique%'));

select ck('one answer per team per question', (
  select count(*) = 1 from pg_indexes
   where tablename = 'quiz_answers' and indexdef ilike '%unique%'
     and indexdef ilike '%question_id%' and indexdef ilike '%team_id%'));


-- ---------------------------------------------------------
-- Seed, as the owner
-- ---------------------------------------------------------
insert into quiz_quizzes (id, title, data)
values ('q1', 'Secret Case', '{"secret":"the butler did it"}'::jsonb);

insert into quiz_sessions (code, quiz_id, quiz_title, state)
values ('ABCDE', 'q1', 'Secret Case',
        '{"phase":"lobby","accepting":false}'::jsonb),
       ('OVER1', 'q1', 'Finished Case',
        '{"phase":"ended","accepting":false}'::jsonb);

insert into quiz_session_keys (session_code, venue_password)
values ('ABCDE', 'Lamplight'), ('OVER1', 'Lamplight');


-- ---------------------------------------------------------
-- As a player: anonymous, not signed in
-- ---------------------------------------------------------
set local role anon;
do $$ begin perform set_config('test.uid', '', true); end $$;

select ck('a player cannot read the quizzes table',
  (select count(*) = 0 from quiz_quizzes));

select ck('a player cannot read the venue passwords',
  (select count(*) = 0 from quiz_session_keys));

select ck('a player CAN read the session state',
  (select count(*) = 2 from quiz_sessions));

select ck_refused('a player cannot insert a team directly',
  $$insert into quiz_teams (session_code, name) values ('ABCDE', 'Sneaky')$$,
  'row-level security');

select ck_refused('a player cannot set the venue password',
  $$select quiz_set_venue_password('ABCDE', 'mine-now')$$, '');

select ck_refused('a player cannot write a quiz',
  $$insert into quiz_quizzes (id, title, data) values ('q2','Mine','{}'::jsonb)$$,
  'row-level security');

-- RLS on UPDATE FILTERS rather than raising: a statement that
-- matches no visible row succeeds, having changed nothing. So the
-- check is that nothing changed, not that an error was raised.
update quiz_sessions set state = '{"phase":"reveal"}'::jsonb where code = 'ABCDE';
select ck('a player cannot change the session state',
  (select state ->> 'phase' = 'lobby' from quiz_sessions where code = 'ABCDE'));

-- Joining: the only way in
select ck_refused('joining with the wrong password is refused',
  $$select quiz_join_team('ABCDE', 'Gatecrashers', 'not-it')$$, 'BAD_PASSWORD');

select ck_refused('joining with no password is refused when one is set',
  $$select quiz_join_team('ABCDE', 'Gatecrashers', '')$$, 'BAD_PASSWORD');

select ck_refused('joining an unknown game is refused',
  $$select quiz_join_team('ZZZZZ', 'Nobody', 'Lamplight')$$, 'NO_SESSION');

select ck_refused('joining a finished game is refused',
  $$select quiz_join_team('OVER1', 'Latecomers', 'Lamplight')$$, 'SESSION_ENDED');

select ck_refused('joining without a name is refused',
  $$select quiz_join_team('ABCDE', '   ', 'Lamplight')$$, 'NAME_REQUIRED');

select ck_allowed('joining with the right password works',
  $$select quiz_join_team('ABCDE', 'Baker Street', 'Lamplight')$$);

select ck_allowed('capitals and stray spaces in the password are forgiven',
  $$select quiz_join_team('ABCDE', 'The Yard', '  LAMPLIGHT  ')$$);

select ck_refused('the same team name cannot join twice',
  $$select quiz_join_team('ABCDE', 'baker street', 'Lamplight')$$, 'NAME_TAKEN');

select ck('the gatecrashers never got in',
  (select count(*) = 2 from quiz_teams where session_code = 'ABCDE'));


-- ---------------------------------------------------------
-- Answers: a player may answer, but may not mark
-- ---------------------------------------------------------
select ck_allowed('a player can submit an answer',
  $$insert into quiz_answers (session_code, question_id, team_id, value)
    select 'ABCDE', 'q_001', id, '["a"]'::jsonb from quiz_teams where name = 'Baker Street'$$);

select ck_refused('a player cannot submit an answer already worth points',
  $$insert into quiz_answers (session_code, question_id, team_id, value, points)
    select 'ABCDE', 'q_002', id, '["a"]'::jsonb, 50 from quiz_teams where name = 'Baker Street'$$,
  'row-level security');

select ck_refused('a player cannot submit an answer already marked correct',
  $$insert into quiz_answers (session_code, question_id, team_id, value, correct)
    select 'ABCDE', 'q_003', id, '["a"]'::jsonb, true from quiz_teams where name = 'Baker Street'$$,
  'row-level security');

-- The question is closed (accepting is false), so the row is
-- invisible to an update and nothing changes.
update quiz_answers set value = '["closed"]'::jsonb where question_id = 'q_001';
select ck('a player cannot edit an answer once the question is closed',
  (select value::text = '["a"]' from quiz_answers where question_id = 'q_001'));

-- Open the question as the owner, then try again as the player.
reset role;
update quiz_sessions
   set state = '{"phase":"question","accepting":true,"question":{"id":"q_001"}}'::jsonb
 where code = 'ABCDE';
set local role anon;

select ck_allowed('a player CAN edit their answer while the question is open',
  $$update quiz_answers set value = '["b"]'::jsonb where question_id = 'q_001'$$);

-- The headline claim: a player cannot award themselves points.
update quiz_answers set points = 999, correct = true where question_id = 'q_001';
select ck('a player cannot award themselves points',
  (select points = 0 and correct is null from quiz_answers where question_id = 'q_001'));

-- Nor move their answer to another team or question.
update quiz_answers set question_id = 'q_999' where question_id = 'q_001';
select ck('a player cannot move their answer to another question',
  (select count(*) = 1 from quiz_answers where question_id = 'q_001'));


-- ---------------------------------------------------------
-- As the host: signed in
-- ---------------------------------------------------------
set local role authenticated;
do $$ begin perform set_config('test.uid', '11111111-1111-4111-8111-111111111111', true); end $$;

select ck('the host CAN read the quizzes',
  (select count(*) = 1 from quiz_quizzes));

select ck_allowed('the host can write a quiz',
  $$insert into quiz_quizzes (id, title, data) values ('q2','Second Case','{}'::jsonb)$$);

select ck_allowed('the host can push session state',
  $$update quiz_sessions set state = '{"phase":"reveal"}'::jsonb where code = 'ABCDE'$$);

select ck_allowed('the host can mark an answer',
  $$update quiz_answers set points = 10, correct = true where question_id = 'q_001'$$);

select ck('the host''s marks actually stick',
  (select points = 10 and correct from quiz_answers where question_id = 'q_001'));

select ck_allowed('the host can set a venue password',
  $$select quiz_set_venue_password('ABCDE', 'NewWord')$$);

select ck_refused('the host cannot write the keys table directly',
  $$insert into quiz_session_keys (session_code, venue_password) values ('ZZZZZ','x')$$,
  'row-level security');

select ck('even the host cannot read a venue password back',
  (select count(*) = 0 from quiz_session_keys));

select ck_allowed('the host can remove a team',
  $$delete from quiz_teams where name = 'The Yard'$$);

-- Back to a player, to prove the new password actually replaced
-- the old one rather than being written somewhere inert.
set local role anon;
do $$ begin perform set_config('test.uid', '', true); end $$;

select ck_refused('the old password stops working once it is changed',
  $$select quiz_join_team('ABCDE', 'Stragglers', 'Lamplight')$$, 'BAD_PASSWORD');

select ck_allowed('the new password works',
  $$select quiz_join_team('ABCDE', 'Stragglers', 'NewWord')$$);

reset role;

-- ---------------------------------------------------------
-- Report
-- ---------------------------------------------------------
select case when ok then '  ok   ' else '  FAIL ' end || label
  from results order by n;

select count(*) filter (where not ok) as failures,
       count(*) as total
  from results \gset

select case
  when :failures > 0
  then E'\n  ' || (:total - :failures) || ' passed, ' || :failures || ' FAILED'
  else E'\n  ' || :total || ' checks passed.'
end;

rollback;
