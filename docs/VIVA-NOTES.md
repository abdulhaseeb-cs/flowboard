# Viva preparation — FlowBoard

Short, project-specific answers. For each topic, know **where it is in the code** — "show me" is the
most common viva question.

---

## 0. The 30-second pitch

"FlowBoard is a real-time Kanban project manager. It runs as six Docker containers: Nginx serving a
React build and load-balancing two Node.js API replicas, a background worker, PostgreSQL and Redis.
Two EC2 instances run the stack behind an ALB with an Auto Scaling Group. Redis pub/sub keeps the
WebSocket updates in sync across the API replicas, and Selenium tests it with two browsers at once."

## 1. AWS EC2, Load Balancing & Auto Scaling (3)

- **EC2** — virtual servers. Ours come from a **Launch Template** (Amazon Linux 2023 AMI, `t3.small`,
  security group, key pair, **user data**).
- **User data** (`aws/user-data.sh`) runs as root on first boot: adds swap, installs Docker + Compose,
  reads the **instance ID / AZ from the metadata service (IMDSv2)**, clones the repo, generates random
  DB/Redis passwords, writes `.env` (`chmod 600`), `docker compose up -d --build`, waits for `/api/health`.
  → instances are **cattle, not pets**: any new instance configures itself.
- **ALB** — Layer-7 (HTTP) load balancer with one DNS name; spreads traffic over healthy targets in
  several AZs. Supports **WebSockets** (the HTTP `Upgrade` handshake is passed through). NLB = Layer 4.
- **Target group health check** → `GET /api/health`: returns **200 only if PostgreSQL and Redis
  respond** (it also reports worker status). Unhealthy targets get no traffic.
- **Auto Scaling Group** — min 2 / desired 2 / max 4 across 2 AZs. **Self-healing** (replaces failed
  or unhealthy instances) and **target-tracking** scaling on average CPU 50 %. Grace period 900 s
  because the first boot builds the images.
- **Security groups** — ALB SG allows 80 from anywhere; EC2 SG allows 80 **only from the ALB's SG**
  (+ 22 from my IP). Nobody can bypass the load balancer.
- **Stickiness** — each instance has its own DB/Redis, so the ALB cookie pins a browser to one
  instance. Improvement: RDS + ElastiCache shared by all instances → no stickiness needed.
- **Two levels of load balancing:** ALB → EC2 instances, then Nginx → API replicas inside each
  instance. `scripts/05-loadbalancer-check.sh` prints both.

## 2. Linux commands & file permissions (2)

Script: `scripts/01-linux-admin.sh`.

| Command | Purpose |
|---|---|
| `whoami`, `id`, `groups`, `hostname`, `uname -a`, `cat /etc/os-release` | identity & system |
| `df -h`, `free -h`, `nproc`, `ps aux`, `ss -tulpn`, `uptime` | resources, processes, open ports |
| `mkdir -p`, `ls -la`, `stat`, `tree`/`find` | create & inspect directories/files |
| `chmod`, `chown`, `chgrp`, `groupadd`, `usermod -aG` | permissions, ownership, groups |
| `systemctl`, `journalctl` | services (docker) and their logs |

`-rw-r-----` → type, owner `rw-`, group `r--`, others `---` → r4 w2 x1 → **640**.

| Mode | Meaning | Used for |
|---|---|---|
| 600 | owner read/write | `.env` (DB, Redis, JWT secrets), swap file |
| 640 | owner rw, group r | logs |
| 750 | owner rwx, group r-x | scripts, app directories |
| 700 | owner only | backups |

`x` on a directory = may `cd` into it. Symbolic: `chmod g+w f`, `chmod o-rwx f`. `umask 022` → files 644,
dirs 755. `usermod -aG docker ec2-user` (`-a` = append) lets ec2-user run Docker without sudo.

## 3. Docker images, Dockerfile & containers (3)

