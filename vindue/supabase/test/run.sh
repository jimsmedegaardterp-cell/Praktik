#!/bin/sh
# Tester skema + adgangsregler mod en lokal PostgreSQL (16+) med en lille kopi af Supabase's auth-opsætning.
# Brug: PGHOST=/tmp/pgtest PGPORT=5499 PGUSER=postgres sh vindue/supabase/test/run.sh
set -e
D=$(dirname "$0")
psql -q -c "drop database if exists vindue_test" -c "create database vindue_test"
psql -q -d vindue_test -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$" -c "do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$"
grep -v '^create role' "$D/supa_stub.sql" | psql -q -d vindue_test
psql -q -d vindue_test -v ON_ERROR_STOP=1 -f "$D/../schema.sql" 2>/dev/null
psql -d vindue_test -A -t -F ' | ' -f "$D/rls_test.sql" 2>&1 | grep -v '^$\|CONTEXT'
