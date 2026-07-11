"""DB-backed integration coverage for `courses_mapped.courses_in_bounds` — the
PostGIS bbox leg behind GET /api/courses/in-bounds (course-selection B1).

Skips locally via conftest's `_postgres_reachable` probe (no local Postgres on
dev machines); runs for real in CI on the `postgis/postgis:16-3.4` service,
against the course-mapping schema bootstrapped verbatim from
`backend/supabase/migrations/001_course_mapping_schema.sql` (see conftest
`_ensure_schema`).

Covers:
  I1 — bbox correctness (include the two inside rows, exclude the outside one)
  I2 — limit respected + nearest-to-bbox-center-first ordering
  I3 — write-through round-trip (the flywheel): external_course_rows output
       written via write_through_courses reappears via courses_in_bounds
"""

import uuid

from app.services import course_finder, courses_mapped

# A small NYC-area bbox used across tests below.
SW_LAT, SW_LNG, NE_LAT, NE_LNG = 40.70, -73.55, 40.80, -73.40


def _row(name: str, lat: float, lng: float, address: str | None = None) -> dict:
    return {"id": str(uuid.uuid4()), "name": name, "address": address, "lat": lat, "lng": lng}


class TestBboxCorrectness:
    async def test_returns_only_courses_inside_the_envelope(self):
        inside_a = _row("Inside Course A", 40.72, -73.50)
        inside_b = _row("Inside Course B", 40.78, -73.42)
        outside = _row("Outside Course", 41.50, -74.50)  # well outside the bbox

        await courses_mapped.write_through_courses([inside_a, inside_b, outside])

        rows = await courses_mapped.courses_in_bounds(SW_LAT, SW_LNG, NE_LAT, NE_LNG)

        ids = {r["id"] for r in rows}
        assert inside_a["id"] in ids
        assert inside_b["id"] in ids
        assert outside["id"] not in ids
        assert len(rows) == 2

        # _list_item shape (id/name/address/location/updatedAt).
        found = next(r for r in rows if r["id"] == inside_a["id"])
        assert found["name"] == "Inside Course A"
        assert found["location"] == {"lat": 40.72, "lng": -73.50}
        assert "updatedAt" in found


class TestLimitAndOrdering:
    async def test_limit_is_respected_and_center_nearest_rows_win(self):
        c_lat = (SW_LAT + NE_LAT) / 2
        c_lng = (SW_LNG + NE_LNG) / 2

        # 8 rows at increasing distance from the bbox center, all inside the
        # envelope (small offsets keep every row within SW/NE).
        rows_seeded = []
        for i in range(8):
            offset = 0.005 * (i + 1)
            rows_seeded.append(
                _row(f"Course {i}", c_lat + offset, c_lng + offset)
            )
        await courses_mapped.write_through_courses(rows_seeded)

        limited = await courses_mapped.courses_in_bounds(SW_LAT, SW_LNG, NE_LAT, NE_LNG, limit=5)
        assert len(limited) == 5

        # The 5 returned must be exactly the 5 closest-to-center seeded rows
        # (i.e. Course 0..4, the smallest offsets), in nearest-first order.
        expected_order = [rows_seeded[i]["name"] for i in range(5)]
        assert [r["name"] for r in limited] == expected_order


class TestWriteThroughRoundTrip:
    async def test_external_course_rows_written_then_visible_via_in_bounds(self):
        osm_hit = {
            "osm_id": "way/998877",
            "name": "Flywheel Golf Club",
            "address": "1 Fairway Ln, Testville, NY",
            "center": {"lat": 40.75, "lng": -73.45},
            "source": "osm",
        }
        rows = course_finder.external_course_rows([osm_hit])
        assert len(rows) == 1
        expected_id = course_finder.deterministic_course_id("osm-way/998877")
        assert rows[0]["id"] == expected_id

        await courses_mapped.write_through_courses(rows)

        found = await courses_mapped.courses_in_bounds(SW_LAT, SW_LNG, NE_LAT, NE_LNG)
        ids = {r["id"] for r in found}
        assert expected_id in ids
        matched = next(r for r in found if r["id"] == expected_id)
        assert matched["name"] == "Flywheel Golf Club"
        assert matched["location"] == {"lat": 40.75, "lng": -73.45}
