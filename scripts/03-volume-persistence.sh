#!/usr/bin/env bash
# =====================================================================
# Task 4 — Named volumes & data persistence
# Run from the project root AFTER `docker compose up -d`:
#   bash scripts/03-volume-persistence.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

section() { echo; echo "=== $1 ==="; if [[ "${PAUSE:-0}" == "1" ]]; then read -rp "[Enter] to continue..." _; fi; }
run() { echo "\$ $*"; eval "$@"; echo; }
sql() { docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1"; }
rcli() { docker compose exec -T redis redis-cli "$@"; }
wait_healthy() {   # wait_healthy <service>
  echo -n "Waiting for $1 to be healthy"
  for _ in $(seq 1 40); do
    local ids; ids=$(docker compose ps -q "$1")
    if [[ -n "$ids" ]] && ! docker inspect -f '{{.State.Health.Status}}' $ids | grep -qv healthy; then echo " ✓"; return; fi
    echo -n "."; sleep 2
  done
  echo " (timed out)"; exit 1
}

section "Volumes used by the stack"
run "docker volume ls | grep -E 'DRIVER|flowboard'"
run "docker volume inspect flowboard_pgdata --format 'Name={{.Name}}  Mountpoint={{.Mountpoint}}'"

# ---------------------------------------------------------------------
section "PART A — PostgreSQL data survives deleting the container"
STAMP=$(date +%s)
sql "INSERT INTO users (name, email, password_hash) VALUES ('Persistence Check', 'persist-$STAMP@check.local', 'not-a-real-hash');" >/dev/null
BEFORE=$(sql "SELECT COUNT(*) FROM users;")
OLD_ID=$(docker compose ps -q db | cut -c1-12)
echo "Users BEFORE: $BEFORE   (db container $OLD_ID)"
run "docker compose rm --stop --force db"
run "docker compose up -d db"
wait_healthy db
NEW_ID=$(docker compose ps -q db | cut -c1-12)
AFTER=$(sql "SELECT COUNT(*) FROM users;")
FOUND=$(sql "SELECT COUNT(*) FROM users WHERE email = 'persist-$STAMP@check.local';")
echo "Users AFTER : $AFTER   (NEW db container $NEW_ID)   marker row found: $FOUND"
[[ "$BEFORE" == "$AFTER" && "$FOUND" == "1" ]] && echo "✅ PostgreSQL data persisted in flowboard_pgdata" || { echo "❌ data lost"; exit 1; }
sql "DELETE FROM users WHERE email = 'persist-$STAMP@check.local';" >/dev/null

# ---------------------------------------------------------------------
section "PART B — Redis data survives (append-only file on flowboard_redisdata)"
run "docker compose exec -T redis redis-cli SET demo:persistence 'saved at $(date +%T)'"
run "docker compose rm --stop --force redis"
run "docker compose up -d redis"
wait_healthy redis
run "docker compose exec -T redis redis-cli GET demo:persistence"
rcli DEL demo:persistence >/dev/null

# ---------------------------------------------------------------------
section "PART C — the uploads volume is SHARED by both API replicas"
run "docker compose exec -T --index 1 api sh -c 'echo \"written by \$(hostname)\" > /app/uploads/volume-proof.txt'"
echo "Now read it from the OTHER replica (a different container):"
run "docker compose exec -T --index 2 api sh -c 'echo \"read by \$(hostname):\"; cat /app/uploads/volume-proof.txt'"
run "docker compose exec -T --index 2 api rm /app/uploads/volume-proof.txt"

# ---------------------------------------------------------------------
section "PART D — whole stack down and up again"
run "docker compose down"            # removes containers + networks, NOT named volumes
run "docker volume ls | grep flowboard"
run "docker compose up -d"
wait_healthy db
run "docker compose exec -T db psql -U $DB_USER -d $DB_NAME -c 'SELECT COUNT(*) AS users FROM users; ' -c 'SELECT COUNT(*) AS tasks FROM tasks;'"

echo "NOTE: 'docker compose down -v' WOULD delete the volumes and every row. Only run it on purpose."
