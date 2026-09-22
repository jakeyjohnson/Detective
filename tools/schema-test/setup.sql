-- What Supabase provides for you, supplied here so schema.sql
-- can be run exactly as shipped against a plain PostgreSQL.
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;

-- auth.uid() reads the JWT claim in Supabase. Here it reads a
-- session setting, so a test can be signed in or not.
create schema auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Supabase grants these on new tables in public by default.
-- Without them RLS never gets a chance to decide anything.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
