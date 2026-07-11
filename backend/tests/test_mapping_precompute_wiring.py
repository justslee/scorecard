"""Non-DB wiring tests: `create_mapped` / `put_mapped` schedule the elevation
precompute BEFORE the guides precompute (Gap A — the headline fix of
specs/course-intel-static-persistence-plan.md v2).

`_precompute_course_guides` reads `delta_ft`/`green_slope` off the green
props for research context, so elevation must land first; BackgroundTasks run
in the order they were added, so this test asserts scheduling ORDER, not just
presence.

No network, no Postgres — `store.upsert_course` and both precompute functions
are monkeypatched; the route functions are called directly (mirrors
`tests/test_course_search.py`'s direct-call + `BackgroundTasks()` pattern).

Import note
-----------
`app.routes.courses_mapped` transitively imports `app.services.courses_mapped`
-> `app.db.engine`, which raises at import time without DATABASE_URL. Stub it
first, same pattern as `tests/test_guide_read_revalidation.py`.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from fastapi import BackgroundTasks  # noqa: E402

import pytest  # noqa: E402

from app.routes import courses_mapped as routes_mod  # noqa: E402


def _course_body() -> dict:
    return {"id": "course-1", "name": "Fixture Course", "holes": []}


@pytest.mark.asyncio
async def test_create_mapped_schedules_elevation_then_guides(monkeypatch):
    calls: list[str] = []

    async def fake_upsert_course(data):
        return {"id": "course-1", "name": "Fixture Course"}

    async def fake_precompute_elevations(course_id):
        assert course_id == "course-1"
        calls.append("elevation")

    async def fake_precompute_guides(course_id):
        assert course_id == "course-1"
        calls.append("guides")

    monkeypatch.setattr(routes_mod.store, "upsert_course", fake_upsert_course)
    monkeypatch.setattr(routes_mod, "_precompute_course_elevations", fake_precompute_elevations)
    monkeypatch.setattr(routes_mod, "_precompute_course_guides", fake_precompute_guides)

    bg = BackgroundTasks()
    body = routes_mod.CourseIn(**_course_body())
    result = await routes_mod.create_mapped(body, background_tasks=bg)

    assert result["course"]["id"] == "course-1"
    assert calls == []  # not run yet — only scheduled
    await bg()  # simulate Starlette running BackgroundTasks after the response
    assert calls == ["elevation", "guides"]


@pytest.mark.asyncio
async def test_put_mapped_schedules_elevation_then_guides(monkeypatch):
    calls: list[str] = []

    async def fake_upsert_course(data):
        return {"id": "course-1", "name": "Fixture Course"}

    async def fake_precompute_elevations(course_id):
        calls.append("elevation")

    async def fake_precompute_guides(course_id):
        calls.append("guides")

    monkeypatch.setattr(routes_mod.store, "upsert_course", fake_upsert_course)
    monkeypatch.setattr(routes_mod, "_precompute_course_elevations", fake_precompute_elevations)
    monkeypatch.setattr(routes_mod, "_precompute_course_guides", fake_precompute_guides)

    bg = BackgroundTasks()
    body = routes_mod.CourseIn(**_course_body())
    result = await routes_mod.put_mapped("course-1", body, background_tasks=bg)

    assert result["course"]["id"] == "course-1"
    assert calls == []
    await bg()
    assert calls == ["elevation", "guides"]


@pytest.mark.asyncio
async def test_create_mapped_schedules_nothing_when_upsert_returns_none(monkeypatch):
    async def fake_upsert_course(data):
        return None

    def fail_elevation(*_args, **_kwargs):
        raise AssertionError("_precompute_course_elevations must not be scheduled")

    def fail_guides(*_args, **_kwargs):
        raise AssertionError("_precompute_course_guides must not be scheduled")

    monkeypatch.setattr(routes_mod.store, "upsert_course", fake_upsert_course)
    monkeypatch.setattr(routes_mod, "_precompute_course_elevations", fail_elevation)
    monkeypatch.setattr(routes_mod, "_precompute_course_guides", fail_guides)

    bg = BackgroundTasks()
    body = routes_mod.CourseIn(**_course_body())
    result = await routes_mod.create_mapped(body, background_tasks=bg)

    assert result["course"] is None
    await bg()  # no-op — nothing was scheduled, so the fail_* stubs never fire


@pytest.mark.asyncio
async def test_put_mapped_schedules_nothing_when_upsert_returns_none(monkeypatch):
    async def fake_upsert_course(data):
        return None

    def fail_elevation(*_args, **_kwargs):
        raise AssertionError("_precompute_course_elevations must not be scheduled")

    def fail_guides(*_args, **_kwargs):
        raise AssertionError("_precompute_course_guides must not be scheduled")

    monkeypatch.setattr(routes_mod.store, "upsert_course", fake_upsert_course)
    monkeypatch.setattr(routes_mod, "_precompute_course_elevations", fail_elevation)
    monkeypatch.setattr(routes_mod, "_precompute_course_guides", fail_guides)

    bg = BackgroundTasks()
    body = routes_mod.CourseIn(**_course_body())
    result = await routes_mod.put_mapped("course-1", body, background_tasks=bg)

    assert result["course"] is None
    await bg()
