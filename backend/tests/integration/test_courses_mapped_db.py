"""DB-backed integration coverage for the PostGIS mapped-course layer
(`app.services.courses_mapped`) — previously zero live-DB coverage.

Skips locally via conftest's `_postgres_reachable` probe (no local Postgres on
dev machines); runs for real in CI on the `postgis/postgis:16-3.4` service,
against the course-mapping schema bootstrapped verbatim from
`backend/supabase/migrations/001_course_mapping_schema.sql` (see conftest
`_ensure_schema`).

Covers:
  (b) write-back → get_course round-trip (upsert_course + update_green_feature_properties)
  (e) merge preserves other keys + no-op returns False (absent green / bad hole number / empty patch)
  (d) the real precompute backfill seam (`app.routes.caddie._precompute_course_elevations`)
      with `sample_course_elevations` monkeypatched to a deterministic offline stub, but
      `get_course` / `update_green_feature_properties` left real — exercises real
      read → synth-hole construction → real write-back → real read-back, plus idempotency.
"""

import uuid


def _seed_course(course_id: str, *, green_geometry: dict, green_props: dict, par: int = 5) -> dict:
    """The exact dict shape `courses_mapped.upsert_course` consumes: one hole
    with a green feature, a yardage, and par != 4 so the hole is never skipped
    as an "untouched default"."""
    return {
        "id": course_id,
        "name": "DB Test Course",
        "address": "1 Integration Way",
        "location": {"lat": 40.71, "lng": -73.45},
        "teeSets": [{"name": "Blue", "color": "#2563eb"}],
        "holes": [
            {
                "number": 1,
                "par": par,
                "handicap": 1,
                "yardages": {"Blue": 540},
                "features": {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {"featureType": "green", **green_props},
                            "geometry": green_geometry,
                        },
                    ],
                },
            }
        ],
    }


def _green_point(lng: float = -73.452, lat: float = 40.710) -> dict:
    return {"type": "Point", "coordinates": [lng, lat]}


def _find_green(feats: list[dict]) -> dict:
    for f in feats:
        if (f.get("properties") or {}).get("featureType") == "green":
            return f
    raise AssertionError("no green feature found")


# ─────────────────────────────────────────────────────────────────────────────
# (b) write-back → get_course round-trip
# ─────────────────────────────────────────────────────────────────────────────


class TestWriteBackRoundTrip:
    async def test_update_green_feature_properties_round_trips_through_get_course(self):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _seed_course(cid, green_geometry=_green_point(), green_props={"existing": 1})
        )

        ok = await courses_mapped.update_green_feature_properties(cid, 1, {"delta_ft": 4.2})
        assert ok is True

        course = await courses_mapped.get_course(cid)
        assert course is not None
        assert len(course["holes"]) == 18
        assert course["holes"][0]["number"] == 1
        assert course["holes"][0]["par"] == 5

        feats = course["holes"][0]["features"]["features"]
        green = _find_green(feats)
        assert green["properties"]["delta_ft"] == 4.2
        assert green["properties"]["existing"] == 1
        assert green["properties"]["hole"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# (e) merge preserves other keys + no-op returns False
# ─────────────────────────────────────────────────────────────────────────────


class TestMergeAndNoOp:
    async def test_merge_preserves_existing_keys(self):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _seed_course(cid, green_geometry=_green_point(), green_props={"existing": 1})
        )

        ok = await courses_mapped.update_green_feature_properties(cid, 1, {"new": 2})
        assert ok is True

        course = await courses_mapped.get_course(cid)
        green = _find_green(course["holes"][0]["features"]["features"])
        assert green["properties"]["existing"] == 1
        assert green["properties"]["new"] == 2

    async def test_no_green_feature_returns_false_and_writes_nothing(self):
        from app.services import courses_mapped

        cid2 = str(uuid.uuid4())
        course_payload = _seed_course(
            cid2, green_geometry=_green_point(), green_props={"existing": 1}
        )
        # Replace the green feature with a non-green ("tee") feature so the
        # hole still persists (has a feature + yardage + par != 4) but there
        # is no green row for update_green_feature_properties to target.
        course_payload["holes"][0]["features"]["features"] = [
            {
                "type": "Feature",
                "properties": {"featureType": "tee"},
                "geometry": _green_point(-73.461, 40.700),
            }
        ]
        await courses_mapped.upsert_course(course_payload)

        ok = await courses_mapped.update_green_feature_properties(cid2, 1, {"x": 1})
        assert ok is False

        course = await courses_mapped.get_course(cid2)
        feats = course["holes"][0]["features"]["features"]
        assert all(f["properties"].get("x") != 1 for f in feats)

    async def test_nonexistent_hole_number_returns_false(self):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _seed_course(cid, green_geometry=_green_point(), green_props={"existing": 1})
        )

        ok = await courses_mapped.update_green_feature_properties(cid, 7, {"x": 1})
        assert ok is False

    async def test_invalid_hole_number_zero_returns_false(self):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _seed_course(cid, green_geometry=_green_point(), green_props={"existing": 1})
        )

        ok = await courses_mapped.update_green_feature_properties(cid, 0, {"x": 1})
        assert ok is False

    async def test_empty_patch_returns_false(self):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _seed_course(cid, green_geometry=_green_point(), green_props={"existing": 1})
        )

        ok = await courses_mapped.update_green_feature_properties(cid, 1, {})
        assert ok is False


