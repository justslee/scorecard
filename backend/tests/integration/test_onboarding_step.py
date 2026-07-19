"""Integration tests for golfer_profiles.onboarding_step (migration 016).

Proves the existing-user safety invariant end-to-end (plan §6/§7,
specs/onboarding-shell-and-gate-plan.md):
  - a fresh sign-up's ensure-PUT (empty body) creates a row with
    onboardingStep NULL — new users ARE gated into onboarding
  - each step's PUT sets onboardingStep and round-trips on GET
  - PUT without onboardingStep leaves the persisted step untouched
    (present-only semantics, matching every other field on this route)
  - PUT with an out-of-enum onboardingStep is rejected with 422

Modeled on test_routes.py::TestProfileCRUD::test_profile_get_put_get.
"""

from .conftest import TEST_OWNER_ID, set_auth


class TestOnboardingStep:
    async def test_ensure_put_creates_row_with_null_onboarding_step(self, client):
        """The sign-in 'ensure' PUT {} must create a row with onboardingStep
        NULL — this is what makes a brand-new sign-up gated into onboarding.
        """
        set_auth(TEST_OWNER_ID)

        r = await client.put("/api/profile/golfer", json={})
        assert r.status_code == 200
        assert r.json()["onboardingStep"] is None

        r = await client.get("/api/profile/golfer")
        assert r.status_code == 200
        assert r.json()["onboardingStep"] is None

    async def test_name_step_create_branch(self, client):
        """PUT on a missing row (create branch) with name + onboardingStep."""
        set_auth(TEST_OWNER_ID)

        r = await client.put(
            "/api/profile/golfer",
            json={"name": "Jess", "onboardingStep": "name"},
        )
        assert r.status_code == 200
        assert r.json()["onboardingStep"] == "name"

        r = await client.get("/api/profile/golfer")
        assert r.json()["onboardingStep"] == "name"
        assert r.json()["name"] == "Jess"

    async def test_handicap_step_explicit_null_clear(self, client):
        """The 'I'm not sure' path sends handicap: null explicitly."""
        set_auth(TEST_OWNER_ID)
        await client.put("/api/profile/golfer", json={})

        r = await client.put(
            "/api/profile/golfer",
            json={"handicap": None, "onboardingStep": "handicap"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["handicap"] is None
        assert body["onboardingStep"] == "handicap"

    async def test_put_without_onboarding_step_leaves_it_untouched(self, client):
        """Present-only semantics: omitting onboardingStep must not clear it."""
        set_auth(TEST_OWNER_ID)
        await client.put(
            "/api/profile/golfer",
            json={"onboardingStep": "handicap"},
        )

        r = await client.put("/api/profile/golfer", json={"handicap": 10.0})
        assert r.status_code == 200
        assert r.json()["onboardingStep"] == "handicap"

    async def test_done_step_round_trips(self, client):
        set_auth(TEST_OWNER_ID)
        await client.put("/api/profile/golfer", json={})

        r = await client.put(
            "/api/profile/golfer", json={"onboardingStep": "done"}
        )
        assert r.status_code == 200
        assert r.json()["onboardingStep"] == "done"

        r = await client.get("/api/profile/golfer")
        assert r.json()["onboardingStep"] == "done"

    async def test_invalid_onboarding_step_rejected(self, client):
        set_auth(TEST_OWNER_ID)

        r = await client.put(
            "/api/profile/golfer", json={"onboardingStep": "garbage"}
        )
        assert r.status_code == 422

    async def test_invalid_onboarding_step_rejected_on_post(self, client):
        set_auth(TEST_OWNER_ID)

        r = await client.post(
            "/api/profile/golfer", json={"onboardingStep": "garbage"}
        )
        assert r.status_code == 422
