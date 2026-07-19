"""Gate-1 offline JWT-parity verification (specs/auth-headless-spike-plan.md §6).

Pure unit test — no DB, no network, CI-safe. Mints REAL RS256-signed tokens
with an in-test RSA keypair, monkeypatches
clerk_auth._jwks_client.get_signing_key_from_jwt to return the public key
(standing in for Clerk's real JWKS endpoint), and proves the UNCHANGED
backend (clerk_auth._verified_user_id) accepts a token from every custom-flow
fixture (email/code, google-web, google-native-id-token, apple-native-id-token)
that shares the prebuilt-widget baseline's iss/azp/claim-shape.

backend/app/services/clerk_auth.py is NOT modified by this slice — only this
test file is new (specs/auth-headless-spike-plan.md §2).

The epic's Gate-1 question this answers: "does the unchanged backend accept a
token whose SHAPE matches the widget baseline?" Whether Clerk's real custom
flows actually mint tokens of exactly this shape is confirmed live, in the
spike panel, against the real dev Clerk instance (recorded in
specs/auth-headless-spike-verdict.md) — this test proves the backend HALF of
that question offline and deterministically.
"""

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.services import clerk_auth

ISSUER = "https://clerk.example.com"
AZP = "https://looper.app"  # the request Origin the widget baseline was minted from


@pytest.fixture(scope="module")
def rsa_keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJWKSClient:
    """Stands in for PyJWKClient: returns our in-test public key for any
    token, exactly like the real client would return Clerk's published
    signing key looked up by `kid`."""

    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


def _mint(private_key, payload):
    return jwt.encode(payload, private_key, algorithm="RS256")


def _base_payload(**overrides):
    payload = {
        "iss": ISSUER,
        "azp": AZP,
        "sub": "user_123",
        "sid": "sess_abc",
        "fva": [1, -1],
    }
    payload.update(overrides)
    return payload


# The four custom-flow fixtures the spike must prove. Each SHARES the
# baseline's iss/azp/claim-shape (only sub/sid differ, as a real distinct
# session would) — proving the byte-identical-shape acceptance question,
# independent of which flow actually produced the token.
FLOW_FIXTURES = {
    "email-code": _base_payload(sub="user_email_code", sid="sess_email_code"),
    "google-web": _base_payload(sub="user_google_web", sid="sess_google_web"),
    "google-native-id-token": _base_payload(
        sub="user_google_native", sid="sess_google_native"
    ),
    "apple-native-id-token": _base_payload(
        sub="user_apple_native", sid="sess_apple_native"
    ),
}


class TestJwtParityAcceptsEveryFlow:
    """The unchanged backend accepts a baseline-shaped token from every flow
    — both with CLERK_AUTHORIZED_PARTIES unset (today's default, owner-mode
    prod) and with it SET to the minting azp (the opt-in allowlist
    hardening path, §3.8 of the multi-user plan)."""

    @pytest.mark.parametrize("flow_name", list(FLOW_FIXTURES))
    def test_accepts_baseline_shaped_token_no_azp_allowlist(
        self, monkeypatch, rsa_keypair, flow_name
    ):
        private_key, public_key = rsa_keypair
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.delenv("CLERK_AUTHORIZED_PARTIES", raising=False)

        token = _mint(private_key, FLOW_FIXTURES[flow_name])
        assert clerk_auth._verified_user_id(token) == FLOW_FIXTURES[flow_name]["sub"]

    @pytest.mark.parametrize("flow_name", list(FLOW_FIXTURES))
    def test_accepts_baseline_shaped_token_with_azp_allowlist_set(
        self, monkeypatch, rsa_keypair, flow_name
    ):
        private_key, public_key = rsa_keypair
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", AZP)

        token = _mint(private_key, FLOW_FIXTURES[flow_name])
        assert clerk_auth._verified_user_id(token) == FLOW_FIXTURES[flow_name]["sub"]


class TestJwtParityRejectsMismatches:
    """Sanity checks that the acceptance above isn't vacuous: a token that
    genuinely differs from the baseline (wrong azp, wrong issuer, wrong
    signature) is rejected — proving each check actually gates."""

    def test_wrong_azp_is_rejected_once_allowlist_is_configured(
        self, monkeypatch, rsa_keypair
    ):
        """A token with the right iss/shape but a DIFFERENT azp (e.g. a
        provider-derived audience instead of the request Origin) is rejected
        once CLERK_AUTHORIZED_PARTIES is configured."""
        private_key, public_key = rsa_keypair
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", AZP)

        token = _mint(private_key, _base_payload(azp="https://evil.example.com"))
        with pytest.raises(Exception) as exc:
            clerk_auth._verified_user_id(token)
        assert getattr(exc.value, "status_code", None) == 401

    def test_wrong_issuer_is_rejected(self, monkeypatch, rsa_keypair):
        private_key, public_key = rsa_keypair
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.delenv("CLERK_AUTHORIZED_PARTIES", raising=False)

        token = _mint(private_key, _base_payload(iss="https://not-clerk.example.com"))
        with pytest.raises(jwt.InvalidIssuerError):
            clerk_auth._verified_user_id(token)

    def test_wrong_signature_is_rejected(self, monkeypatch, rsa_keypair):
        """A token signed by a DIFFERENT private key (not Clerk's) must fail
        signature verification — proves this is a real cryptographic check,
        not just claim inspection."""
        _private_key, public_key = rsa_keypair
        other_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.delenv("CLERK_AUTHORIZED_PARTIES", raising=False)

        token = _mint(other_private_key, _base_payload())
        with pytest.raises(jwt.InvalidSignatureError):
            clerk_auth._verified_user_id(token)

    def test_missing_sub_is_rejected(self, monkeypatch, rsa_keypair):
        private_key, public_key = rsa_keypair
        monkeypatch.setattr(clerk_auth, "_jwks_client", _FakeJWKSClient(public_key))
        monkeypatch.setattr(clerk_auth, "CLERK_ISSUER", ISSUER)  # module-level constant, not read dynamically
        monkeypatch.delenv("CLERK_AUTHORIZED_PARTIES", raising=False)

        payload = _base_payload()
        del payload["sub"]
        token = _mint(private_key, payload)
        with pytest.raises(Exception) as exc:
            clerk_auth._verified_user_id(token)
        assert getattr(exc.value, "status_code", None) == 401