- **Image** = read-only layered template; **container** = running instance + thin writable layer.
- **Container vs VM** — containers share the host kernel (namespaces for isolation, cgroups for
  limits); start in seconds, MBs not GBs.
- **`web/Dockerfile` — multi-stage:** stage 1 `node:22-alpine` runs `npm ci` + `vite build`;
  stage 2 `nginx:1.28-alpine` copies **only `dist/`**. The final image has no Node, no source,
  no `node_modules` → small and safer.
- **`api/Dockerfile` — multi-stage:** stage 1 installs **production** dependencies with `npm ci
  --omit=dev`; stage 2 copies `node_modules` + `src`, runs as **`USER node`**, has a `HEALTHCHECK`,
  and uses exec-form `CMD` so Node is PID 1 and receives SIGTERM.
- **Layer caching** — `COPY package*.json` + `npm ci` come before `COPY src`, so editing code doesn't
  reinstall dependencies.
- **One image, two roles** — the worker uses `flowboard-api` with `command: node src/worker.js`.
- `RUN` (build time) vs `CMD` (default start command, overridable) vs `ENTRYPOINT` (fixed executable);
  `COPY` vs `ADD` (ADD also unpacks tars/URLs — prefer COPY); `EXPOSE` documents, `-p` publishes.
- `.dockerignore` keeps `node_modules`, `.env`, `dist` out of the build context.
- Commands: `build -t`, `images`, `history`, `inspect`, `run -d -p --name`, `ps -a`, `logs -f`,
  `exec -it`, `stats`, `stop`, `rm`, `rmi`.

## 4. Docker volumes & persistence (2)

Three **named volumes**:

| Volume | Mounted in | Holds |
|---|---|---|
| `flowboard_pgdata` | db `/var/lib/postgresql/data` | all relational data |
| `flowboard_redisdata` | redis `/data` | Redis append-only file |
| `flowboard_uploads` | **both** api replicas `/app/uploads` | task attachments — **shared** |

Plus a **bind mount** `./db/init → /docker-entrypoint-initdb.d:ro` for the schema, which Postgres
runs **only when the volume is empty** (first start).

`scripts/03-volume-persistence.sh` proves it: inserts a row, **deletes the DB container**, creates a
new one → row still there; same for a Redis key; a file written by replica 1 is read by replica 2;
`docker compose down` + `up` keeps everything. `docker compose down -v` would delete the volumes.

Named volume vs bind mount: Docker manages named volumes (`/var/lib/docker/volumes/...`), portable,
correct ownership; bind mounts map a specific host path (good for config/dev).

## 5. Docker Compose & multi-container communication (3)

`docker-compose.yml` defines **6 containers, 2 networks, 3 volumes**.

- **Service discovery** — Docker's embedded DNS (`127.0.0.11`) resolves service names: the API
  connects to `db:5432` and `redis:6379`; Nginx proxies to `api:3000`, which resolves to **one IP per
  replica**. Nginx's `server api:3000 resolve` re-resolves every 10 s, so scaled/recreated replicas are
  picked up automatically (`scripts/06-scale-and-realtime.sh` scales 2 → 3).
- **Networks** — `frontend` (web ↔ api) and `backend` with `internal: true` (api/worker ↔ db/redis,
  no internet). Web cannot reach the DB.
- **Startup order** — healthchecks + `depends_on: condition: service_healthy`: db & redis healthy →
  api healthy → web. The worker has no HTTP port, so its healthcheck checks a heartbeat file's age.
- **Replicas** — `deploy.replicas: 2` for the stateless API; no `container_name` on it (names must be unique).
- **Config** — `env_file: .env` + `${VAR}` substitution; YAML anchors (`x-app`, `x-logging`) avoid repetition.
- **Resilience** — `restart: unless-stopped`, memory limits, log rotation.

