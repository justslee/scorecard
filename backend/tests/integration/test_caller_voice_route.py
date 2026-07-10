"""Integration tests for GET/PUT /api/tee-times/caller-voice.

Owner-gated (require_owner) caller-voice picker — Option B, no voice cloning
(specs/voice-clone-caller-plan.md §2B/§3). Covers:
  1. GET with no saved row → resolved default, saved=null, options shipped
  2. PUT rejects an out-of-allowlist voice with 422 and persists nothing
  3. PUT with a valid voice persists + round-trips via GET
  4. PUT again (upsert, not insert-only) overwrites the prior pick
  5. Auth fails-closed
"""

from app.services.voice_booking.caller_voice import DEFAULT_CALLER_VOICE

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

BASE = "/api/tee-times/caller-voice"


class TestGetCallerVoice:
    async def test_get_with_no_saved_row_returns_resolved_default(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.get(BASE)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["saved"] is None
        assert body["voice"] == DEFAULT_CALLER_VOICE
        assert len(body["options"]) == 6
        assert body["options"][0]["voice"] == "cedar"

    async def test_get_without_auth_fails_closed(self, client):
        r = await client.get(BASE)
        assert r.status_code in (401, 403, 503), f"expected fail-closed, got {r.status_code}"


class TestPutCallerVoice:
    async def test_put_rejects_out_of_allowlist_voice(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.put(BASE, json={"voice": "not-a-real-voice"})
        assert r.status_code == 422, r.text

        # Nothing was persisted — a follow-up GET still shows no saved pref.
        r2 = await client.get(BASE)
        assert r2.json()["saved"] is None

    async def test_put_valid_voice_persists_and_round_trips(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.put(BASE, json={"voice": "marin"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["saved"] == "marin"
        assert body["voice"] == "marin"

        r2 = await client.get(BASE)
        assert r2.status_code == 200, r2.text
        assert r2.json()["saved"] == "marin"
        assert r2.json()["voice"] == "marin"

    async def test_put_upserts_not_insert_only(self, client):
        set_auth(TEST_OWNER_ID)
        r1 = await client.put(BASE, json={"voice": "ash"})
        assert r1.status_code == 200
        r2 = await client.put(BASE, json={"voice": "ballad"})
        assert r2.status_code == 200
        assert r2.json()["saved"] == "ballad"

        r3 = await client.get(BASE)
        assert r3.json()["saved"] == "ballad"

    async def test_put_without_auth_fails_closed(self, client):
        r = await client.put(BASE, json={"voice": "cedar"})
        assert r.status_code in (401, 403, 503), f"expected fail-closed, got {r.status_code}"

    async def test_caller_voice_is_owner_scoped(self, client):
        set_auth(TEST_OWNER_ID)
        await client.put(BASE, json={"voice": "verse"})

        set_auth(OTHER_OWNER_ID)
        r = await client.get(BASE)
        assert r.json()["saved"] is None, "owner B must not see owner A's saved voice"
