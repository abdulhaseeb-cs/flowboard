# Deploying FlowBoard to AWS (EC2 + ALB + Auto Scaling)

Target architecture: **two EC2 instances** (in two Availability Zones) behind an **Application Load
Balancer**, managed by an **Auto Scaling Group**. Every instance runs the full 6-container Docker Compose
stack (web, 2× api, worker, postgres, redis) with its own named volumes. The ALB carries both normal
HTTP requests and the long-lived **WebSocket** connections (ALBs support WebSockets natively).

> Works in a normal AWS account or an **AWS Academy Learner Lab** (use region `us-east-1`; when asked
> for an IAM instance profile pick `LabInstanceProfile` or leave it empty).
> Budget about 60–90 minutes the first time. **Delete everything at the end** (step 9) to avoid charges.

---

## 0. Put the code on GitHub

The instances download the code themselves, so it must be in a repo they can reach.

```bash
cd flowboard
git init && git add . && git commit -m "FlowBoard: DevOps lab mid"
git branch -M main
git remote add origin https://github.com/<you>/flowboard.git
git push -u origin main
```

Make the repository **public** (or use a token in the clone URL). Then edit the top of
`aws/user-data.sh`:

```bash
REPO_URL="https://github.com/<you>/flowboard.git"
JWT_SECRET="<any long random string — same on every instance>"
```

## 1. Security groups (EC2 → Network & Security → Security Groups)

Create **two** groups in the default VPC:

| Name | Inbound rule | Source | Why |
|---|---|---|---|
| `flowboard-alb-sg` | HTTP 80 | `0.0.0.0/0` | the public can reach the load balancer |
| `flowboard-ec2-sg` | HTTP 80 | **`flowboard-alb-sg`** (pick the SG, not an IP) | only the ALB can reach the instances |
| `flowboard-ec2-sg` | SSH 22 | My IP | so you can SSH in for the demo scripts |

Leave outbound as "all traffic". This is *defence in depth*: even if someone finds an instance's
public IP, port 80 is closed to them.

## 2. Key pair

EC2 → Key Pairs → Create → `flowboard-key` (`.pem` for OpenSSH / Windows Terminal, `.ppk` for PuTTY).

## 3. Launch Template (EC2 → Instances → Launch Templates → Create)

| Setting | Value |
|---|---|
| Name | `flowboard-lt` |
| AMI | **Amazon Linux 2023** (x86_64) |
| Instance type | **`t3.small`** (2 GB) recommended for 6 containers. `t3.micro` works thanks to the 2 GB swap the script adds, but the first build is slow |
| Key pair | `flowboard-key` |
| Subnet | *Don't include in launch template* (the ASG chooses) |
| Security groups | `flowboard-ec2-sg` |
| Storage | **12–16 GiB** gp3 (images + build cache) |
| Advanced → Metadata version | **V2 only (token required)** — the script uses IMDSv2 |
| Advanced → **User data** | paste the whole edited `aws/user-data.sh` |

## 4. (Optional but recommended) test one instance first

Launch one instance from the template (Actions → Launch instance from template), wait ~5 minutes,
then open `http://<public-ip>` — only works if you temporarily allow port 80 from your IP. Or SSH in:

```bash
ssh -i flowboard-key.pem ec2-user@<public-ip>
sudo tail -f /var/log/flowboard-userdata.log   # watch the bootstrap
cd /opt/flowboard && docker compose ps
curl -s localhost/api/health
```

Terminate this test instance once it works.

## 5. Target Group (EC2 → Load Balancing → Target Groups → Create)

| Setting | Value |
|---|---|
| Target type | Instances |
| Name | `flowboard-tg` |
| Protocol / port | HTTP / 80 |
| Health check path | **`/api/health`** (returns 200 only if the API *and* database are up) |
| Advanced health check | Healthy threshold 2, Unhealthy 3, Interval 15 s, Success codes 200 |
| Register targets | **none** — the Auto Scaling Group will register instances |

After creating it: **Attributes → Edit → Stickiness: ON → Load balancer generated cookie → 1 day.**

> **Why stickiness is required here:** each instance has its *own* PostgreSQL and Redis containers, so
> data is not shared between instances. Without stickiness your browser could log in on instance A and
> then be routed to instance B, which has never heard of your account. With stickiness the ALB pins each
> browser (its API calls **and** its WebSocket) to one instance.
>
> Inside an instance stickiness is NOT needed: the two API replicas share the same database and Redis,
> and the Socket.IO Redis adapter relays events between them. To remove stickiness at the ALB level as
> well you would move PostgreSQL to **Amazon RDS** and Redis to **ElastiCache** so all instances share
> them — exactly the same design, one level up. That's a strong viva point.

