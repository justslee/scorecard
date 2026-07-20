# P0 fix plan — azp check flip incident (`multiuser-p0-authz-flip-fix-plan.md`)

Base branch: `origin/integration/next`. Backend-only, no UI, no shared shapes touched
(`frontend/src/lib/types.ts` / `backend/app/models.py` untouched). No new dependencies
(canary is Python stdlib only). Produced by the Fable Plan agent (owner directive:
Plan + top-stakes security reviews run on fable).

## 0. Verified ground truth (read from the tree, not re-derived)

- `backend/app/services/clerk_auth.py:54-77` — `_verified_user_id` order is: JWKS key lookup →
  `jwt.decode(algorithms=["RS256"], issuer=CLERK_ISSUER ...)` (signature + issuer + exp verified
  inside `decode`) → azp check → sub check. **Signature and issuer pinning already run before the
  azp branch** — the fix's precondition holds today with no reordering needed.
- The buggy branch (`clerk_auth.py:69-72`): `if not azp or azp not in authorized_parties: raise
  HTTPException(401, ...)` — rejects **absent** azp whenever `CLERK_AUTHORIZED_PARTIES` is set.
- `frontend/capacitor.config.ts:43-45` (`CapacitorHttp: enabled`) + `frontend/src/components/
  AuthProvider.tsx:66-99` — all native FAPI traffic goes through NSURLSession with
  `credentials: "omit"`, `_is_native=1`, and no browser `Origin` header. Clerk sets `azp` from the
  FAPI request's Origin and **omits it when Origin is absent** → every native-app session token has
  no `azp`. The flip env (`CLERK_AUTHORIZED_PARTIES=https://localhost,https://looperapp.org,
  https://www.looperapp.org`) therefore 401'd every owner request. `CLERK_ISSUER`/`CLERK_JWKS_URL`
  were unchanged pre/post flip → azp was the sole new rejection surface. Root cause is conclusive.
