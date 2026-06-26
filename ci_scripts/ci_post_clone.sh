#!/bin/sh
# Xcode Cloud post-clone hook.
#
# The Capacitor iOS project references its plugins via LOCAL paths into
# frontend/node_modules (which is gitignored), and the app's web layer is a
# Next.js static export. A fresh Xcode Cloud checkout has neither, so Swift
# Package resolution fails with:
#   the package at '.../node_modules/@capacitor/camera' cannot be accessed
#
# Restore JS deps, build the web bundle, and sync it into the iOS project BEFORE
# Xcode resolves Swift packages.
set -e

echo "▸ Installing Node…"
brew install node

cd "$CI_PRIMARY_REPOSITORY_PATH/frontend"

echo "▸ Installing JS dependencies (npm ci)…"
npm ci

echo "▸ Building the static web export…"
# The NEXT_PUBLIC_* client values are baked in at build time. Set them in the
# Xcode Cloud workflow's Environment Variables:
#   NEXT_PUBLIC_API_URL                 e.g. https://api.looperapp.org
#   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   pk_test_… / pk_live_…
#   NEXT_PUBLIC_MAPBOX_TOKEN            pk.…  (for the GPS map view)
npm run build

echo "▸ Syncing web assets + plugins into iOS…"
npx cap sync ios

echo "▸ ci_post_clone complete."
