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
# PRODUCTION Clerk instance (clerk.looperapp.org). Publishable keys are public.
# Swapped from the dev pk_test on 2026-06-28 — the dev instance couldn't mint
# session tokens in the Capacitor webview (cause of the persistent login 401s).
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_live_Y2xlcmsubG9vcGVyYXBwLm9yZyQ}"

# NEXT_PUBLIC_GOOGLE_MAPS_KEY: baked into the JS bundle at Next.js build time.
# Passed to @capacitor/google-maps GoogleMap.create({ apiKey }) so the native
# iOS Google Maps SDK authenticates via the iOS bundle restriction on this key.
# If not already set in the environment, pull from AWS Secrets Manager (looper/client).
# The build machine IAM role has read access to looper/client (verified).
# The secret is NEVER printed or committed — unset immediately after export.
# When absent (no creds / key missing) we warn and skip; the app falls back to
# the on-paper HoleDiagram renderer.
if [ -z "${NEXT_PUBLIC_GOOGLE_MAPS_KEY:-}" ]; then
  _gm_key="$(aws secretsmanager get-secret-value \
      --secret-id looper/client \
      --region us-east-1 \
      --query SecretString \
      --output text 2>/dev/null \
    | jq -r '.GOOGLE_MAPS_KEY // empty' 2>/dev/null \
    || true)"
  if [ -n "${_gm_key:-}" ]; then
    export NEXT_PUBLIC_GOOGLE_MAPS_KEY="$_gm_key"
    echo "▸ Google Maps key loaded from looper/client (${#_gm_key} chars)"
  else
    echo "WARN: GOOGLE_MAPS_KEY not found in looper/client — hole map will fall back to HoleDiagram"
    export NEXT_PUBLIC_GOOGLE_MAPS_KEY=""
  fi
  unset _gm_key   # never leave the key in a shell variable
fi

# NOTE: Mapbox (NEXT_PUBLIC_MAPBOX_TOKEN) is retired — the hole-map renderer
# was switched to @capacitor/google-maps in feat/google-satellite-map.
# CaddiePanel.tsx still uses mapboxgl directly; its token is embedded in the
# looper/prod secret and loaded by the backend; it is NOT needed at build time.

# App Store Connect signing — IDs are not secret; the .p8 referenced by path is.
ASC_KEY_ID="${ASC_KEY_ID:-QG927KHTXR}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-f58bfc06-549c-4a78-a4ae-3df6d5e3939a}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
TEAM_ID="${TEAM_ID:-X3F694PQ8B}"

# Monotonic build number (Apple requires a higher CFBundleVersion each upload).
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
# Human-readable release version (CFBundleShortVersionString) so each TestFlight
# release is distinguishable. MUST be 1.0.N (not 0.1.N): early builds shipped as
# "1.0", and TestFlight sorts by version string — a 0.1.x version sorts BELOW "1.0",
# so those builds were buried under the old "1.0" entry and looked like they never
# arrived. 1.0.N (N = git commit count) is monotonic AND always above "1.0".
# Override for a real milestone:  MARKETING_VERSION=1.1.0 bash ops/ios/ship.sh
MARKETING_VERSION="${MARKETING_VERSION:-1.0.$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 0)}"
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
