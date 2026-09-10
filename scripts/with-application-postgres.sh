#!/usr/bin/env bash
set -euo pipefail
# An owned, loopback-only cluster with TLS. Never use a deployment connection.
if ! command -v initdb >/dev/null; then
  for candidate in /usr/lib/postgresql/*/bin; do
    if [ -x "$candidate/initdb" ]; then export PATH="$candidate:$PATH"; fi
  done
fi
for tool in initdb pg_ctl psql openssl; do
  command -v "$tool" >/dev/null || { echo "Missing test prerequisite: $tool" >&2; exit 1; }
done
application_pg_directory=$(mktemp -d "${TMPDIR:-/tmp}/official-application-pg.XXXXXX")
cleanup() {
  pg_ctl -D "$application_pg_directory/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$application_pg_directory"
}
trap cleanup EXIT
application_pg_port=$(node --input-type=module -e "import {createServer} from 'node:net'; const server=createServer(); server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()});")
initdb -D "$application_pg_directory/data" -A trust -U registry_admin > "$application_pg_directory/init.log"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -keyout "$application_pg_directory/server.key" -out "$application_pg_directory/server.crt" 2> "$application_pg_directory/tls.log"
chmod 600 "$application_pg_directory/server.key"
pg_ctl -D "$application_pg_directory/data" -l "$application_pg_directory/server.log" \
  -o "-h 127.0.0.1 -p $application_pg_port -k $application_pg_directory -c ssl=on -c ssl_cert_file=$application_pg_directory/server.crt -c ssl_key_file=$application_pg_directory/server.key" -w start
psql -h 127.0.0.1 -p "$application_pg_port" -U registry_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE coreloom_migrator LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE coreloom_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE coreloom_background LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE registry_application OWNER coreloom_migrator;
SQL
psql -h 127.0.0.1 -p "$application_pg_port" -U registry_admin -d registry_application -v ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE registry_application TO coreloom_runtime, coreloom_background;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO coreloom_runtime, coreloom_background;
ALTER DEFAULT PRIVILEGES FOR ROLE coreloom_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coreloom_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE coreloom_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO coreloom_runtime;
SQL
export FD_APPLICATION_TEST_DATABASE_PORT="$application_pg_port"
export FD_APPLICATION_TEST_DATABASE_CA="$application_pg_directory/server.crt"
node scripts/test-application.mjs
