#!/usr/bin/env bash
# =====================================================================
# Task 2 — Linux Administration demo (run on the EC2 instance)
#   bash scripts/01-linux-admin.sh            # run everything
#   PAUSE=1 bash scripts/01-linux-admin.sh    # pause after each section (for the viva)
# Creates a demo directory tree under /opt/flowboard-demo and shows how
# Linux file permissions protect it. Safe to run more than once.
# =====================================================================
set -euo pipefail

DEMO_DIR=/opt/flowboard-demo
GROUP=devops
APP_USER=${SUDO_USER:-$(whoami)}

section() {
  echo
  echo "=================================================================="
  echo "  $1"
  echo "=================================================================="
  if [[ "${PAUSE:-0}" == "1" ]]; then read -rp "  [Enter] to continue..." _; fi
}
run() { echo "\$ $*"; eval "$@"; echo; }

section "1. Who am I and what system is this?"
run whoami
run id
run hostname
run "uname -a"
run "grep PRETTY_NAME /etc/os-release"
run uptime

section "2. Resources: disk, memory, CPU, processes, ports"
run "df -h /"
run "free -h"
run nproc
run "ps aux --sort=-%mem | head -6"
run "sudo ss -tulpn | grep -E ':80|:22|:3000|:5432|:6379' || true"

section "3. Create a directory structure"
run "sudo mkdir -p $DEMO_DIR/{config,logs,backups,scripts}"
run "ls -la $DEMO_DIR"
run "tree $DEMO_DIR 2>/dev/null || find $DEMO_DIR -maxdepth 1"

section "4. Create a group and set ownership (chown / chgrp)"
run "sudo groupadd -f $GROUP"
run "sudo usermod -aG $GROUP $APP_USER"
run "sudo chown -R root:$GROUP $DEMO_DIR"
run "ls -ld $DEMO_DIR"

section "5. Create files"
run "echo 'DB_PASSWORD=super-secret' | sudo tee $DEMO_DIR/config/app.env >/dev/null"
run "echo 'echo backup started at \$(date)' | sudo tee $DEMO_DIR/scripts/backup.sh >/dev/null"
run "echo \"\$(date) app started\" | sudo tee $DEMO_DIR/logs/app.log >/dev/null"
run "ls -l $DEMO_DIR/*"

section "6. Permissions — numeric (octal) mode"
#   r=4 w=2 x=1     owner | group | others
#   750 = rwx r-x ---   directory: owner full, group can enter/list, others nothing
#   640 = rw- r-- ---   log file: owner writes, group reads
#   600 = rw- --- ---   secrets: ONLY the owner can read
#   750 on a script     owner/group can execute
run "sudo chmod 750 $DEMO_DIR $DEMO_DIR/config $DEMO_DIR/scripts"
run "sudo chmod 770 $DEMO_DIR/logs"
run "sudo chmod 700 $DEMO_DIR/backups"
run "sudo chmod 600 $DEMO_DIR/config/app.env"
run "sudo chmod 640 $DEMO_DIR/logs/app.log"
run "sudo chmod 750 $DEMO_DIR/scripts/backup.sh"
run "sudo ls -lR $DEMO_DIR"

section "7. Permissions — symbolic mode"
run "sudo chmod g+w $DEMO_DIR/logs/app.log"     # add write for group
run "sudo chmod o-rwx $DEMO_DIR/logs/app.log"   # make sure others have nothing
run "sudo ls -l $DEMO_DIR/logs/app.log"
run "sudo stat -c '%A  %a  %U:%G  %n' $DEMO_DIR/config/app.env $DEMO_DIR/logs/app.log $DEMO_DIR/scripts/backup.sh"

section "8. Prove the permissions work"
echo "Reading the secret file as a normal user should FAIL (permission denied):"
run "cat $DEMO_DIR/config/app.env || echo '>> Permission denied — as expected (600, owned by root)'"
echo "Reading it with sudo works:"
run "sudo cat $DEMO_DIR/config/app.env"
echo "Running the script as root:"
run "sudo $DEMO_DIR/scripts/backup.sh"

section "9. Default permissions for new files (umask)"
run umask
echo "umask 0022 => new files 644 (rw-r--r--), new directories 755 (rwxr-xr-x)"

section "10. The real project: protect the .env secrets file"
if [[ -f /opt/flowboard/.env ]]; then
  run "ls -l /opt/flowboard/.env"
  run "sudo chmod 600 /opt/flowboard/.env"
  run "ls -l /opt/flowboard/.env"
else
  echo "(/opt/flowboard/.env not found — run this after deploying the app)"
fi

section "11. Services and logs"
run "systemctl is-active docker || true"
run "sudo journalctl -u docker --no-pager -n 5 || true"
run "groups $APP_USER"

echo "Done. Clean up with: sudo rm -rf $DEMO_DIR"