## 6. Application Load Balancer (Load Balancers → Create → Application Load Balancer)

| Setting | Value |
|---|---|
| Name | `flowboard-alb` |
| Scheme | Internet-facing, IPv4 |
| Network mapping | default VPC, tick **at least two Availability Zones** |
| Security group | `flowboard-alb-sg` (remove "default") |
| Listener | HTTP : 80 → forward to `flowboard-tg` |

Copy the **DNS name**, e.g. `flowboard-alb-123456789.us-east-1.elb.amazonaws.com`.

## 7. Auto Scaling Group (EC2 → Auto Scaling Groups → Create)

| Step | Setting |
|---|---|
| 1 | Name `flowboard-asg`, launch template `flowboard-lt` (Latest) |
| 2 | VPC default, choose the **same two+ AZ subnets** as the ALB |
| 3 | Attach to an existing load balancer → `flowboard-tg`; **turn on Elastic Load Balancing health checks**; health check grace period **900 s** (first boot builds both images, including the React app) |
| 4 | Desired **2**, Minimum **2**, Maximum **4**. Scaling policy: **Target tracking**, metric *Average CPU utilization*, target **50 %** |
| 5–7 | Optional tags: `Name = flowboard-asg-instance` → Create |

Wait 8–12 minutes. Target Groups → `flowboard-tg` → **Targets** should show **2 healthy** instances in
different AZs.

## 8. Verify and demo

1. Open `http://<alb-dns-name>` → register. The sidebar footer shows **Instance i-0abc… · AZ · Container**
   and a green **Live** dot (WebSocket connected through the ALB).
2. Open the same URL in a private window (new cookie) — you may land on the other instance.
3. Prove load balancing from a terminal (curl sends no cookie, so requests alternate):
   ```bash
   bash scripts/05-loadbalancer-check.sh http://<alb-dns-name>
   # ------------- per EC2 instance -------------
   #  i-0aaa...   10
   #  i-0bbb...   10
   # ------------- per API container ------------   (Nginx balancing the replicas inside each instance)
   ```
4. **Self-healing:** EC2 → Instances → terminate one ASG instance. The target turns *draining*, the
   ALB sends all traffic to the survivor (site stays up), and the ASG launches a replacement within a
   few minutes (Auto Scaling Group → *Activity* tab shows it).
5. **Scale out:** SSH into one instance and burn CPU:
   ```bash
   sudo dnf install -y stress-ng && stress-ng --cpu 0 --timeout 600
   ```
   After ~3–5 min the CloudWatch alarm fires and the ASG adds instances (max 4). When stress stops,
   it scales back in. (Or simply edit *Desired capacity* to 3 to show manual scaling.)
6. On one instance, run the Linux / Docker / volume demos:
   ```bash
   cd /opt/flowboard
   PAUSE=1 bash scripts/01-linux-admin.sh
   bash scripts/02-docker-basics.sh
   bash scripts/03-volume-persistence.sh
   bash scripts/06-scale-and-realtime.sh
   ```
7. Selenium against the ALB (from your laptop or an instance):
   ```bash
   bash scripts/04-run-selenium.sh http://<alb-dns-name>
   ```

## 9. Clean up (avoid charges)

Delete in this order: **Auto Scaling Group** (terminates its instances) → **Load Balancer** →
**Target Group** → **Launch Template** → security groups → key pair.

## Troubleshooting

| Symptom | Check |
|---|---|
| Targets stay *unhealthy* | `sudo cat /var/log/flowboard-userdata.log` on the instance; is port 80 allowed from `flowboard-alb-sg`? Is the health path `/api/health`? |
| `git clone` failed in the log | Repo is private or `REPO_URL` wasn't edited |
| ASG keeps replacing instances | Grace period too short — set 900 s so the first build can finish |
| 502 Bad Gateway from ALB | Containers still starting — `docker compose ps` / `docker compose logs api` |
| Logged out / "Account no longer exists" | Target-group stickiness is off (see step 5) |
| Sidebar says "Reconnecting…" | WebSocket blocked — check the ALB listener is HTTP:80 → target group, and that nothing strips the `Upgrade` header |
| Build killed / "JavaScript heap out of memory" | Instance too small — use `t3.small`, or check `free -h` shows the swap |
| `docker: permission denied` as ec2-user | Log out and back in (group membership refresh) or use `sudo` |
