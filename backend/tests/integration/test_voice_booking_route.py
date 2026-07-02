"""Integration tests for POST /api/tee-times/book-by-call/simulate.

Dev/QA surface for the voice booking agent: runs the scripted pro-shop
simulator (never a real call) and returns transcript + outcome + BookingResult.
Owner-auth like the rest of the tee-times router; no DB rows are written.
"""

from .conftest import TEST_OWNER_ID, set_auth

URL = "/api/tee-times/book-by-call/simulate"

DISCLOSURE_PREFIX = "Hi — I'm an automated AI assistant calling on behalf of"


class TestSimulateRoute:
    async def test_requires_auth(self, client):
        r = await client.post(URL, json={"persona": "friendly"})
        assert r.status_code in (401, 503), f"expected fail-closed, got {r.status_code}"

    async def test_friendly_persona_books(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(URL, json={"persona": "friendly"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["persona"] == "friendly"
        assert data["outcome"]["result"] == "booked"
        assert data["result"]["status"] == "confirmed"
        assert data["result"]["confirmationNumber"] == "PG7402"
        # Compliance: the disclosure opens the conversation with the human.
        agent_turns = [t for t in data["transcript"] if t["speaker"] == "agent"]
        assert agent_turns and agent_turns[0]["text"].startswith(DISCLOSURE_PREFIX)

    async def test_voicemail_persona_needs_human(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(URL, json={"persona": "voicemail"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["outcome"]["result"] == "voicemail"
        assert data["result"]["status"] == "needs_human"

    async def test_context_overrides_flow_through(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(
            URL,
            json={
                "persona": "friendly",
                "golferName": "Casey",
                "date": "2026-08-01",
                "partySize": 2,
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["outcome"]["date"] == "2026-08-01"
        assert data["outcome"]["partySize"] == 2
        agent_text = " ".join(
            t["text"] for t in data["transcript"] if t["speaker"] == "agent"
        )
        assert "Casey" in agent_text

    async def test_unknown_persona_is_422(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(URL, json={"persona": "angry_goose"})
        assert r.status_code == 422, r.text
