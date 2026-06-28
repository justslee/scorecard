#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ship Looper to TestFlight in one command: build the static web app with the
# production client env, wrap it natively (Capacitor), archive (unsigned), then
# distribution-sign + upload via the App Store Connect API key. No device, no
# Xcode clicking, no Console.
#
# Requirements (one-time): Xcode + the ASC API key staged at
#   ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8
# The .p8 is the only secret and is NEVER committed — it stays on disk.
#
# Usage:  bash ops/ios/ship.sh
# Override any value via env, e.g.:  NEXT_PUBLIC_MAPBOX_TOKEN=pk.xxx bash ops/ios/ship.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
FRONTEND="$REPO/frontend"

# Public client config — baked into the bundle at build time (not secret).
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://api.looperapp.org}"
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_test_cHJldHR5LXBpa2EtMTcuY2xlcmsuYWNjb3VudHMuZGV2JA==}"
export NEXT_PUBLIC_MAPBOX_TOKEN="${NEXT_PUBLIC_MAPBOX_TOKEN:-}"

# App Store Connect signing — IDs are not secret; the .p8 referenced by path is.
ASC_KEY_ID="${ASC_KEY_ID:-QG927KHTXR}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-f58bfc06-549c-4a78-a4ae-3df6d5e3939a}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
TEAM_ID="${TEAM_ID:-X3F694PQ8B}"

# Monotonic build number (Apple requires a higher CFBundleVersion each upload).
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
# Human-readable release version (CFBundleShortVersionString) so each TestFlight
# release is distinguishable instead of all showing "1.0". Auto-increments via the
# git commit count (0.1.N). Override for a real milestone:
#   MARKETING_VERSION=1.0.0 bash ops/ios/ship.sh
MARKETING_VERSION="${MARKETING_VERSION:-0.1.$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 0)}"
ARCHIVE="/tmp/Looper-${BUILD_NUMBER}.xcarchive"

[ -f "$ASC_KEY_PATH" ] || { echo "ERROR: ASC key not found at $ASC_KEY_PATH"; exit 1; }

echo "▸ [1/4] Build static web export (API=$NEXT_PUBLIC_API_URL)…"
( cd "$FRONTEND" && npm run build )

echo "▸ [2/4] Sync web + plugins into iOS…"
( cd "$FRONTEND" && npx cap sync ios )

echo "▸ [3/4] Archive unsigned (v$MARKETING_VERSION build $BUILD_NUMBER)…"
xcodebuild -project "$FRONTEND/ios/App/App.xcodeproj" \
  -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -clonedSourcePackagesDirPath /tmp/looper-spm \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  archive

echo "▸ [4/4] Distribution-sign + upload to TestFlight…"
PLIST="$(mktemp -d)/ExportOptions.plist"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLISTEOF

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "/tmp/LooperExport-${BUILD_NUMBER}" \
  -exportOptionsPlist "$PLIST" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

echo "✅ Uploaded v${MARKETING_VERSION} (build ${BUILD_NUMBER}) to TestFlight — processing on Apple's side now."
