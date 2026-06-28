# Clerk production-instance migration (the likely fix for the login blocker)

## Why
The app uses a Clerk **development** instance (`pk_test_…`, `pretty-pika-17.clerk.accounts.dev`).
Dev instances use a shared domain + a "development browser" handshake that is fragile inside the
Capacitor iOS webview (origin `https://localhost`). Symptoms seen on real builds: Clerk rejects the
`redirect_url` ("Invalid URL scheme") on social sign-in, and email sign-in stalls silently. Clerk
states dev instances are not for real app traffic. A **production** instance with a real domain
handles origins/redirects/cookies correctly — the highest-confidence fix.

## Owner steps (~10 min, Clerk dashboard) — only you can do these
1. Clerk Dashboard → create / promote to a **Production** instance for this app.
2. Set a **domain** you control (e.g. `looperapp.org` or `auth.looperapp.org`) and complete Clerk's
   DNS records (CNAMEs Clerk provides). This is what makes prod sign-in work off a real origin.
3. Enable the SAME sign-in methods you want (email/password, email code, and any social — if social,
   configure each provider's OAuth credentials for production).
4. Under the instance's **allowed origins / redirect URLs**, add the app origin **`https://localhost`**
   (Capacitor webview) so the native build is accepted.
5. Hand me three values:
   - `pk_live_…` (production **publishable** key)
   - production **JWKS URL** (`https://<your-domain>/.well-known/jwks.json` or the Clerk-provided one)
   - production **issuer** (`https://<your-domain>` or the Clerk Frontend API URL)
   (Keep the `sk_live_…` secret to yourself — the app doesn't need it; only set it on the server if
   we later use Clerk's Backend API.)

## My steps (fast, once you provide the 3 values)
1. `ops/ios/ship.sh`: swap the default `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the `pk_test_…` to
   your `pk_live_…` (kept overridable via env).
2. Backend (EC2 `backend/.env`, via the deploy): set `CLERK_JWKS_URL` + `CLERK_ISSUER` to the
   production values; redeploy (auto on merge to main).
3. Cut a fresh TestFlight build (`1.0.N`) from main with the prod key.
4. Verify: the new build's sign-in screen → sign in → voice transcribes (now backed by the auth
   E2E gate too).

## If pk_live still isn't enough
Fall back to debugging with the new **auth E2E harness** (web reproduction) + a device/simulator
smoke; the remaining native-webview-specific options are Clerk's hosted Account Portal opened via the
Capacitor Browser plugin + a deep link back, or email-only auth in the webview.
