"""Pure unit tests for the P0 slice-1 authz foundation (no DB, no Postgres).

specs/multiuser-p0-authz-flip-slice1.md §4:
  - "Byte-identical" unit test — require_member (owner mode, the default)
    agrees with require_owner across the identity matrix.
  - Boot-guard unit tests — _assert_boot_config() for every {mode, config} cell.
  - azp unit tests — CLERK_AUTHORIZED_PARTIES fail-closed hardening.

These call the dependency functions directly (not through FastAPI's DI, so a
default `= Depends(...)` never resolves — we always pass user_id explicitly),
and monkeypatch env vars per-test since _access_mode()/_owner_id() read
os.getenv() dynamically at call time (by design — see clerk_auth.py). Module-
level constants (OWNER_CLERK_USER_ID, read once at import time by
require_owner) are monkeypatched directly on the module object so the two
dependencies can be compared under the SAME effective config.
"""

import pytest
from fastapi import HTTPException

from app.services import clerk_auth


# ─────────────────────────────────────────────────────────────────────────────
# Byte-identical: require_member (owner mode) === require_owner
# ─────────────────────────────────────────────────────────────────────────────


class TestByteIdenticalOwnerMode:
    """require_member defaults to APP_ACCESS_MODE=owner (unset -> "owner"),
    which MUST be byte-identical to require_owner today. Pinned across the
    identity matrix: {owner sub, non-owner sub} x {owner set, owner unset}."""

    @pytest.mark.parametrize("owner_configured", [True, False])
    @pytest.mark.parametrize("caller", ["the-owner-sub", "someone-else-sub"])
    async def test_agrees_with_require_owner(self, monkeypatch, owner_configured, caller):
        owner_sub = "the-owner-sub"
        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)  # unset -> "owner" default
        if owner_configured:
            monkeypatch.setenv("OWNER_CLERK_USER_ID", owner_sub)
        else:
            monkeypatch.delenv("OWNER_CLERK_USER_ID", raising=False)
        # require_owner reads the frozen module-level constant (read once at
        # import time in real life) — monkeypatch it directly so both
        # dependencies observe the SAME owner config for this comparison.
        monkeypatch.setattr(
            clerk_auth, "OWNER_CLERK_USER_ID", owner_sub if owner_configured else None
        )

        owner_result, owner_exc = None, None
        try:
            owner_result = await clerk_auth.require_owner(user_id=caller)
        except HTTPException as e:
            owner_exc = e

        member_result, member_exc = None, None
        try:
            member_result = await clerk_auth.require_member(user_id=caller)
        except HTTPException as e:
            member_exc = e

        if owner_exc is not None:
            assert member_exc is not None, (
                f"require_owner raised {owner_exc!r} but require_member did not "
                f"(caller={caller}, owner_configured={owner_configured})"
            )
            assert owner_exc.status_code == member_exc.status_code
        else:
            assert member_exc is None, (
                f"require_owner passed but require_member raised {member_exc!r} "
                f"(caller={caller}, owner_configured={owner_configured})"
            )
            assert owner_result == member_result == caller

    async def test_open_mode_admits_non_owner_unlike_owner_mode(self, monkeypatch):
        """Sanity check that the two modes genuinely differ when flipped —
        proves the byte-identical test above isn't vacuously true because
        require_member always passes everyone."""
        monkeypatch.setenv("OWNER_CLERK_USER_ID", "the-owner-sub")
        monkeypatch.setattr(clerk_auth, "OWNER_CLERK_USER_ID", "the-owner-sub")

        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)
        with pytest.raises(HTTPException) as exc:
            await clerk_auth.require_member(user_id="someone-else-sub")
        assert exc.value.status_code == 403

        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        result = await clerk_auth.require_member(user_id="someone-else-sub")
        assert result == "someone-else-sub"


# ─────────────────────────────────────────────────────────────────────────────
# Boot guard: _assert_boot_config()
# ─────────────────────────────────────────────────────────────────────────────


