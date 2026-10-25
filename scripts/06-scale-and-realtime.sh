#!/usr/bin/env bash
# =====================================================================
# Task 5 (extra) — multi-container communication & horizontal scaling
#   bash scripts/06-scale-and-realtime.sh
# Shows: service discovery by name, Nginx balancing API replicas, scaling
# from 2 -> 3 replicas, and the Redis pub/sub channels that keep WebSockets
# in sync across replicas.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

section() { echo; echo "=== $1 ==="; if [[ "${PAUSE:-0}" == "1" ]]; then read -rp "[Enter] to continue..." _; fi; }
run() { echo "\$ $*"; eval "$@"; echo; }
served_by() { for _ in $(seq 1 "$1"); do curl -s -D - -o /dev/null http://localhost/api/health | grep -i x-served-by | tr -d '\r'; done | sort | uniq -c; }

section "1. The running stack"
run "docker compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Ports}}'"

section "2. Service discovery: containers find each other BY NAME via Docker DNS"
run "docker compose exec -T web nslookup api 127.0.0.11 2>/dev/null | grep -A10 'Name:' || docker compose exec -T web getent hosts api"
run "docker compose exec -T --index 1 api node -e \"require('dns').lookup('db',(e,a)=>console.log('db  ->',a))\""
run "docker compose exec -T --index 1 api node -e \"require('dns').lookup('redis',(e,a)=>console.log('redis ->',a))\""

section "3. Network isolation: web cannot reach the database"
run "docker compose exec -T web sh -c 'nc -zw2 db 5432 && echo reachable || echo \"db NOT reachable from web (different network) ✓\"'"

section "4. Nginx load-balances across the API replicas (X-Served-By header)"
served_by 10

section "5. Scale the API to 3 replicas — no config change needed"
run "docker compose up -d --scale api=3 --no-recreate"
sleep 15
run "docker compose ps api"
served_by 12

section "6. Redis glues the replicas together"
run "docker compose exec -T redis redis-cli PUBSUB CHANNELS 'socket.io*'"
run "docker compose exec -T redis redis-cli PUBSUB NUMSUB socket.io#/#"
run "docker compose exec -T redis redis-cli --scan --pattern 'lock:*'"
run "docker compose exec -T redis redis-cli GET worker:heartbeat"

section "7. Back to 2 replicas"
run "docker compose up -d --scale api=2 --no-recreate"
run "docker compose ps api"