**Request path:** browser → ALB → EC2:80 → Nginx → (round-robin) api replica → Postgres/Redis.
**WebSocket path:** browser ⇄ Nginx (`Upgrade`/`Connection` headers, 1 h timeout) ⇄ one api replica.
**Event path:** replica 1 saves a task → emits via the **Redis adapter** (Redis PUBLISH) → replica 2
receives it (SUBSCRIBE) → pushes to its own browsers. The worker uses the **Redis emitter** the same way.

Why `transports: ['websocket']` in the client? Socket.IO's fallback (HTTP long-polling) needs every
request of a session to hit the same replica; pure WebSocket is one long TCP connection, so no
stickiness is needed between replicas.

## 6. Selenium testing (2)

`tests/selenium/test_flowboard.py` — **15 ordered steps, two browsers** (`driver` = user A,
`driver_b` = user B).

| Concept | In the suite |
|---|---|
| WebDriver | script → ChromeDriver → Chrome (Selenium Manager finds the driver; or Remote WebDriver to a Grid) |
| Locators | `By.ID`, `By.CSS_SELECTOR` on `id` / `data-testid` / `data-column-name` / `data-task-key`, one `By.XPATH` |
| **Explicit waits** | `WebDriverWait(...).until(EC.visibility_of_element_located(...))` — needed because the UI updates asynchronously over WebSockets |
| Custom waits | `wait(d).until(lambda d: len(presence avatars) == 2)` |
| **Drag & drop** | `ActionChains.click_and_hold().move_by_offset().move_to_element().release()` → then `refresh()` to prove persistence |
| Forms / dropdowns | `send_keys`, `Keys.ENTER`, `Select(...).select_by_visible_text("Review")` |
| **Real-time check** | A creates a task; B's browser waits up to 10 s for the card **without reloading** |
| Evidence | screenshots per step and on failure; HTML report via `pytest-html` |
| Grid | `docker-compose.selenium.yml` runs `selenium/standalone-chrome` with `SE_NODE_MAX_SESSIONS=2` (two browsers); watch on port 7900 |

Implicit wait = global timeout for every `find_element`; explicit wait = a specific condition — more
reliable, and they shouldn't be mixed.

The suite even caught a real bug during development: the dialog re-focused itself on every
re-render, so typing lost characters after the first keystroke (fixed in `components/ui.jsx`).

---

## Deeper "why did you…" questions

- **Fractional indexing?** Each card has a `position` float. Dropping between cards at 1024 and 2048
  gives 1536 → **one row updated per move**, not the whole column. When the gap gets too small, the
  column is renumbered ("rebalancing"). See `api/src/lib/tasks.js`.
- **WIP limits?** Kanban rule: cap the work in a column. Enforced in the database transaction
  (`409 WIP limit reached`), not only in the UI.
- **Task numbers without duplicates?** `UPDATE projects SET task_seq = task_seq + 1 RETURNING task_seq`
  inside the transaction — the row lock serialises concurrent creates.
- **Distributed lock?** `SET lock:due-reminders <id> NX PX <ttl>` — only the worker that sets the key
  runs the job, even with several workers on several EC2s. Plus `FOR UPDATE SKIP LOCKED` in SQL.
- **Rate limiting in Redis?** An in-memory counter would be per-replica; Redis makes the limit global.
- **Why re-check the role on every request?** The JWT only proves identity; roles live in the DB so
  a demotion takes effect immediately.
- **404 instead of 403 for non-members?** Doesn't reveal that a project ID exists.
- **Graceful shutdown?** SIGTERM → close WebSockets (clients reconnect to another replica) → finish
  in-flight HTTP → close DB/Redis pools → exit; Docker sends SIGKILL after 10 s.
- **Improvements?** RDS + ElastiCache + S3 for uploads (fully stateless instances), images pushed to
  ECR instead of building on boot, HTTPS via ACM on the ALB, CI/CD with GitHub Actions running the
  Selenium suite before deploying.