class TestBootGuard:
    def _clear(self, monkeypatch):
        for var in (
            "APP_ACCESS_MODE",
            "CLERK_JWKS_URL",
            "ALLOW_ANONYMOUS",
            "CLERK_ISSUER",
            "CLERK_AUTHORIZED_PARTIES",
        ):
            monkeypatch.delenv(var, raising=False)

    def test_open_without_jwks_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        with pytest.raises(RuntimeError, match="CLERK_JWKS_URL"):
            clerk_auth._assert_boot_config()

    def test_open_with_allow_anonymous_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example.com/.well-known/jwks.json")
        monkeypatch.setenv("ALLOW_ANONYMOUS", "1")
        monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.com")
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        with pytest.raises(RuntimeError, match="ALLOW_ANONYMOUS"):
            clerk_auth._assert_boot_config()

    def test_open_without_issuer_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example.com/.well-known/jwks.json")
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        with pytest.raises(RuntimeError, match="CLERK_ISSUER"):
            clerk_auth._assert_boot_config()

    def test_open_without_authorized_parties_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example.com/.well-known/jwks.json")
        monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.com")
        with pytest.raises(RuntimeError, match="CLERK_AUTHORIZED_PARTIES"):
            clerk_auth._assert_boot_config()

    def test_owner_mode_never_raises(self, monkeypatch):
        self._clear(monkeypatch)
        # owner mode (default, or explicit) — none of these combos should raise,
        # regardless of JWKS/issuer/authorized-parties/anonymous config.
        for jwks in (None, "https://clerk.example.com/.well-known/jwks.json"):
            for allow_anon in (None, "1"):
                self._clear(monkeypatch)
                if jwks:
                    monkeypatch.setenv("CLERK_JWKS_URL", jwks)
                if allow_anon:
                    monkeypatch.setenv("ALLOW_ANONYMOUS", allow_anon)
                clerk_auth._assert_boot_config()  # must not raise

    def test_open_with_everything_set_passes(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example.com/.well-known/jwks.json")
        monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.com")
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        clerk_auth._assert_boot_config()  # must not raise

    def test_owner_mode_with_jwks_and_no_owner_id_logs_warning_not_raise(
        self, monkeypatch, caplog
    ):
        """Today's silent fail-open (clerk_auth.py:97-98 pre-slice) must now be
        LOUD, not silent — but still must not refuse to boot (owner mode is
        always safe-by-default even when misconfigured, matching current prod
        behavior)."""
        self._clear(monkeypatch)
        monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example.com/.well-known/jwks.json")
        with caplog.at_level("WARNING", logger="looper.clerk_auth"):
            clerk_auth._assert_boot_config()  # must not raise
        assert any("OWNER_CLERK_USER_ID" in rec.message for rec in caplog.records)


# ─────────────────────────────────────────────────────────────────────────────
# azp / issuer fail-closed hardening
# ─────────────────────────────────────────────────────────────────────────────


class TestAzpHardening:
    """CLERK_AUTHORIZED_PARTIES is opt-in: unset -> unchanged (backward-
    compatible); set -> a token's azp claim must be present and allowlisted."""

    def _decode_stub(self, monkeypatch, payload: dict):
        """Stand in for the real JWKS-verified decode: skip signature
        verification (there is no existing JWT-minting test harness under
        backend/tests/ to reuse — see the slice-1 build notes) and return a
        canned payload, so only the azp logic under test runs."""
        monkeypatch.setattr(
            clerk_auth,
            "_jwks_client",
            type("FakeJWKS", (), {"get_signing_key_from_jwt": lambda self, t: type(
                "Key", (), {"key": "unused"}
            )()})(),
        )
        monkeypatch.setattr(
            clerk_auth.jwt, "decode", lambda *a, **k: payload
        )

    def test_no_authorized_parties_env_is_unchanged(self, monkeypatch):
        """Backward-compatible: CLERK_AUTHORIZED_PARTIES unset -> no azp check
        at all, even with no azp claim in the token (today's owner-mode prod)."""
        monkeypatch.delenv("CLERK_AUTHORIZED_PARTIES", raising=False)
        self._decode_stub(monkeypatch, {"sub": "user-1"})  # no azp claim
        assert clerk_auth._verified_user_id("fake-token") == "user-1"

    def test_missing_azp_is_rejected_when_configured(self, monkeypatch):
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        self._decode_stub(monkeypatch, {"sub": "user-1"})  # no azp claim
        with pytest.raises(HTTPException) as exc:
            clerk_auth._verified_user_id("fake-token")
        assert exc.value.status_code == 401

    def test_wrong_azp_is_rejected_when_configured(self, monkeypatch):
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        self._decode_stub(
            monkeypatch, {"sub": "user-1", "azp": "https://evil.example.com"}
        )
        with pytest.raises(HTTPException) as exc:
            clerk_auth._verified_user_id("fake-token")
        assert exc.value.status_code == 401

    def test_allowed_azp_passes(self, monkeypatch):
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com,https://other.example.com")
        self._decode_stub(
            monkeypatch, {"sub": "user-1", "azp": "https://other.example.com"}
        )
        assert clerk_auth._verified_user_id("fake-token") == "user-1"

    def test_missing_sub_still_rejected_after_azp_passes(self, monkeypatch):
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example.com")
        self._decode_stub(monkeypatch, {"azp": "https://app.example.com"})  # no sub
        with pytest.raises(HTTPException) as exc:
            clerk_auth._verified_user_id("fake-token")
        assert exc.value.status_code == 401


# ─────────────────────────────────────────────────────────────────────────────
# Revocation (P0 slice 3) — require_member consults app.services.revocation in
# OPEN mode ONLY. Owner mode must short-circuit BEFORE the revocation check —
# proven directly here, not just asserted in a docstring.
# ─────────────────────────────────────────────────────────────────────────────


class TestRevocation:
    @pytest.fixture(autouse=True)
    def _clean_revocation(self):
        from app.services import revocation
        revocation._debug_clear()
        yield
        revocation._debug_clear()

    async def test_open_mode_revoked_user_is_forbidden(self, monkeypatch):
        from app.services import revocation
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        revocation.revoke("banned-sub", reason="user.banned", source="test")
        with pytest.raises(HTTPException) as exc:
            await clerk_auth.require_member(user_id="banned-sub")
        assert exc.value.status_code == 403

    async def test_open_mode_non_revoked_user_passes(self, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        result = await clerk_auth.require_member(user_id="clean-sub")
        assert result == "clean-sub"

    async def test_owner_mode_revoked_owner_id_still_passes_byte_identical(self, monkeypatch):
        """Owner mode must NEVER consult the revocation store. Even if the
        owner's OWN id were somehow marked revoked, owner mode still passes
        them through unchanged — proves the short-circuit sits BEFORE the
        revocation check (require_member's docstring), not just that
        revocation happens to agree in the common case."""
        from app.services import revocation
        owner_sub = "the-owner-sub"
        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)  # unset -> "owner"
        monkeypatch.setenv("OWNER_CLERK_USER_ID", owner_sub)
        revocation.revoke(owner_sub, reason="test-poison", source="test")

        result = await clerk_auth.require_member(user_id=owner_sub)
        assert result == owner_sub

    async def test_owner_mode_non_owner_403s_regardless_of_revocation_state(self, monkeypatch):
        """A non-owner is rejected by the owner-only gate itself, not by
        revocation — proven by NOT revoking them and still getting a 403."""
        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)
        monkeypatch.setenv("OWNER_CLERK_USER_ID", "the-owner-sub")
        with pytest.raises(HTTPException) as exc:
            await clerk_auth.require_member(user_id="someone-else-sub")
        assert exc.value.status_code == 403
