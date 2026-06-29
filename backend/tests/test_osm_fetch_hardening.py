"""Tests for OSM Overpass fetch hardening — retry logic, warning logging, empty-ingest guard.

All tests are pure: no network calls, no database, no new dependencies.
httpx responses are faked via simple in-process objects; asyncio.sleep is
patched so the suite runs without actual delays.

Coverage:
- _post_with_retry: 504 → logs warning + retries + returns None after two failures
- _post_with_retry: 429/5xx first then 200 → retry fires once, returns parsed data
- _post_with_retry: clean 200 with empty elements → no retry, one HTTP call
- _post_with_retry: httpx.TimeoutException → treated as transient, retried once
- _should_abort_empty: 0 holes → True (abort); ≥1 holes → False (proceed)
"""
from __future__ import annotations

import logging
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.osm import _post_with_retry
from app.services.osm_ingest import _should_abort_empty


# ── Fake HTTP response ─────────────────────────────────────────────────────────

class _Resp:
    """Minimal stand-in for an ``httpx.Response``."""

    def __init__(self, status: int, body: str = "") -> None:
        self.status_code = status
        self.is_success = 200 <= status < 300
        self.text = body
        self._data: dict = {"elements": []}

    def json(self) -> dict:
        return self._data


def _client(*responses: _Resp) -> AsyncMock:
    """Return an AsyncMock whose ``.post`` side_effect cycles *responses*."""
    mock = AsyncMock()
    mock.post.side_effect = list(responses)
    return mock


# ── _post_with_retry: 504 (transient, retried, fails both times) ──────────────

class TestPostWithRetry504:
    """504 is a transient status: logs a warning, retries once, returns None."""

    @pytest.mark.asyncio
    async def test_returns_none_after_two_504s(self):
        c = _client(_Resp(504), _Resp(504))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "query")
        assert result is None

    @pytest.mark.asyncio
    async def test_makes_exactly_two_attempts(self):
        c = _client(_Resp(504), _Resp(504))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await _post_with_retry(c, "query")
        assert c.post.call_count == 2

    @pytest.mark.asyncio
    async def test_sleeps_once_between_attempts(self):
        c = _client(_Resp(504), _Resp(504))
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await _post_with_retry(c, "query")
        mock_sleep.assert_called_once()

    @pytest.mark.asyncio
    async def test_logs_warning_with_status_code(self, caplog):
        c = _client(_Resp(504, "Gateway Timeout"), _Resp(504, "Gateway Timeout"))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with caplog.at_level(logging.WARNING, logger="app.services.osm"):
                await _post_with_retry(c, "query", log_tag="test_fn")
        # At least one warning record must mention the status code.
        codes_mentioned = [r for r in caplog.records if "504" in r.message]
        assert codes_mentioned, f"No 504 in log records: {[r.message for r in caplog.records]}"

    @pytest.mark.asyncio
    async def test_log_tag_appears_in_warning(self, caplog):
        c = _client(_Resp(504), _Resp(504))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with caplog.at_level(logging.WARNING, logger="app.services.osm"):
                await _post_with_retry(c, "query", log_tag="my_fetcher")
        tagged = [r for r in caplog.records if "my_fetcher" in r.message]
        assert tagged, "log_tag not present in warning messages"


# ── _post_with_retry: 429 / 5xx first attempt → success on retry ──────────────

class TestPostWithRetryTransientThenSuccess:
    """A transient first failure is followed by a successful retry — data is returned."""

    def _good_resp(self, elements: list | None = None) -> _Resp:
        r = _Resp(200)
        r._data = {"elements": elements or [{"type": "way", "id": 1}]}
        return r

    @pytest.mark.asyncio
    async def test_429_then_success_returns_json(self):
        c = _client(_Resp(429), self._good_resp())
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "q")
        assert result is not None
        assert result["elements"][0]["id"] == 1

    @pytest.mark.asyncio
    async def test_500_then_success_returns_json(self):
        c = _client(_Resp(500), self._good_resp([{"type": "way", "id": 99}]))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "q")
        assert result is not None
        assert result["elements"][0]["id"] == 99

    @pytest.mark.asyncio
    async def test_503_then_success_returns_json(self):
        c = _client(_Resp(503), self._good_resp())
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "q")
        assert result is not None

    @pytest.mark.asyncio
    async def test_retry_fires_exactly_once(self):
        c = _client(_Resp(429), self._good_resp())
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await _post_with_retry(c, "q")
        assert c.post.call_count == 2
        mock_sleep.assert_called_once()


