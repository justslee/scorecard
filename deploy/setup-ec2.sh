#!/bin/bash
# ─────────────────────────────────────────────────────────
# EC2 Setup Script for Scorecard API
#
# Tested on: Ubuntu 24.04 LTS (ARM64 t4g.micro recommended)
#
# Usage:
#   1. Launch EC2 instance (t4g.micro, Ubuntu 24.04, 8GB gp3)
#   2. SSH in: ssh -i your-key.pem ubuntu@<public-ip>
#   3. Clone repo: git clone <repo-url> ~/scorecard
#   4. Run: bash ~/scorecard/deploy/setup-ec2.sh
#   5. Create env: cp ~/scorecard/backend/.env.example ~/scorecard/backend/.env
#   6. Edit env: nano ~/scorecard/backend/.env  (add your API keys)
#   7. Start: sudo systemctl start scorecard-api
# ─────────────────────────────────────────────────────────

set -euo pipefail

echo "=== Scorecard API - EC2 Setup ==="

# System updates
echo "[1/6] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# Install Python 3.11+ and nginx
echo "[2/6] Installing Python, nginx, certbot..."
sudo apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    nginx \
    certbot \
    python3-certbot-nginx \
    git \
    curl

# Install Python dependencies
echo "[3/6] Installing Python packages..."
cd ~/scorecard/backend
pip3 install --user \
    "anthropic>=0.77.0" \
    "fastapi>=0.115.0" \
    "httpx>=0.27.0" \
    "python-dotenv>=1.0.0" \
    "uvicorn>=0.30.0"

# Ensure data directory exists
mkdir -p ~/scorecard/backend/data

# Set up systemd service
echo "[4/6] Setting up systemd service..."
sudo cp ~/scorecard/deploy/scorecard-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scorecard-api

# Set up nginx
echo "[5/6] Configuring nginx..."
sudo cp ~/scorecard/deploy/nginx.conf /etc/nginx/sites-available/scorecard-api
sudo ln -sf /etc/nginx/sites-available/scorecard-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

# Create .env template if it doesn't exist
echo "[6/6] Setting up environment..."
if [ ! -f ~/scorecard/backend/.env ]; then
    cat > ~/scorecard/backend/.env << 'ENVEOF'
# Scorecard API Environment Variables
# Fill in your keys below, then run: sudo systemctl restart scorecard-api

ANTHROPIC_API_KEY=
GOLF_API_KEY=
MAPBOX_TOKEN=

# Optional: override Claude model (default: claude-sonnet-4-5-20250929)
# ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
ENVEOF
    echo "  Created .env template at ~/scorecard/backend/.env"
    echo "  >>> EDIT THIS FILE with your API keys before starting the service <<<"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit your API keys:     nano ~/scorecard/backend/.env"
echo "  2. Start the service:      sudo systemctl start scorecard-api"
echo "  3. Check status:           sudo systemctl status scorecard-api"
echo "  4. View logs:              journalctl -u scorecard-api -f"
echo "  5. Test health:            curl http://localhost:8000/health"
echo ""
echo "For HTTPS (recommended):"
echo "  1. Point your domain to this server's IP"
echo "  2. Run: sudo certbot --nginx -d your-domain.com"
echo ""
echo "To update later:"
echo "  cd ~/scorecard && git pull"
echo "  sudo systemctl restart scorecard-api"
echo ""
echo "Estimated cost: ~\$6/mo (t4g.micro) or FREE (first year free tier)"
