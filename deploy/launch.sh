#!/bin/bash
# ─────────────────────────────────────────────────────────
# Launch Scorecard API on AWS EC2 via CloudFormation
#
# Prerequisites:
#   brew install awscli
#   aws configure  (set your access key, secret, region)
#
# Usage:
#   bash deploy/launch.sh
# ─────────────────────────────────────────────────────────

set -euo pipefail

STACK_NAME="scorecard-api"
TEMPLATE="$(dirname "$0")/cloudformation.yaml"

echo "=== Scorecard API - AWS Launcher ==="
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo "Error: AWS CLI not installed. Run: brew install awscli && aws configure"
    exit 1
fi

# Check region is set
REGION=$(aws configure get region 2>/dev/null || true)
if [ -z "$REGION" ]; then
    echo "Error: AWS region not configured. Run: aws configure"
    exit 1
fi
echo "Region: $REGION"

# Get user's public IP for SSH security group
echo ""
echo "Detecting your public IP..."
MY_IP=$(curl -s checkip.amazonaws.com)
echo "Your IP: $MY_IP"

# Prompt for key pair
echo ""
echo "Available key pairs:"
aws ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text | tr '\t' '\n' | head -10
echo ""
read -p "Key pair name (or 'new' to create one): " KEY_PAIR

if [ "$KEY_PAIR" = "new" ]; then
    read -p "New key pair name: " KEY_PAIR
    aws ec2 create-key-pair --key-name "$KEY_PAIR" --query 'KeyMaterial' --output text > ~/"$KEY_PAIR.pem"
    chmod 400 ~/"$KEY_PAIR.pem"
    echo "Key saved to ~/$KEY_PAIR.pem"
fi

# Prompt for API keys
echo ""
read -p "Git repo URL (HTTPS clone URL): " GIT_REPO
read -p "Anthropic API key [skip]: " ANTHROPIC_KEY
read -p "GolfAPI.io key [skip]: " GOLF_KEY
read -p "Mapbox token [skip]: " MAPBOX_KEY

# Deploy
echo ""
echo "Deploying CloudFormation stack: $STACK_NAME"
echo "  Instance: t4g.micro (ARM64, ~\$6/mo)"
echo "  Security: SSH from $MY_IP/32, HTTP/HTTPS from anywhere"
echo ""
read -p "Continue? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo "Aborted."
    exit 0
fi

aws cloudformation deploy \
    --template-file "$TEMPLATE" \
    --stack-name "$STACK_NAME" \
    --parameter-overrides \
        "KeyPairName=$KEY_PAIR" \
        "SSHAllowedIP=$MY_IP/32" \
        "GitRepoUrl=${GIT_REPO:-}" \
        "AnthropicApiKey=${ANTHROPIC_KEY:-}" \
        "GolfApiKey=${GOLF_KEY:-}" \
        "MapboxToken=${MAPBOX_KEY:-}" \
    --no-fail-on-empty-changeset

echo ""
echo "=== Stack deployed! ==="
echo ""

# Get outputs
aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs' \
    --output table

echo ""
echo "The instance is bootstrapping (takes ~2-3 min)."
echo "Check progress: ssh into the instance, then: tail -f /var/log/scorecard-setup.log"
echo ""
echo "To tear down everything:"
echo "  aws cloudformation delete-stack --stack-name $STACK_NAME"
