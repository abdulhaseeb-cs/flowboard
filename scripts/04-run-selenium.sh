#!/usr/bin/env bash
# =====================================================================
# Task 6 — run the Selenium end-to-end tests
#   bash scripts/04-run-selenium.sh                          # local stack, browsers in Docker
#   bash scripts/04-run-selenium.sh http://<alb-dns-name>    # the deployed app via the ALB
#   MODE=local bash scripts/04-run-selenium.sh http://...    # use local Python + Chrome
# Output: tests/selenium/reports/selenium-report.html + tests/selenium/screenshots/*.png
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

export BASE_URL="${1:-http://web}"
MODE="${MODE:-docker}"
mkdir -p tests/selenium/reports tests/selenium/screenshots
echo "Testing $BASE_URL (mode: $MODE)"

if [[ "$MODE" == "docker" ]]; then
  docker compose -f docker-compose.yml -f docker-compose.selenium.yml run --rm --build tests
  docker compose -f docker-compose.yml -f docker-compose.selenium.yml stop selenium
else
  [[ "$BASE_URL" == "http://web" ]] && export BASE_URL="http://localhost"
  cd tests/selenium
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -q -r requirements.txt
  pytest
fi
echo "Report: tests/selenium/reports/selenium-report.html"
