#!/usr/bin/env bash
# =========================================================
# Run supabase/schema.sql against a real PostgreSQL and check
# it does what the README claims.
#
# The security claims in this project are claims about the
# DATABASE: that a player cannot read the questions, cannot set
# their own score, and cannot join without the venue password.
# Those deserve testing rather than trusting, and they can be
# tested without a Supabase account at all.
#
# The harness supplies only what Supabase supplies for you — the
# anon and authenticated roles, auth.uid(), and the default table
# grants. schema.sql itself is run exactly as shipped.
#
# Needs postgresql installed. Everything runs in one transaction
# and is rolled back; the cluster is thrown away afterwards.
#
#   bash tools/test-schema.sh
# =========================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
[ -n "$PGBIN" ] || { echo "No PostgreSQL found. Install postgresql and try again."; exit 1; }

WORK="$(mktemp -d /tmp/pdschema.XXXXXX)"
SYSUSER=postgres
trap 'su "$SYSUSER" -c "$PGBIN/pg_ctl -D $WORK/data -s -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/data" "$WORK/sock"
chown -R "$SYSUSER" "$WORK"
chmod 700 "$WORK/data"

run() { su "$SYSUSER" -c "psql -h $WORK/sock -d detective -v ON_ERROR_STOP=1 $*"; }

echo "Starting a throwaway PostgreSQL $(basename "$(dirname "$PGBIN")")..."
su "$SYSUSER" -c "$PGBIN/initdb -D $WORK/data -A trust -E UTF8" >/dev/null 2>&1
su "$SYSUSER" -c "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK/sock -h \"\"' -l $WORK/log -w start" >/dev/null
su "$SYSUSER" -c "$PGBIN/createdb -h $WORK/sock detective"

echo "Supplying the roles and auth.uid() that Supabase provides..."
run "-q -f $ROOT/tools/schema-test/setup.sql"

echo "Applying supabase/schema.sql as shipped..."
# The idempotent "drop policy if exists" lines are expected to say
# "does not exist, skipping" on a fresh database; that is the file
# being re-runnable, not a problem.
run "-q -c 'set client_min_messages = warning' -f $ROOT/supabase/schema.sql"
echo "  applied with no errors."
echo

run "-q -t -A -f $ROOT/tools/schema-test/assert.sql" | grep -v '^$' || true

if run "-q -t -A -f $ROOT/tools/schema-test/assert.sql" 2>/dev/null | grep -q '  FAIL '; then
  exit 1
fi
