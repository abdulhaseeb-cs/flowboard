#!/usr/bin/env bash
# =====================================================================
# Task 3 — Docker installation, Dockerfiles, custom images, containers
# Run from the project root:   bash scripts/02-docker-basics.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

section() { echo; echo "=== $1 ==="; if [[ "${PAUSE:-0}" == "1" ]]; then read -rp "[Enter] to continue..." _; fi; }
run() { echo "\$ $*"; eval "$@"; echo; }

section "1. Docker is installed and running"
run "docker --version"
run "docker compose version"
run "docker info --format 'Server {{.ServerVersion}} | storage={{.Driver}} | containers={{.Containers}} | images={{.Images}}'"

section "2. Build the custom images (both Dockerfiles are multi-stage)"
run "docker build -t flowboard-api:1.0.0 ./api"
run "docker build -t flowboard-web:1.0.0 ./web"

section "3. Multi-stage builds keep images small"
run "docker images | grep -E 'REPOSITORY|flowboard|node .*22-alpine|nginx .*alpine'"
echo "flowboard-web contains ONLY nginx + the compiled React files: the Node.js build stage"
echo "(compiler, node_modules, source code) was thrown away."
run "docker history flowboard-api:1.0.0 --format 'table {{.CreatedBy}}\t{{.Size}}' | head -12"
run "docker inspect flowboard-api:1.0.0 --format 'User={{.Config.User}}  Cmd={{.Config.Cmd}}  Ports={{.Config.ExposedPorts}}  Healthcheck={{.Config.Healthcheck.Test}}'"

section "4. Run ONE container from a custom image"
docker rm -f web-standalone >/dev/null 2>&1 || true
run "docker run -d --name web-standalone -p 8080:80 flowboard-web:1.0.0"
sleep 3
run "docker ps --filter name=web-standalone"
run "curl -s http://localhost:8080 | grep -o '<title>.*</title>'"
run "curl -s http://localhost:8080/nginx-health"

section "5. Inspect and interact with the running container"
run "docker logs web-standalone 2>&1 | tail -5"
run "docker exec web-standalone ls -lh /usr/share/nginx/html/assets"
run "docker exec web-standalone nginx -v 2>&1"
run "docker inspect web-standalone --format 'IP={{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}  State={{.State.Status}}  Health={{.State.Health.Status}}'"
run "docker stats --no-stream web-standalone"

section "6. Same image, different command (the worker)"
echo "docker-compose.yml runs flowboard-api:1.0.0 twice: as the API (default CMD) and as the worker:"
run "grep -n 'command:' docker-compose.yml"

section "7. Stop and remove"
run "docker stop web-standalone"
run "docker rm web-standalone"
echo "Lifecycle: image --run--> running --stop--> exited --rm--> removed (the image stays)."