- Provenance: `specs/multi-user-epic-plan.md` §3.4 ("reject tokens whose `azp` claim is **present
  and** not in the set" — original, correct policy) vs §3.8 SHOULD-FIX #2 ("absent **OR** not in
  the allowlist" — the hardening that broke native). `specs/auth-headless-spike-verdict.md` §4
  explicitly records "Observed azp/iss: not observed this session" and §6 leaves the azp capture
  unchecked — the `azp=https://localhost` assumption was never empirically confirmed. The hardening
  shipped against an unverified assumption.
- Boot guard (`clerk_auth.py:230-242`): open mode **requires** `CLERK_ISSUER` and
  `CLERK_AUTHORIZED_PARTIES` set — so on any real flip, the azp branch is guaranteed active and
  issuer pinning is guaranteed on. This matters for the proof below.
- Routes for the canary (verified): `GET /api/rounds` = `backend/app/routes/rounds.py:200-201`
  (`@router.get("")`, prefix `/api/rounds`), `GET /api/caddie/profile` =
  `backend/app/routes/caddie.py:1461-1462` (`@router.get("/profile")`, prefix `/api/caddie`). Both
  routers are mounted with `dependencies=[Depends(require_member)]` in `backend/app/main.py:71-92`,
  and both handlers also take `Depends(current_user_id)`; in prod both paths run the real
  `_verified_user_id`.
- `backend/tests/integration/test_flip_gate.py` uses `set_auth(..., gate=True)`
  (`backend/tests/integration/conftest.py:199-239`), which **overrides `current_user_id` via
  FastAPI dependency_overrides** — `_verified_user_id` is never invoked anywhere in the flip_gate
  suite (the fixture's `CLERK_AUTHORIZED_PARTIES` is set only to satisfy `_assert_boot_config`). A
  more-permissive azp check cannot affect it; the suite stays green by construction.
- `backend/tests/test_clerk_jwt_parity.py` mints **real RS256-signed** tokens and always includes
  `azp` in its baseline payload — no absent-azp-rejection pin there. The only test encoding the
  buggy policy is `backend/tests/test_clerk_auth.py:207`
  (`test_missing_azp_is_rejected_when_configured`), plus the `TestAzpHardening` docstring at line 181.

## 1. Security analysis — is allowing absent-azp safe? (the load-bearing section)

**Verdict: yes.** The proposed direction is correct; no forgery or replay hole. Reasoning, per threat:

**(a) What does azp defend here — is CSRF in scope? No.** azp (authorized party) is an
origin-provenance claim. Its classic value is against *confused-deputy / cross-site* attacks where
credentials ride **ambiently** (cookies). Looper's backend consumes **explicit `Authorization:
Bearer` headers** set programmatically by the app (`AuthProvider.tsx` / clerk-js). A cross-site
attacker page cannot cause the victim's browser to attach that header — there is no ambient
credential to ride. CSRF is structurally out of scope for this API, so azp is not carrying CSRF
defense weight here.

**(b) The epic's assigned threat: "token replay from another Clerk app" (§3.4 threat table).** A
different Clerk *application* means a different Clerk **instance**, which means a different signing
keypair and a different `iss`. Such a token is rejected by the JWKS signature check (wrong key) and
by issuer pinning (wrong `iss`) — both of which run *before* the azp branch and both of which the
open-mode boot guard makes mandatory. azp contributes nothing to that threat. azp only discriminates
between **frontend origins of the same Clerk instance** — and Looper's instance
(`clerk.looperapp.org`) serves exactly one product: the Looper web origins + the Capacitor
`https://localhost` origin. There is no second frontend app sharing this instance whose tokens
should be excluded.

**(c) Can an attacker obtain a validly-signed, correct-issuer, azp-absent token without being a
legitimate member? No.** To hold *any* session token from this instance, a principal must complete
Clerk authentication and thereby exist as a `sub`. In open mode, **every verified `sub` is admitted
by design** (that is what the flip is). So the set of principals admitted via absent-azp tokens is
exactly the set already admitted via present-azp tokens — allowing absent azp changes *provenance
labeling*, not *who can authenticate*. Corollaries:
- An attacker cannot **strip** azp from someone else's web-minted token: azp is inside the
  RS256-signed payload; removing/altering it invalidates the signature.
- Origin-less tokens can also be minted via Clerk's **Backend API** — but that requires the
  `sk_live` secret key, whose holder can already impersonate any user regardless of azp policy.
- Token **theft/replay**: azp never defended this. A thief replays the token byte-for-byte — its
  original valid azp comes along; only signature lifetime (~60s) and revocation bound theft.

**(d) The actual isolation boundary.** Cross-tenant isolation is enforced by per-row scoping
(`owner_id`/`user_id` filters), the isolation suite (`test_authz_isolation.py`,
`test_flip_gate.py`), and `ci_scripts/scoping_lint.py` — azp was never an isolation mechanism and
this change does not touch that boundary.

**Residual risk, stated honestly:**
1. **Future shared-instance topology.** If Looper ever adds a second frontend on the *same* Clerk
   instance whose tokens should NOT reach this API, an origin-less client of that app would pass.
   Mitigation: (i) present-but-mismatched azp is **still rejected** (kept); (ii) that topology
   doesn't exist and should be a flagged architectural decision if it ever does. Recorded as a
   standing note in the epic.
2. **Weaker misconfiguration tripwire** — nil in the config that matters, because the boot guard
   makes `CLERK_ISSUER` mandatory in open mode.
3. **Keep the mismatch rejection.** Present-but-not-allowlisted azp remains a 401: free hardening,
   now loudly diagnosable via logging, and the defense for web-origin replay if the instance is
   ever shared.

**Conclusion:** the only behavior lost vs the buggy policy is rejection of origin-less tokens — and
the product's **primary client's legitimate tokens are origin-less**. The buggy policy is simply
incompatible with the app; the epic's original §3.4 policy is the correct one. Direction confirmed.

## 2. Deliverable 1 — the amended check (`backend/app/services/clerk_auth.py`)

Replace lines 65-72 of `_verified_user_id` (verify-order preserved: signature → issuer → azp →
sub; `_authorized_parties()` opt-in semantics unchanged — unset env means no check at all):

```python
    # azp check — §3.4 ORIGINAL policy, restored after the 2026-07 flip
    # incident: when CLERK_AUTHORIZED_PARTIES is configured, reject a token
    # whose azp claim is PRESENT and not on the allowlist. An ABSENT azp is
    # ALLOWED: Clerk derives azp from the FAPI request's Origin header and
    # OMITS it when there is no Origin — the native iOS app (CapacitorHttp →
    # NSURLSession, see frontend/capacitor.config.ts) sends no Origin, so its
    # tokens NEVER carry azp. This branch runs only AFTER full RS256
    # signature verification against our own instance's JWKS and after
    # CLERK_ISSUER pinning (jwt.decode above; both mandatory in open mode via
    # _assert_boot_config), so an origin-less token is still
    # cryptographically proven to come from THIS Clerk instance. Empty-string
    # azp is treated the same as absent. Unset env = no azp check (unchanged).
    # See specs/multiuser-p0-authz-flip-fix-plan.md for the full analysis.
    authorized_parties = _authorized_parties()
    if authorized_parties is not None:
        azp = payload.get("azp")
        if azp and azp not in authorized_parties:
            log.warning(
                "auth reject: azp-mismatch (token azp=%r not in CLERK_AUTHORIZED_PARTIES)",
                azp,
            )
            raise HTTPException(401, "Token azp not authorized for this deployment")
        if not azp:
            log.debug("auth: azp absent/empty — allowed (origin-less client, e.g. native app)")

    sub = payload.get("sub")
    if not sub:
        log.warning("auth reject: missing-sub")
        raise HTTPException(401, "JWT missing sub claim")
    return sub
```

The `if azp and azp not in authorized_parties` form handles the edge exactly: `None` (absent) and
`""` (empty string) are both falsy → both allowed; any non-empty present value must be allowlisted.

## 3. Deliverable 2 — 401-reason observability (same file)

The incident was undiagnosable from journald because every reject path returns a bare 401 with no
server-side log. Add key-free, claim-name-only logging on every reject branch (logger
`looper.clerk_auth` already exists at line 21):

In `current_user_id` (lines 106-114):

```python
    if not token:
        log.info("auth reject: missing-bearer-token")
        raise HTTPException(401, "Missing Authorization: Bearer <token>")

    try:
        return _verified_user_id(token)
    except jwt.ExpiredSignatureError:
        log.warning("auth reject: token-expired")
        raise HTTPException(401, "Token expired")
    except jwt.InvalidIssuerError as e:
        log.warning("auth reject: issuer-mismatch (expected CLERK_ISSUER=%s)", CLERK_ISSUER)
        raise HTTPException(401, f"Token verification failed: {e}")
    except jwt.PyJWTError as e:
        log.warning("auth reject: token-verification-failed (%s: %s)", type(e).__name__, e)
        raise HTTPException(401, f"Token verification failed: {e}")
```

(`InvalidIssuerError` and `ExpiredSignatureError` are `PyJWTError` subclasses — order matters and
matches the existing structure; HTTP response bodies are byte-identical to today, only logging is
added. Signature failures, malformed tokens, and JWKS-key-not-found all land in the generic branch
and are identified by exception class name — PyJWT messages never contain the token.)

In `require_member` (line 200-201), the revoked branch:

```python
    if revocation.is_revoked(user_id):
        log.warning("auth reject: revoked-user (sub=%s)", user_id)
        raise HTTPException(403, "Forbidden: this account has been revoked.")
```

Also add a `log.debug("optional auth: token failed verification, treating as anonymous")` in
`optional_user_id`'s except branch (line 261-262).

**Reason-code inventory and PII justification:** `missing-bearer-token` (INFO — unauthenticated
probes/scanners are routine noise), `token-expired`, `issuer-mismatch`,
`token-verification-failed(<class>)` (covers signature/malformed/JWKS), `azp-mismatch`,
`missing-sub`, `revoked-user` (all WARNING), `azp-absent` (DEBUG — now normal traffic from every
native request; WARNING would flood journald). Never logged: the token, any signature material, the
secret key. Logged values and why they're safe: the token's `azp` (a public web origin URL,
`%r`-formatted against log injection), the *configured* `CLERK_ISSUER` (public deployment config),
and — only on the `revoked-user` branch — the `sub` (an opaque Clerk `user_…` id, already persisted
in `revoked_users` and already logged by `webhooks.py:169`; operationally required to identify which
banned account is knocking). No emails, no names, no other claim values.

One pre-existing behavior to note in the PR (not change): an azp-mismatch `HTTPException` raised
inside `_verified_user_id` propagates through `optional_user_id` (which catches only `PyJWTError`) —
unchanged by this fix, and now rarer since absent-azp no longer raises.

## 4. Deliverable 3 — the flip canary: `ops/flip_canary.py` (new file, executable, Python 3 stdlib only)

**Why this exact design:** a token minted server-side carries **no Origin → no `azp`** — it is
byte-shape-identical to the incident's failing native-app tokens, so a 200 through the real prod
gate is a true regression proof. `POST /v1/sessions` (direct session creation) is **not available
on production instances** (Looper is on `pk_live` / `clerk.looperapp.org`) — so the canary uses the
sign-in-token → FAPI-ticket flow, the documented production-safe path.

**Inputs** (no secrets on the command line):
- `--env-file` (default `~/scorecard/backend/.env`): parsed for `CLERK_SECRET_KEY`, `CLERK_ISSUER`,
  `OWNER_CLERK_USER_ID`. Fails with an actionable, secret-free message if `CLERK_SECRET_KEY` is
  missing (flip-day prerequisite: owner adds `sk_live_…` to `backend/.env` on the box).
- `--base-url` (default `http://localhost:8000` — on-box loopback; runbook invokes with
  `https://api.looperapp.org` to exercise the full ALB→nginx path).
- `--user-id` (default `OWNER_CLERK_USER_ID` from the env file; a dedicated test member can be passed).

**Steps:**
1. **Mint a single-use sign-in ticket** — `POST https://api.clerk.com/v1/sign_in_tokens`, header
   `Authorization: Bearer <CLERK_SECRET_KEY>`, JSON `{"user_id": "<id>", "expires_in_seconds": 300}`
   → response `.token`.
2. **Exchange at FAPI (no Origin header — the incident shape)** —
   `POST {CLERK_ISSUER}/v1/client/sign_ins?_is_native=1`, form-encoded `strategy=ticket&ticket=<token>`
   via `urllib.request` (which sends no Origin). Read `.response.created_session_id`.
3. **Mint the real session JWT** — `POST https://api.clerk.com/v1/sessions/{created_session_id}/tokens`,
   `Authorization: Bearer <CLERK_SECRET_KEY>`, optional `{"expires_in_seconds": 60}` → response
   `.jwt`. Genuine Clerk session token: RS256-signed by the prod instance, `iss = CLERK_ISSUER`,
   **no `azp`**.
4. **Shape assertion (output hygiene enforced):** base64-decode the JWT payload (no verification,
   stdlib) and print ONLY: sorted **claim names**, the `iss` value, `azp: ABSENT` (or
   `present=<origin>`), and `sub: present` as a boolean. The token string, the secret key, and the
   `sub` value are NEVER printed. All HTTP errors reported as `status + Clerk error code` only.
5. **Authed checks:** `GET {base}/api/rounds` and `GET {base}/api/caddie/profile` with
   `Authorization: Bearer <jwt>` → each must be **200** (fired immediately, inside the 60s TTL).
6. **Negative control:** same two routes with `Authorization: Bearer canary.garbage.token` → each
   must be **401** (proves the gate is on, not that auth is disabled).
7. **Cleanup (best-effort):** `POST https://api.clerk.com/v1/sessions/{sid}/revoke`.
8. Print one `PASS`/`FAIL` line per check + a final verdict; **exit 0 only if every check passed**.

The canary never sets `APP_ACCESS_MODE` (it only observes a running server) and is the only place
in the repo that mints a real token. Out of P0 scope: a `--expect-403` mode for a revoked account.

## 5. Deliverable 4 — offline tests

**`backend/tests/test_clerk_auth.py` — `TestAzpHardening` (lines 180-235).** This class's docstring
(line 181) and `test_missing_azp_is_rejected_when_configured` (line 207) **encode the buggy policy
and are updated as a deliberate product-policy correction** — flag this verbatim in the PR
description and commit message for the reviewer and `/security-review`: *the product policy itself
was wrong and caused a production incident; this is not editing tests to pass* (the CLAUDE.md "never
edit tests to make them pass" rule targets gaming a gate; here the pinned behavior is the bug). New
matrix (reusing the existing `_decode_stub`):

| Case | `CLERK_AUTHORIZED_PARTIES` | token `azp` | Expected |
|---|---|---|---|
| unset env unchanged (keep) | unset | absent | pass |
| **absent azp → ALLOW (was: reject — rename `test_missing_azp_is_allowed_when_configured`)** | set | absent | **pass, returns sub** |
| **empty-string azp treated as absent (new)** | set | `""` | pass |
| present-bad → reject (keep) | set | `https://evil.example.com` | 401 |
| present-good → pass (keep) | set | allowlisted | pass |
| missing sub after azp passes (keep) | set | allowlisted | 401 |
| **missing sub with absent azp (new — absent-azp must not skip the sub check)** | set | absent | 401 |
| **caplog: azp-mismatch logs `azp-mismatch` at WARNING; token value not in record (new)** | set | bad | log asserted |
| **caplog: absent-azp path emits nothing at WARNING (new)** | set | absent | no warning |

Note in the updated class docstring that both "native" and "web-request-without-Origin" are the
*same* absent case — Clerk omits the claim identically.

**`backend/tests/test_clerk_jwt_parity.py` — additive, real RS256 signatures + real issuer
verification:**
- `test_native_shaped_token_absent_azp_accepted_with_allowlist_set` — real-signed token with NO
  `azp`, `CLERK_ISSUER` set and matching, `CLERK_AUTHORIZED_PARTIES` set → accepted. **The incident's
  exact token shape as a permanent regression pin under full cryptographic verification.**
- `test_wrong_issuer_rejected_even_with_azp_absent` — no `azp`, wrong `iss`, allowlist set →
  rejected. Proves issuer pinning is the enforcing layer for origin-less tokens.

**`backend/tests/integration/test_flip_gate.py` — no changes needed, verified why:** it
authenticates via `conftest.set_auth(gate=True)`, which overrides the `current_user_id` dependency
itself (`conftest.py:235`) — `_verified_user_id` never executes in that suite, so the azp change
cannot affect it. Its module docstring calls `test_clerk_auth.py` a "frozen pin"; this plan edits
that pin deliberately (see the policy-correction flag) — do not change flip_gate itself.

## 6. Deliverable 5 — runbook edit (`specs/multi-user-epic-plan.md` §8)

**Replace step 4** ("Live post-flip smoke") with:

> 4. **Live post-flip smoke — BLOCKING canary first.** On the box, run
> `python3 ops/flip_canary.py --base-url https://api.looperapp.org` (reads `CLERK_SECRET_KEY` /
> `CLERK_ISSUER` / `OWNER_CLERK_USER_ID` from `backend/.env`; prerequisite: `sk_live_…` present
> there). It mints a REAL production Clerk session token server-side (Backend API sign-in-token →
> FAPI ticket exchange → session token) — an **origin-less token with NO `azp`**, the exact shape
> the native iOS app sends and the exact shape the first flip attempt rejected — and requires 200 on
> `GET /api/rounds`, 200 on `GET /api/caddie/profile`, and 401 on a garbage token. **The flip is not
> declared good until the canary prints PASS and exits 0.** If it fails: roll back (step 5) FIRST,
> then diagnose from journald — every auth reject now logs a named reason (`azp-mismatch` /
> `issuer-mismatch` / `token-expired` / `token-verification-failed` / `missing-sub` /
> `revoked-user`). Only after canary PASS, the manual checks: sign in with a second real Clerk
> account (sees empty rounds/pins/profile, never the owner's data; create a round + mark a pin;
> owner's app unaffected); verify a revoked test account 403s on `/api/rounds`. Owner account:
> everything byte-identical.

**Append to §8 an incident record paragraph** (new sub-heading
`### Incident record — first flip attempt (2026-07)`):

> The first owner→open flip was rolled back after ~15 minutes: every authenticated request from the
> owner's real iOS app returned 401 (server healthy). Root cause: the §3.8 SHOULD-FIX #2 hardening
> made `_verified_user_id` reject tokens whose `azp` was **absent** or not allowlisted — but Clerk
> derives `azp` from the FAPI request's Origin header and omits it when there is none, and the
> native app (CapacitorHttp/NSURLSession) sends no Origin, so **every native token carries no
> `azp`**. The `azp=https://localhost` assumption was never observed live pre-flip
> (`auth-headless-spike-verdict.md` §4/§6). Fix (`specs/multiuser-p0-authz-flip-fix-plan.md`):
> reverted to §3.4's original policy — reject only **present-and-mismatched** `azp`; absent passes,
> but only after RS256 signature verification against our own JWKS and `CLERK_ISSUER` pinning (both
> mandatory in open mode). Signature + issuer, plus per-row scoping, carry the real security load;
> azp remains as web-origin misconfig/replay hardening. Lessons encoded: (1) `ops/flip_canary.py` is
> a blocking §8 step and reproduces the failing token shape exactly; (2) every 401 branch now logs a
> named reject reason; (3) never gate on a claim whose live shape was not empirically captured.

**Also annotate §3.8 SHOULD-FIX #2** with a one-line bracketed correction pointing at the incident
record. The "NEVER set `APP_ACCESS_MODE` outside test configs" rule is untouched — the canary never
sets it.

## 7. Exact files to touch

1. `backend/app/services/clerk_auth.py` — amended azp branch + reject-reason logging (§2, §3).
2. `backend/tests/test_clerk_auth.py` — corrected `TestAzpHardening` matrix + docstring (§5).
3. `backend/tests/test_clerk_jwt_parity.py` — two additive real-signature tests (§5).
4. `ops/flip_canary.py` — new, executable (§4).
5. `specs/multi-user-epic-plan.md` — §8 step 4 rewrite + incident record + §3.8 annotation (§6).
6. `specs/multiuser-p0-authz-flip-fix-plan.md` — this plan.

## 8. Gates

- Local (no Postgres here): `cd backend && ruff check .` and
  `cd backend && uv run pytest tests/test_clerk_auth.py tests/test_clerk_jwt_parity.py` (DB-free).
- CI (`.github/workflows/ci.yml`, "Backend gate" with the Postgres service): full `uv run pytest`,
  which includes `-m flip_gate`-marked tests — verifies flip_gate stays green.
- `/security-review` + `/code-review` before the bundle is ready (auth change = mandatory per
  CLAUDE.md), with the test-policy-correction flag from §5 called out explicitly for both.
- Live gate: the canary itself, run per the updated §8 on flip day (can be dry-run pre-flip in owner
  mode with the owner's user id — owner tokens must 200 in owner mode too).

## 9. Edge cases & risks

- **`azp: ""`** — treated as absent (falsy check); covered by a dedicated test.
- **Missing `CLERK_SECRET_KEY` on the box** — canary prerequisite; runbook step names it; canary
  fails closed with a secret-free message.
- **60s session-token TTL** — canary fires both requests immediately after mint.
- **FAPI exchange failure modes** — surface as Clerk error *codes* (safe to print); Native API is
  already enabled (the app depends on it daily).
- **`optional_user_id` + azp-mismatch propagates as 401** — pre-existing, unchanged, noted for reviewer.
- **Log noise** — absent-azp is DEBUG; missing-token is INFO; genuine verification failures are WARNING.
- **Future shared Clerk instance** — the one honest residual (§1); recorded in the epic.
- **Rollback of the fix itself** — the amended check is strictly more permissive only for the absent
  case and only post-signature/issuer; owner-mode prod (env unset) is byte-identical before and after.
