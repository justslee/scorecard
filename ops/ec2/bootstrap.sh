#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Looper backend bootstrap — one idempotent command to stand up (or repair) the
# FastAPI service on a fresh EC2 box. Safe to re-run.
#
# Encodes the secure topology:
#     api.looperapp.org → ALB (TLS) → instance :80 (nginx) → 127.0.0.1:8000 (uvicorn)
# uvicorn stays loopback-only; nginx is the sole listener; the ALB is the only
# thing the security group lets reach :80.
#
# Run ON the box, as the 'ubuntu' user, after cloning the repo:
#     git clone https://github.com/justslee/scorecard.git ~/scorecard
#     bash ~/scorecard/ops/ec2/bootstrap.sh
#
# Optional overrides (env): REPO, DB_NAME, DB_USER, DB_PASSWORD
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${REPO:-$HOME/scorecard}"
DB_NAME="${DB_NAME:-looper}"
DB_USER="${DB_USER:-looper}"
DB_PASSWORD="${DB_PASSWORD:-looper_beta_pw}"   # override to match an existing .env

echo "▸ [1/7] System packages (postgres, postgis, nginx)…"
sudo apt-get update -y
sudo apt-get install -y postgresql postgis nginx

echo "▸ [2/7] Database role + db + PostGIS (idempotent)…"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_USER}') THEN CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'; END IF; END \$\$;"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
fi
sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

echo "▸ [3/7] Apply schema migrations (idempotent)…"
for f in "${REPO}"/backend/supabase/migrations/*.sql; do
  echo "    >> $(basename "$f")"
  PGPASSWORD="${DB_PASSWORD}" psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "▸ [4/7] .env scaffold (only if missing — never clobbers secrets)…"
ENV="${REPO}/backend/.env"
if [ ! -f "${ENV}" ]; then
  cat > "${ENV}" <<EOF
DATABASE_URL=postgresql+asyncpg://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
CLERK_JWKS_URL=
CLERK_ISSUER=
OWNER_CLERK_USER_ID=
ANTHROPIC_API_KEY=
DEEPGRAM_API_KEY=
GOLF_API_KEY=
MAPBOX_TOKEN=
EOF
  echo "    created ${ENV} — FILL IN the Clerk + API values, then re-run step 7 (restart)."
else
  echo "    ${ENV} exists — left untouched."
fi

echo "▸ [5/7] Python deps…"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
( cd "${REPO}/backend" && "${UV}" sync )

echo "▸ [6/7] nginx site (:80 → 127.0.0.1:8000)…"
sudo cp "${REPO}/deploy/nginx.conf" /etc/nginx/sites-available/scorecard-api
sudo ln -sf /etc/nginx/sites-available/scorecard-api /etc/nginx/sites-enabled/scorecard-api
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "▸ [7/7] systemd service (uvicorn on 127.0.0.1:8000, loopback only)…"
sudo cp "${REPO}/deploy/scorecard-api.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scorecard-api
sudo systemctl restart scorecard-api

echo "▸ Verifying…"
sleep 2
curl -fsS http://localhost:8000/health >/dev/null && echo "    ✓ app reachable on loopback:8000"
curl -fsS http://localhost/health      >/dev/null && echo "    ✓ nginx serving on :80"

cat <<'NOTE'

✅ On-box setup complete. Two one-time AWS-console steps remain (only you can do these):
   1. Target group → register THIS instance on PORT 80 (not 8000).
   2. Instance security group → inbound :80 from the ALB's security group only
      (nothing public on 8000).
Then the ALB health check (GET /health on :80) goes healthy and
https://api.looperapp.org serves this backend.

Future code deploys are just:  cd ~/scorecard && git pull && sudo systemctl restart scorecard-api
NOTE
