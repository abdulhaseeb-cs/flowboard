#!/bin/bash
# =====================================================================
# EC2 Launch Template USER DATA — Amazon Linux 2023
# Runs ONCE, as root, the first time each instance boots. Every instance the
# Auto Scaling Group launches configures itself with no manual SSH work:
#   install Docker + Compose -> clone the repo -> write .env -> docker compose up
#
# >>> EDIT THE TWO VALUES BELOW before pasting into the Launch Template <<<
# JWT_SECRET must be IDENTICAL on every instance (a token signed on one must verify on another).
# Log of this script on the instance:  sudo cat /var/log/flowboard-userdata.log
# =====================================================================
REPO_URL="https://github.com/abdulhaseeb-cs/flowboard.git"
JWT_SECRET="change-me-to-a-long-random-string"     # same value on every instance

set -euxo pipefail
exec > >(tee /var/log/flowboard-userdata.log) 2>&1
APP_DIR=/opt/flowboard

# ---------- 1. 2 GB swap (micro instances have 1 GB RAM; the React build + 6 containers need headroom) ----------
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

# ---------- 2. Docker Engine + git ----------
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user          # lets ec2-user run docker without sudo

# ---------- 3. Docker Compose v2 + Buildx plugins ----------
ARCH=$(uname -m)                                   # x86_64 | aarch64
BX_ARCH=$([ "$ARCH" = "aarch64" ] && echo arm64 || echo amd64)
PLUGINS=/usr/local/lib/docker/cli-plugins
mkdir -p "$PLUGINS"
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" -o "$PLUGINS/docker-compose"
BUILDX_VER=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VER}/buildx-${BUILDX_VER}.linux-${BX_ARCH}" -o "$PLUGINS/docker-buildx"
chmod +x "$PLUGINS"/docker-*
docker compose version
docker buildx version

# ---------- 4. Instance metadata (IMDSv2) — shown in the app footer ----------
TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
md() { curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
INSTANCE_ID=$(md instance-id)
AZ=$(md placement/availability-zone)

# ---------- 5. Get the application ----------
rm -rf "$APP_DIR"
git clone --depth 1 "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

# Per-instance random DB / Redis passwords (hex = URL-safe)
DB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
REDIS_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
cp .env.example .env
sed -i \
  -e "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASSWORD}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^INSTANCE_ID=.*|INSTANCE_ID=${INSTANCE_ID}|" \
  -e "s|^AVAILABILITY_ZONE=.*|AVAILABILITY_ZONE=${AZ}|" \
  .env

# ---------- 6. Linux permissions ----------
chown -R ec2-user:ec2-user "$APP_DIR"
chmod 600 .env                       # secrets: owner read/write only
chmod 750 scripts/*.sh               # scripts: owner+group may execute

# ---------- 7. Build and start the stack (6 containers) ----------
docker compose up -d --build
docker compose ps

# ---------- 8. Wait until the app answers (the ALB health check uses the same URL) ----------
for i in $(seq 1 60); do
  if curl -fsS http://localhost/api/health; then echo; echo "FlowBoard is UP on ${INSTANCE_ID} (${AZ})"; exit 0; fi
  sleep 5
done
echo "App did not become healthy in time"; docker compose logs --tail 50; exit 1
