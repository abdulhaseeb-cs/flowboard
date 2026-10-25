#!/usr/bin/env bash
# =====================================================================
# Task 1 — watch the AWS ALB (and Nginx inside each instance) spread requests.
#   bash scripts/05-loadbalancer-check.sh http://<alb-dns-name> [requests]
# Each line shows:  EC2 instance  /  API container (replica) that answered.
# Two levels of load balancing:  ALB -> EC2 instances,  Nginx -> API replicas.
# =====================================================================
set -euo pipefail
URL="${1:?Usage: $0 http://<alb-dns-name> [requests]}"
N="${2:-20}"

declare -A BY_INSTANCE BY_CONTAINER
for i in $(seq 1 "$N"); do
  BODY=$(curl -s --max-time 5 "$URL/api/health" || echo '{}')
  ID=$(echo "$BODY" | grep -o '"instanceId":"[^"]*"' | cut -d'"' -f4); ID=${ID:-ERROR}
  CT=$(echo "$BODY" | grep -o '"container":"[^"]*"' | cut -d'"' -f4); CT=${CT:-?}
  AZ=$(echo "$BODY" | grep -o '"availabilityZone":"[^"]*"' | cut -d'"' -f4)
  BY_INSTANCE[$ID]=$(( ${BY_INSTANCE[$ID]:-0} + 1 ))
  BY_CONTAINER["$ID/$CT"]=$(( ${BY_CONTAINER["$ID/$CT"]:-0} + 1 ))
  printf "%3d  %-22s %-14s %s\n" "$i" "$ID" "$CT" "$AZ"
done

echo "------------- per EC2 instance -------------"
for k in "${!BY_INSTANCE[@]}"; do printf "%-22s %d\n" "$k" "${BY_INSTANCE[$k]}"; done
echo "------------- per API container ------------"
for k in "${!BY_CONTAINER[@]}"; do printf "%-40s %d\n" "$k" "${BY_CONTAINER[$k]}"; done
