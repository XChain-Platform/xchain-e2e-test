#!/usr/bin/env bash
# Provision a throwaway root MariaDB (Docker) for the MultiValidatorHub driver
# DBs (the platform DB users lack CREATE DATABASE). Mirrors disposableHubDb.js.
# Root password is generated once into a 0600 file and passed to docker/exec by
# env-var NAME only, so it never appears in any command line.
set -euo pipefail
PASSFILE="$HOME/.anchor-mvh-db.pass"
NAME=xchain-anchor-mvhdb
PORT=13307
if [ ! -s "$PASSFILE" ]; then ( umask 077; openssl rand -hex 16 > "$PASSFILE" ); fi
chmod 600 "$PASSFILE"
export MARIADB_ROOT_PASSWORD="$(cat "$PASSFILE")"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e MARIADB_ROOT_PASSWORD \
  -p 127.0.0.1:${PORT}:3306 \
  --tmpfs /var/lib/mysql:rw \
  mariadb:11 >/dev/null
export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"
for i in $(seq 1 90); do
  if docker exec -e MYSQL_PWD "$NAME" mariadb -uroot --protocol=socket -e "SELECT 1" >/dev/null 2>&1; then
    echo "mvh-db ready on 127.0.0.1:${PORT}"; exit 0
  fi
  sleep 2
done
echo "mvh-db NOT ready"; docker logs --tail 20 "$NAME" 2>&1 | tail -20; exit 1