# ─────────────────────────────────────────────────────────────────────────────
# (d) precompute backfill through the real DB seam
# ─────────────────────────────────────────────────────────────────────────────


def _tee_and_green_course(course_id: str, *, green_props: dict) -> dict:
    return {
        "id": course_id,
        "name": "DB Test Course",
        "address": "1 Integration Way",
        "location": {"lat": 40.71, "lng": -73.45},
        "teeSets": [{"name": "Blue", "color": "#2563eb"}],
        "holes": [
            {
                "number": 1,
                "par": 5,
                "handicap": 1,
                "yardages": {"Blue": 540},
                "features": {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {"featureType": "tee"},
                            "geometry": {"type": "Point", "coordinates": [-73.4515, 40.700]},
                        },
                        {
                            "type": "Feature",
                            "properties": {"featureType": "green", **green_props},
                            "geometry": _green_point(),
                        },
                    ],
                },
            }
        ],
    }


class TestPrecomputeBackfill:
    async def test_precompute_writes_through_real_db_and_is_idempotent(self, monkeypatch):
        import app.routes.caddie as caddie_routes
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(
            _tee_and_green_course(cid, green_props={"existing": 1})
        )

        call_count = 0

        async def _stub_sample(synth_holes, target_course_name):
            nonlocal call_count
            call_count += 1
            assert target_course_name == "precompute"
            refs = {f["properties"]["ref"] for f in synth_holes}
            return {
                ref: {
                    "tee_elevation_ft": 90.0,
                    "green_elevation_ft": 100.0,
                    "net_change_ft": 10.0,
                    "plays_like_yards": 3.3,
                    "green_slope": None,
                }
                for ref in refs
            }

        monkeypatch.setattr(caddie_routes, "sample_course_elevations", _stub_sample)

        # First run — should sample and write back.
        await caddie_routes._precompute_course_elevations(cid)

        course = await courses_mapped.get_course(cid)
        feats = course["holes"][0]["features"]["features"]
        green = _find_green(feats)
        assert green["properties"]["delta_ft"] == 10.0
        assert green["properties"]["tee_elevation_ft"] == 90.0
        assert green["properties"]["green_elevation_ft"] == 100.0
        assert green["properties"]["plays_like_yards"] == 3.3
        assert green["properties"]["existing"] == 1
        assert "green_slope" not in green["properties"]
        assert call_count == 1

        # Second run — already-persisted elevation filters the hole out, so
        # the sampler must NOT be called again (zero-sample early return).
        await caddie_routes._precompute_course_elevations(cid)
        assert call_count == 1

        course_again = await courses_mapped.get_course(cid)
        feats_again = course_again["holes"][0]["features"]["features"]
        green_again = _find_green(feats_again)
        assert green_again["properties"]["delta_ft"] == 10.0
        assert green_again["properties"]["tee_elevation_ft"] == 90.0
        assert green_again["properties"]["green_elevation_ft"] == 100.0
        assert (
            len([f for f in feats_again if f["properties"]["featureType"] == "green"]) == 1
        )
