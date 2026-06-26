# Looper — Owner Setup Runbook

The granular, owner-only track for standing up the secure private beta. These are the
things **only you** can do (the agents are blocked from infra/secrets/signing by the
guard hook). Work top to bottom; rough one-time effort is in brackets.

## Guiding principle
Agents never hold AWS admin credentials or signing certs. They propose infrastructure
as **code** (you review + apply) and use a least-privilege **EC2 instance role** at
runtime. You stay the gate for anything that touches money, secrets, or a public release.

## Recurring cost (rough)
Domain ~$12/yr · Apple Developer $99/yr · AWS ~$40–70/mo · Claude $100/mo (+ ≤$50 overflow)

---

## A. Keys & secrets [15 min] — NOT a blanket rotation
You verified nothing was leaked, so most keys are fine as-is. Do only:
- [ ] **Restrict the Mapbox token** (Mapbox dashboard → token → URL restrictions → your
      web origin + `capacitor://localhost`). No need to create a new one.
- [ ] **OCR/Anthropic key:** ONLY if you ever pasted a real Anthropic key into the app's
      old Settings screen (the `ocr.ts` browser path), create a new one and delete the old.
      Otherwise skip — that code path is being removed in Phase B1.
- [ ] Server keys (Anthropic / OpenAI / Deepgram / GolfAPI): **no action** — backend-only,
      never committed. They just move into Secrets Manager (section C).

## B. Apple / TestFlight [needs your Mac once, ~1–2 hrs]
- [ ] Confirm Apple Developer enrollment ($99/yr).
- [ ] App Store Connect → **+ New App** → bundle id `com.<you>.looper`. Add yourself as an
      **Internal TestFlight tester**.
- [ ] On your Mac: `cd frontend && npx cap add ios`, open `ios/App` in Xcode, set your
      signing **Team** (let Xcode manage signing automatically).
- [ ] Xcode → **Xcode Cloud** → new workflow: trigger on branch `release/*` → Archive →
      **TestFlight (Internal Only)**. Grant it access to the GitHub repo.
- After this one-time setup, builds run in Apple's cloud — no Mac needed again. Agents
  trigger builds by pushing `release/*`; **you** stay the gate for any public App Store release.

## C. AWS foundation [2–4 hrs] — review + apply the CloudFormation I'll draft for you
- [ ] Use an **IAM admin user with MFA** (never the root account).
- [ ] **RDS PostgreSQL**: `db.t4g.micro`, **Not publicly accessible**, storage **encrypted**.
      Security group: allow `5432` **only from the EC2's security group**. Then connect once
      from the EC2 and run `CREATE EXTENSION postgis;`.
- [ ] **Secrets Manager**: one secret `looper/prod` holding every key + `DATABASE_URL`
      (the RDS endpoint) + `OWNER_CLERK_USER_ID` + `CLERK_JWKS_URL` + `CLERK_ISSUER` +
      `ALLOWED_ORIGIN`.
- [ ] **IAM instance role** for the EC2: least-privilege policy = read **only** the
      `looper/prod` secret + write CloudWatch logs. Attach it as the instance profile
      (→ no static keys ever live on the box).
- [ ] **EC2** (`t4g.small`): attach the role. Security group = SSH from your IP (or use
      **SSM Session Manager** and close port 22 entirely); app port reachable **only from
      the ALB**.
- [ ] **CloudWatch**: a log group for the API + the agent loop, and one alarm → **SNS topic
      → your email** (covers "agent loop down" and "overflow spend spiking").

## D. Domain & HTTPS [30 min]
- [ ] Buy a domain (~$12/yr; Route 53 or any registrar). Required for a trusted cert — a
      bare IP can't get one. The **ACM certificate itself is free** and auto-renews.
- [ ] **ACM**: request a cert for `api.<domain>` (DNS-validated).
- [ ] **ALB**: HTTPS:443 listener using that cert → target group → EC2:8000. Point
      `api.<domain>` at the ALB.
- Alternative (no domain): Tailscale / Cloudflare Tunnel — but then your phone runs an
  always-on VPN/tunnel. A $12 domain is simpler.

## E. Wire env & deploy [30 min]
- [ ] systemd `ExecStartPre` pulls `looper/prod` via the instance role → writes a `0600`
      env file → starts the API.
- [ ] The agent team does **not** run on the EC2 — it runs on **your Mac** under your Max
      login (see `ops/mac/RUN.md`). The EC2 hosts **only the backend API**.
- [ ] Set `NEXT_PUBLIC_API_URL=https://api.<domain>` as an **Xcode Cloud** build env var.
- [ ] Local dev only: set `ALLOW_ANONYMOUS=1` so the fail-closed auth gate lets you in
      without a Clerk token.

## F. Claude billing cap [2 min]
- [ ] claude.ai → **Settings → Usage** → enable usage credits, **$50/mo cap, auto-reload OFF**.

---

## Giving me / the agents AWS access safely (optional)
- **Default (recommended):** I never hold AWS creds. Infra is owner-applied IaC; runtime
  uses the instance role. Full audit trail, hard ceiling on what any agent can touch.
- **If you want me to read/deploy directly:** a dedicated, **narrowly-scoped IAM role**
  (specific ARNs only), assumed via **short-lived STS/SSO** credentials (never long-lived
  keys), with a **permissions boundary** + **CloudTrail** logging. Prefer **SSM Session
  Manager** over SSH for any shell access.

## Will the agents submit apps?
- **Beta builds to you: yes, automatically.** Agents push `release/*` → Xcode Cloud builds,
  signs (cloud-managed), and uploads to **TestFlight Internal** (no review for internal).
- **Public App Store: no.** That needs App Store Review + your manual "Release." Agents
  deliver beta builds to your phone; you decide what ever goes public.

## Env var reference
| Variable | Where | Public? | Notes |
|---|---|---|---|
| `DATABASE_URL` | backend (Secrets Mgr) | no | `postgresql+asyncpg://…@<rds>:5432/looper` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` / `GOLF_API_KEY` | backend | no | server-only |
| `OWNER_CLERK_USER_ID` | backend | no | the only identity the API serves |
| `CLERK_JWKS_URL` / `CLERK_ISSUER` | backend | no | enables real JWT verification |
| `ALLOWED_ORIGIN` | backend | no | extra CORS origin(s) for a web build, comma-separated |
| `ALLOW_ANONYMOUS` | backend (dev only) | no | `1` for local dev; never set in prod |
| `NEXT_PUBLIC_API_URL` | frontend build | yes | `https://api.<domain>` |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | frontend build | yes | public, URL-restricted (section A) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | frontend build | yes | public by design |
