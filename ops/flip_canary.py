#!/usr/bin/env python3
"""flip_canary.py — blocking post-flip smoke test for the multi-user open-mode
flip (specs/multiuser-p0-authz-flip-fix-plan.md §4).

Mints a REAL production Clerk session token **server-side**, shaped exactly
like the tokens the native iOS app sends: no `Origin` header on the mint
path, therefore no `azp` claim in the resulting JWT. That is the exact token
shape that caused the first flip attempt's incident (every native-app
request 401'd because the then-current azp policy rejected absent azp). A
200 through the real prod auth gate with this token shape is a true
regression proof that the fix (`backend/app/services/clerk_auth.py`) holds.

Why the sign-in-token -> FAPI-ticket -> session-token flow, not
`POST /v1/sessions` directly: direct session creation is NOT available on
production Clerk instances (Looper runs on `pk_live_...` /
`clerk.looperapp.org`). This is the documented production-safe path.

Stdlib only — no new dependencies. Never prints the token, the secret key,
or any claim VALUE other than `iss` (public deployment config) and the azp
origin (a public web URL) when present. Never sets APP_ACCESS_MODE — this
script only observes an already-running server.

Usage:
    python3 ops/flip_canary.py
    python3 ops/flip_canary.py --base-url https://api.looperapp.org
    python3 ops/flip_canary.py --env-file backend/.env --user-id user_abc123

Exit code: 0 only if every check PASSes. Non-zero on any failure (including
a missing CLERK_SECRET_KEY, which fails closed with a secret-free message).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

CLERK_API_BASE = "https://api.clerk.com"
DEFAULT_ENV_FILE = os.path.expanduser("~/scorecard/backend/.env")
DEFAULT_BASE_URL = "http://localhost:8000"
SESSION_TOKEN_TTL_SECONDS = 60

CHECK_ROUTES = ("/api/rounds", "/api/caddie/profile")


class CanaryError(RuntimeError):
    """Raised for any hard-stop condition; message must be secret-free."""


def _parse_env_file(path: str) -> dict[str, str]:
    """Minimal .env parser: KEY=VALUE lines, '#' comments, optional quotes.
    Does not evaluate/export — just reads the values this script needs."""
    values: dict[str, str] = {}
    if not os.path.isfile(path):
        return values
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            values[key] = val
    return values


def _load_config(env_file: str, cli_user_id: Optional[str]) -> tuple[str, str, str]:
    """Returns (secret_key, issuer, user_id). Fails closed, secret-free, if
    CLERK_SECRET_KEY is absent."""
    file_env = _parse_env_file(env_file)

    secret_key = os.getenv("CLERK_SECRET_KEY") or file_env.get("CLERK_SECRET_KEY")
    if not secret_key:
        raise CanaryError(
            f"CLERK_SECRET_KEY not found (checked process env and {env_file}). "
            "Flip-day prerequisite: add sk_live_... to backend/.env on the box "
            "before running the canary. Refusing to proceed."
        )

    issuer = os.getenv("CLERK_ISSUER") or file_env.get("CLERK_ISSUER")
    if not issuer:
        raise CanaryError(
            f"CLERK_ISSUER not found (checked process env and {env_file}). "
            "Refusing to proceed without a configured issuer."
        )

    user_id = cli_user_id or os.getenv("OWNER_CLERK_USER_ID") or file_env.get("OWNER_CLERK_USER_ID")
    if not user_id:
        raise CanaryError(
            "No --user-id given and OWNER_CLERK_USER_ID not found "
            f"(checked process env and {env_file}). Pass --user-id explicitly."
        )

    return secret_key, issuer, user_id


def _http_json(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    body: Optional[bytes] = None,
) -> tuple[int, dict]:
    """Minimal urllib JSON request helper. Deliberately does NOT set an
    Origin header — this reproduces the native app's origin-less request
    shape, which is the whole point of the canary."""
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.getcode()
            payload = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        payload = e.read()
    except urllib.error.URLError as e:
        raise CanaryError(f"network error calling {method} {url}: {e.reason}")

    parsed: dict = {}
    if payload:
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = {}
    return status, parsed


def _clerk_backend_api(method: str, path: str, secret_key: str, body: Optional[dict] = None) -> dict:
    url = f"{CLERK_API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json",
    }
    status, parsed = _http_json(method, url, headers=headers, body=data)
    if status >= 300:
        code = None
        if isinstance(parsed, dict):
            errors = parsed.get("errors") or []
            if errors and isinstance(errors, list):
                code = errors[0].get("code")
        raise CanaryError(f"Clerk Backend API {method} {path} failed: status={status} code={code}")
    return parsed


def mint_sign_in_token(secret_key: str, user_id: str) -> str:
    """Step 1: single-use sign-in ticket via the Backend API."""
    resp = _clerk_backend_api(
        "POST",
        "/v1/sign_in_tokens",
        secret_key,
        {"user_id": user_id, "expires_in_seconds": 300},
    )
    token = resp.get("token")
    if not token:
        raise CanaryError("Clerk Backend API sign_in_tokens response missing 'token'")
    return token


def exchange_ticket_for_session(issuer: str, ticket: str) -> str:
    """Step 2: exchange the ticket at FAPI with NO Origin header (urllib
    sends none by default) — the exact request shape of a native-app sign-in.
    Returns the created session id."""
    url = f"{issuer}/v1/client/sign_ins?_is_native=1"
    body = f"strategy=ticket&ticket={urllib.parse.quote(ticket)}".encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    status, parsed = _http_json("POST", url, headers=headers, body=body)
    if status >= 300:
        raise CanaryError(f"FAPI ticket exchange failed: status={status}")
    session_id = (
        parsed.get("response", {}).get("created_session_id")
        if isinstance(parsed.get("response"), dict)
        else None
    )
    if not session_id:
        raise CanaryError("FAPI ticket exchange response missing created_session_id")
    return session_id


def mint_session_jwt(secret_key: str, session_id: str) -> str:
    """Step 3: mint the real, RS256-signed session JWT for the created
    session — a genuine, origin-less (no azp) Clerk session token."""
    resp = _clerk_backend_api(
        "POST",
        f"/v1/sessions/{session_id}/tokens",
        secret_key,
        {"expires_in_seconds": SESSION_TOKEN_TTL_SECONDS},
    )
    jwt_str = resp.get("jwt")
    if not jwt_str:
        raise CanaryError("Clerk Backend API sessions/tokens response missing 'jwt'")
    return jwt_str


def revoke_session(secret_key: str, session_id: str) -> None:
    """Step 7: best-effort cleanup — never raises."""
    try:
        _clerk_backend_api("POST", f"/v1/sessions/{session_id}/revoke", secret_key)
    except CanaryError:
        pass


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def describe_jwt_shape(token: str) -> dict:
    """Decodes the JWT payload WITHOUT verifying it (stdlib only, no network)
    purely to describe its shape for the printed report. Never returns or
    prints the token itself, the secret key, or the sub value — only claim
    NAMES, the iss VALUE, whether azp is present (and its value, a public web
    origin, if so), and a boolean for sub."""
    parts = token.split(".")
    if len(parts) != 3:
        raise CanaryError("minted token is not a 3-part JWT (unexpected shape)")
    payload = json.loads(_b64url_decode(parts[1]))
    azp = payload.get("azp")
    return {
        "claim_names": sorted(payload.keys()),
        "iss": payload.get("iss"),
        "azp_present": bool(azp),
        "azp_value": azp if azp else None,
        "sub_present": bool(payload.get("sub")),
    }


class Report:
    def __init__(self) -> None:
        self.failed = False

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL"
        suffix = f" — {detail}" if detail else ""
        print(f"[{status}] {name}{suffix}")
        if not ok:
            self.failed = True


def run(base_url: str, secret_key: str, issuer: str, user_id: str) -> int:
    report = Report()
    session_id: Optional[str] = None

    try:
        print("Minting a real, origin-less Clerk session token (native-app shape)...")
        ticket = mint_sign_in_token(secret_key, user_id)

        # The FAPI ticket-exchange response doesn't directly return a
        # reusable session id in every Clerk config shape; capture it here
        # and fall back to failing the canary loudly rather than guessing.
        session_id = exchange_ticket_for_session(issuer, ticket)
        jwt_str = mint_session_jwt(secret_key, session_id)

        shape = describe_jwt_shape(jwt_str)
        print("Token shape (claim names only — never the token or secret):")
        print(f"  claims: {shape['claim_names']}")
        print(f"  iss:    {shape['iss']}")
        print(f"  azp:    {'present=' + shape['azp_value'] if shape['azp_present'] else 'ABSENT'}")
        print(f"  sub:    present={shape['sub_present']}")

        report.check(
            "minted token matches CLERK_ISSUER",
            shape["iss"] == issuer,
            f"expected {issuer!r}",
        )
        report.check("minted token has a sub claim", shape["sub_present"])
        report.check(
            "minted token is origin-less (azp ABSENT) — the incident's exact shape",
            not shape["azp_present"],
        )

        for route in CHECK_ROUTES:
            status, _ = _http_json(
                "GET",
                f"{base_url}{route}",
                headers={"Authorization": f"Bearer {jwt_str}"},
            )
            report.check(f"GET {route} with real origin-less token -> 200", status == 200, f"got {status}")

        for route in CHECK_ROUTES:
            status, _ = _http_json(
                "GET",
                f"{base_url}{route}",
                headers={"Authorization": "Bearer canary.garbage.token"},
            )
            report.check(f"GET {route} with garbage token -> 401 (negative control)", status == 401, f"got {status}")

    except CanaryError as e:
        report.check("canary setup", False, str(e))
    finally:
        if session_id:
            revoke_session(secret_key, session_id)

    print()
    if report.failed:
        print("FLIP CANARY: FAIL — do not declare the flip good. See failures above.")
        return 1
    print("FLIP CANARY: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE, help=f"default: {DEFAULT_ENV_FILE}")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"default: {DEFAULT_BASE_URL}")
    parser.add_argument("--user-id", default=None, help="default: OWNER_CLERK_USER_ID from env/env-file")
    args = parser.parse_args()

    try:
        secret_key, issuer, user_id = _load_config(args.env_file, args.user_id)
    except CanaryError as e:
        print(f"FLIP CANARY: FAIL — {e}")
        return 1

    return run(args.base_url.rstrip("/"), secret_key, issuer, user_id)


if __name__ == "__main__":
    sys.exit(main())