# ── _post_with_retry: clean 200 with no elements ──────────────────────────────

class TestPostWithRetryClean200:
    """A 200 OK is never retried, even when the payload contains no elements."""

    @pytest.mark.asyncio
    async def test_200_empty_elements_is_not_retried(self):
        c = _client(_Resp(200))  # only one response prepared
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await _post_with_retry(c, "q")
        assert result == {"elements": []}
        mock_sleep.assert_not_called()
        assert c.post.call_count == 1

    @pytest.mark.asyncio
    async def test_200_returns_full_json(self):
        resp = _Resp(200)
        resp._data = {"elements": [], "version": 0.6, "generator": "Overpass"}
        c = _client(resp)
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "q")
        assert result["version"] == 0.6


# ── _post_with_retry: non-transient HTTP error (no retry) ─────────────────────

class TestPostWithRetryNonTransient:
    """Non-transient HTTP errors (4xx except 429) log a warning and return None immediately."""

    @pytest.mark.asyncio
    async def test_400_returns_none_immediately(self):
        c = _client(_Resp(400, "bad request"))
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await _post_with_retry(c, "q")
        assert result is None
        mock_sleep.assert_not_called()
        # No retry — only one HTTP call.
        assert c.post.call_count == 1

    @pytest.mark.asyncio
    async def test_406_no_retry(self):
        c = _client(_Resp(406, "not acceptable"))
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await _post_with_retry(c, "q")
        mock_sleep.assert_not_called()
        assert c.post.call_count == 1

    @pytest.mark.asyncio
    async def test_non_transient_logs_warning(self, caplog):
        c = _client(_Resp(400, "bad query"))
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with caplog.at_level(logging.WARNING, logger="app.services.osm"):
                await _post_with_retry(c, "q", log_tag="lbl")
        assert any("400" in r.message for r in caplog.records)


# ── _post_with_retry: httpx timeout / transport exception ─────────────────────

class TestPostWithRetryExceptions:
    """httpx exceptions (TimeoutException, TransportError) are treated as transient."""

    @pytest.mark.asyncio
    async def test_timeout_then_success_returns_data(self):
        good = _Resp(200)
        good._data = {"elements": [{"type": "way", "id": 7}]}
        c = AsyncMock()
        c.post.side_effect = [httpx.TimeoutException("timed out"), good]
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await _post_with_retry(c, "q")
        assert result is not None
        assert result["elements"][0]["id"] == 7
        mock_sleep.assert_called_once()

    @pytest.mark.asyncio
    async def test_two_timeouts_returns_none(self):
        c = AsyncMock()
        c.post.side_effect = [
            httpx.TimeoutException("t1"),
            httpx.TimeoutException("t2"),
        ]
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await _post_with_retry(c, "q")
        assert result is None

    @pytest.mark.asyncio
    async def test_transport_error_retried(self):
        good = _Resp(200)
        good._data = {"elements": []}
        c = AsyncMock()
        c.post.side_effect = [httpx.TransportError("connection reset"), good]
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await _post_with_retry(c, "q")
        assert result == {"elements": []}
        mock_sleep.assert_called_once()

    @pytest.mark.asyncio
    async def test_exception_logs_warning(self, caplog):
        c = AsyncMock()
        c.post.side_effect = [
            httpx.TimeoutException("boom"),
            httpx.TimeoutException("boom2"),
        ]
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with caplog.at_level(logging.WARNING, logger="app.services.osm"):
                await _post_with_retry(c, "q", log_tag="exc_test")
        assert any("exc_test" in r.message for r in caplog.records)


# ── _should_abort_empty ───────────────────────────────────────────────────────

class TestShouldAbortEmpty:
    """Pure decision helper: zero assembled holes → abort; any non-zero → proceed."""

    def test_zero_holes_returns_true(self):
        assert _should_abort_empty(0) is True

    def test_one_hole_returns_false(self):
        assert _should_abort_empty(1) is False

    def test_eighteen_holes_returns_false(self):
        assert _should_abort_empty(18) is False

    def test_large_count_returns_false(self):
        assert _should_abort_empty(100) is False
