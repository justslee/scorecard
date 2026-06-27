"""One-shot backfill: import backend/data/*.json into Postgres core-scoring tables.

Imports:
  players.json      → players
  courses.json      → scoring_courses
  tournaments.json  → tournaments + games (tournament-scoped)
  rounds.json       → rounds + round_players + player_groups + scores + games (round-scoped)

Dependencies:
  Alembic migrations through 006_scoring_courses (and higher) must be applied before
  running.  (002_core_scoring, 006_scoring_courses — see backend/migrations/versions/).

Usage (on the EC2 deploy box where DATABASE_URL is set):

    cd backend
    DATABASE_URL=postgresql+asyncpg://... uv run python -m scripts.backfill_core_data \\
        --owner-id $OWNER_CLERK_USER_ID

Dry-run (DATABASE_URL must be set so the module can be imported; no live DB
connection or writes are made in dry-run mode):

    DATABASE_URL=postgresql+asyncpg://... uv run python -m scripts.backfill_core_data \\
        --owner-id $OWNER_CLERK_USER_ID --dry-run

Idempotent:
  Each record is upserted by primary key (id) or a unique constraint:
    players / scoring_courses / tournaments / rounds / games  — ON CONFLICT (id) DO UPDATE
    round_players  — ON CONFLICT ON CONSTRAINT round_players_round_player_uq DO UPDATE
    scores         — ON CONFLICT ON CONSTRAINT scores_round_player_hole_uq DO UPDATE
  Legacy non-UUID ids (e.g. "player-ryan-murphy", "course-augusta") are mapped to
  deterministic UUID v5 values via BACKFILL_NAMESPACE so every re-run produces the
  same DB id for the same source record.

Cross-table remapping:
  An in-memory id_map is built (legacy_id → new UUID) for players, courses, and
  tournaments before rounds are processed.  round.courseId, round.tournamentId, and
  round_player.playerId are remapped through this map.  Unknown ids are passed through
  unchanged (and logged as a warning).

Retiring files:
  After a successful DB commit every imported source file is renamed:
    data/<name>.json  →  data/<name>.json.imported
  The original JSON is not deleted.  Re-runs no-op gracefully if the .json file is
  absent (already retired or never existed).

Owner assignment:
  All imported rows receive owner_id = --owner-id (single-owner beta).  The script
  fails with a clear error if no owner id is provided.

Upserts never delete:
  Rows already in the DB (from the API or a prior run) are updated in place but
  never deleted.  If a JSON record was manually removed since a prior import, the
  corresponding DB row is preserved.  This is intentional for a one-off migration;
  it only matters if the JSON files are manually re-created between runs.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.engine import async_session
from app.db.models import (
    Game as GameORM,
    Player as PlayerORM,
    PlayerGroup as PlayerGroupORM,
    Round as RoundORM,
    RoundPlayer as RoundPlayerORM,
    Score as ScoreORM,
    ScoringCourse as ScoringCourseORM,
    Tournament as TournamentORM,
)

# ── constants ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent.parent / "data"

# Stable namespace for deterministic UUID v5 from legacy string ids.
# Using uuid.NAMESPACE_URL (6ba7b811-9dad-11d1-80b4-00c04fd430c8) — well-known,
# collision-resistant, stable across Python versions.
BACKFILL_NAMESPACE = uuid.NAMESPACE_URL

log = logging.getLogger(__name__)


# ── helpers ────────────────────────────────────────────────────────────────────


def _resolve_id(raw_id: str) -> str:
    """Return raw_id if it's already a valid UUID; otherwise generate UUID v5.

    UUID v5 is deterministic: the same raw_id always produces the same output,
    making every re-run produce the same DB primary key for the same source record.
    """
    if not raw_id:
        return str(uuid.uuid4())
    try:
        uuid.UUID(raw_id)
        return raw_id
    except ValueError:
        return str(uuid.uuid5(BACKFILL_NAMESPACE, raw_id))


def _load_json(filename: str) -> list[dict]:
    """Load JSON array from data/<filename>.  Returns [] on missing/invalid/empty."""
    path = DATA_DIR / filename
    if not path.exists():
        log.info("  %s not found — skipping", filename)
        return []
    try:
        raw = path.read_text().strip()
        if not raw:
            log.info("  %s is empty — skipping", filename)
            return []
        data = json.loads(raw)
        if not isinstance(data, list):
            log.warning("  %s is not a JSON array — skipping", filename)
            return []
        return data
    except json.JSONDecodeError as exc:
        log.warning("  %s JSON parse error: %s — skipping", filename, exc)
        return []


def _parse_dt(value: str | None, fallback: datetime) -> datetime:
    """Parse an ISO datetime string; return fallback on failure."""
    if not value:
        return fallback
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return fallback


def _retire(filename: str) -> None:
    """Rename data/<filename> → data/<filename>.imported (soft-retire).

    Safe to call even if the file has already been retired or never existed.
    """
    src = DATA_DIR / filename
    dst = DATA_DIR / (filename + ".imported")
    if src.exists():
        src.rename(dst)
        log.info("  Retired %s → %s", filename, filename + ".imported")
    else:
        log.debug("  %s already retired or absent — skipping rename", filename)


# ── game player-ref remapping ──────────────────────────────────────────────────


def _remap_game_player_refs(
    g: dict,
    player_id_map: dict[str, str],
) -> tuple[list[str], list | None, dict | None]:
    """Remap ALL player id references inside a raw game dict through player_id_map.

    Returns (remapped_player_ids, remapped_teams, remapped_settings).

    Only top-level ``playerIds`` is remapped by the caller; this helper also
    covers the nested player refs that ``lib/games.ts`` reads at runtime:

      teams[].playerIds[]                           — GameTeam.playerIds
      settings.matchPlayPlayers.player1Id/player2Id — individual match play
      settings.threePointPairs.teamAPlayer1Id       — 2v2 three-point pairs
      settings.threePointPairs.teamAPlayer2Id
      settings.threePointPairs.teamBPlayer1Id
      settings.threePointPairs.teamBPlayer2Id
      settings.wolfOrderPlayerIds[]                 — wolf rotation order (length 4)
      settings.wolfHoleChoices[n].partnerId         — wolf per-hole partner choice
                                                      (only when mode=='partner')
    """

    def remap(pid: str | None) -> str | None:
        return player_id_map.get(pid, pid) if pid is not None else None

    # top-level playerIds
    raw_player_ids: list[str] = g.get("playerIds") or []
    remapped_player_ids = [player_id_map.get(pid, pid) for pid in raw_player_ids]

    # teams — deep-copy list; remap playerIds inside each GameTeam dict
    raw_teams = g.get("teams")
    remapped_teams: list | None = None
    if raw_teams is not None:
        remapped_teams = []
        for team in raw_teams:
            if not isinstance(team, dict):
                remapped_teams.append(team)
                continue
            team_copy = dict(team)
            raw_team_pids: list[str] = team_copy.get("playerIds") or []
            team_copy["playerIds"] = [player_id_map.get(pid, pid) for pid in raw_team_pids]
            remapped_teams.append(team_copy)

    # settings — deep-copy dict; remap all known player-ref fields
    raw_settings = g.get("settings")
    remapped_settings: dict | None = None
    if isinstance(raw_settings, dict):
        remapped_settings = dict(raw_settings)

        # matchPlayPlayers: {player1Id, player2Id}
        mpp = remapped_settings.get("matchPlayPlayers")
        if isinstance(mpp, dict):
            mpp_copy = dict(mpp)
            mpp_copy["player1Id"] = remap(mpp_copy.get("player1Id"))
            mpp_copy["player2Id"] = remap(mpp_copy.get("player2Id"))
            remapped_settings["matchPlayPlayers"] = mpp_copy

        # threePointPairs: {teamAPlayer1Id, teamAPlayer2Id, teamBPlayer1Id, teamBPlayer2Id}
        tpp = remapped_settings.get("threePointPairs")
        if isinstance(tpp, dict):
            tpp_copy = dict(tpp)
            for field in (
                "teamAPlayer1Id",
                "teamAPlayer2Id",
                "teamBPlayer1Id",
                "teamBPlayer2Id",
            ):
                tpp_copy[field] = remap(tpp_copy.get(field))
            remapped_settings["threePointPairs"] = tpp_copy

        # wolfOrderPlayerIds: string[] (length 4)
        wolf_order = remapped_settings.get("wolfOrderPlayerIds")
        if isinstance(wolf_order, list):
            remapped_settings["wolfOrderPlayerIds"] = [
                player_id_map.get(pid, pid) for pid in wolf_order
            ]

        # wolfHoleChoices: Record<number, {mode:'lone'}|{mode:'partner',partnerId:string}>
        wolf_choices = remapped_settings.get("wolfHoleChoices")
        if isinstance(wolf_choices, dict):
            remapped_choices: dict = {}
            for hole_key, choice in wolf_choices.items():
                if isinstance(choice, dict) and choice.get("mode") == "partner":
                    choice_copy = dict(choice)
                    choice_copy["partnerId"] = remap(choice_copy.get("partnerId"))
                    remapped_choices[hole_key] = choice_copy
                else:
                    remapped_choices[hole_key] = choice
            remapped_settings["wolfHoleChoices"] = remapped_choices

    elif raw_settings is not None:
        # Unexpected shape — preserve as-is rather than silently dropping
        remapped_settings = raw_settings  # type: ignore[assignment]

    return remapped_player_ids, remapped_teams, remapped_settings


# ── per-domain import functions ────────────────────────────────────────────────


async def _import_players(
    db,
    records: list[dict],
    owner_id: str,
) -> tuple[int, dict[str, str]]:
    """Upsert players.json records into the ``players`` table.

    Returns (count_upserted, id_map: {legacy_id → resolved_uuid}).
    The id_map is used downstream to remap player references in rounds.
    """
    id_map: dict[str, str] = {}
    now = datetime.now(timezone.utc)
    upserted = 0

    for rec in records:
        legacy_id: str = rec.get("id") or ""
        new_id = _resolve_id(legacy_id)
        id_map[legacy_id] = new_id

        if legacy_id != new_id:
            log.debug("    player %r: legacy id %r → UUID %s", rec.get("name"), legacy_id, new_id)

        created_at = _parse_dt(rec.get("createdAt"), now)
        updated_at = _parse_dt(rec.get("updatedAt"), now)

        stmt = (
            pg_insert(PlayerORM)
            .values(
                id=new_id,
                owner_id=owner_id,
                name=rec.get("name") or "",
                nickname=rec.get("nickname"),
                email=rec.get("email"),
                phone=rec.get("phone"),
                handicap=rec.get("handicap"),
                avatar_url=rec.get("avatarUrl"),
                clerk_user_id=rec.get("clerkUserId"),
                rounds_played=rec.get("roundsPlayed") or 0,
                created_at=created_at,
                updated_at=updated_at,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "owner_id": owner_id,
                    "name": rec.get("name") or "",
                    "nickname": rec.get("nickname"),
                    "email": rec.get("email"),
                    "phone": rec.get("phone"),
                    "handicap": rec.get("handicap"),
                    "avatar_url": rec.get("avatarUrl"),
                    "clerk_user_id": rec.get("clerkUserId"),
                    "rounds_played": rec.get("roundsPlayed") or 0,
                    "updated_at": updated_at,
                },
            )
        )
        await db.execute(stmt)
        upserted += 1

    return upserted, id_map


async def _import_courses(
    db,
    records: list[dict],
    owner_id: str,
) -> tuple[int, dict[str, str]]:
    """Upsert courses.json records into the ``scoring_courses`` table.

    Returns (count_upserted, id_map: {legacy_id → resolved_uuid}).
    """
    id_map: dict[str, str] = {}
    now = datetime.now(timezone.utc)
    upserted = 0

    for rec in records:
        legacy_id: str = rec.get("id") or ""
        new_id = _resolve_id(legacy_id)
        id_map[legacy_id] = new_id

        if legacy_id != new_id:
            log.debug("    course %r: legacy id %r → UUID %s", rec.get("name"), legacy_id, new_id)

        stmt = (
            pg_insert(ScoringCourseORM)
            .values(
                id=new_id,
                owner_id=owner_id,
                name=rec.get("name") or "",
                location=rec.get("location"),
                holes=rec.get("holes") or [],
                tees=rec.get("tees"),
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "owner_id": owner_id,
                    "name": rec.get("name") or "",
                    "location": rec.get("location"),
                    "holes": rec.get("holes") or [],
                    "tees": rec.get("tees"),
                    "updated_at": now,
                },
            )
        )
        await db.execute(stmt)
        upserted += 1

    return upserted, id_map


async def _import_tournaments(
    db,
    records: list[dict],
    owner_id: str,
    player_id_map: dict[str, str],
) -> tuple[int, dict[str, str]]:
    """Upsert tournaments.json records into ``tournaments`` + tournament-scoped ``games``.

    player_ids in each tournament are remapped through player_id_map.
    round_ids from the JSON are stored as-is; they will be remapped in a second
    pass after rounds are imported (the tournament.round_ids JSONB is overwritten
    with the new round UUIDs if any rounds reference this tournament).

    Returns (count_upserted, id_map: {legacy_id → resolved_uuid}).
    """
    id_map: dict[str, str] = {}
    now = datetime.now(timezone.utc)
    upserted = 0

    for rec in records:
        legacy_id: str = rec.get("id") or ""
        new_id = _resolve_id(legacy_id)
        id_map[legacy_id] = new_id

        # Remap player_ids through the player id_map (best-effort)
        raw_player_ids: list[str] = rec.get("playerIds") or []
        remapped_player_ids = [
            player_id_map.get(pid, pid) for pid in raw_player_ids
        ]

        # round_ids: stored as-is initially; _patch_tournament_round_ids() remaps
        # them after rounds are imported.
        raw_round_ids: list[str] = rec.get("roundIds") or []

        created_at = _parse_dt(rec.get("createdAt"), now)
        updated_at = _parse_dt(rec.get("updatedAt"), now)

        t_stmt = (
            pg_insert(TournamentORM)
            .values(
                id=new_id,
                owner_id=owner_id,
                name=rec.get("name") or "",
                num_rounds=rec.get("numRounds"),
                round_ids=raw_round_ids,
                player_ids=remapped_player_ids,
                created_at=created_at,
                updated_at=updated_at,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "owner_id": owner_id,
                    "name": rec.get("name") or "",
                    "num_rounds": rec.get("numRounds"),
                    "player_ids": remapped_player_ids,
                    "updated_at": updated_at,
                    # round_ids intentionally NOT overwritten on upsert —
                    # the second pass (below) handles the remapping.
                },
            )
        )
        await db.execute(t_stmt)
        upserted += 1

        # Tournament-scoped games (round_id is NULL per spec §D).
        # All player id references — including nested teams[].playerIds and
        # settings.*Id / *PlayerIds / partnerId — are remapped through player_id_map.
        games: list[dict] = rec.get("games") or []
        for g in games:
            game_legacy_id: str = g.get("id") or ""
            game_new_id = _resolve_id(game_legacy_id)
            remapped_game_player_ids, remapped_teams, remapped_settings = (
                _remap_game_player_refs(g, player_id_map)
            )
            gm_stmt = (
                pg_insert(GameORM)
                .values(
                    id=game_new_id,
                    tournament_id=new_id,
                    round_id=None,
                    format=g.get("format") or "stroke",
                    name=g.get("name") or "",
                    player_ids=remapped_game_player_ids,
                    teams=remapped_teams,
                    settings=remapped_settings,
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "player_ids": remapped_game_player_ids,
                        "teams": remapped_teams,
                        "settings": remapped_settings,
                        "updated_at": now,
                    },
                )
            )
            await db.execute(gm_stmt)

    return upserted, id_map


async def _import_rounds(
    db,
    records: list[dict],
    owner_id: str,
    player_id_map: dict[str, str],
    course_id_map: dict[str, str],
    tournament_id_map: dict[str, str],
) -> tuple[int, dict[str, str]]:
    """Upsert rounds.json into ``rounds`` + ``round_players`` + ``player_groups``
    + ``scores`` + round-scoped ``games``.

    Returns (count_upserted, round_id_map: {legacy_id → resolved_uuid}).
    """
    round_id_map: dict[str, str] = {}
    now = datetime.now(timezone.utc)
    upserted = 0

    for rec in records:
        legacy_id: str = rec.get("id") or ""
        new_id = _resolve_id(legacy_id)
        round_id_map[legacy_id] = new_id

        # Remap cross-domain references
        legacy_course_id: str = rec.get("courseId") or ""
        remapped_course_id = course_id_map.get(legacy_course_id, legacy_course_id)
        if legacy_course_id not in course_id_map:
            log.warning(
                "    round %r: courseId %r not found in course id_map — using as-is",
                legacy_id, legacy_course_id,
            )

        legacy_tournament_id: str | None = rec.get("tournamentId")
        remapped_tournament_id: str | None = None
        if legacy_tournament_id:
            # Gate strictly on membership in tournament_id_map (i.e. the tournament was
            # present in tournaments.json and was imported above).  A UUID-format
            # tournament id that is NOT in the map would satisfy the UUID parse check
            # but would violate the rounds.tournament_id FK if that row doesn't exist
            # in the DB → IntegrityError and full-import rollback.
            if legacy_tournament_id in tournament_id_map:
                remapped_tournament_id = tournament_id_map[legacy_tournament_id]
            else:
                log.warning(
                    "    round %r: tournamentId %r not found in imported tournaments "
                    "(not in tournaments.json) — setting tournament_id=NULL to avoid FK violation",
                    legacy_id, legacy_tournament_id,
                )

        players_list: list[dict] = rec.get("players") or []
        scores_list: list[dict] = rec.get("scores") or []
        groups_list: list[dict] = rec.get("groups") or []
        games_list: list[dict] = rec.get("games") or []

        created_at = _parse_dt(rec.get("createdAt"), now)
        updated_at = _parse_dt(rec.get("updatedAt"), now)

        # ── rounds ────────────────────────────────────────────────────────────
        r_stmt = (
            pg_insert(RoundORM)
            .values(
                id=new_id,
                owner_id=owner_id,
                course_id=remapped_course_id,
                course_name=rec.get("courseName") or "",
                tee_id=rec.get("teeId"),
                tee_name=rec.get("teeName"),
                date=rec.get("date") or now.isoformat(),
                status=rec.get("status") or "active",
                tournament_id=remapped_tournament_id,
                holes=rec.get("holes") or [],
                created_at=created_at,
                updated_at=updated_at,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "owner_id": owner_id,
                    "course_id": remapped_course_id,
                    "course_name": rec.get("courseName") or "",
                    "tee_id": rec.get("teeId"),
                    "tee_name": rec.get("teeName"),
                    "date": rec.get("date") or now.isoformat(),
                    "status": rec.get("status") or "active",
                    "tournament_id": remapped_tournament_id,
                    "holes": rec.get("holes") or [],
                    "updated_at": updated_at,
                },
            )
        )
        await db.execute(r_stmt)

        # ── player_groups (must exist before round_players FK) ────────────────
        group_id_map: dict[str, str] = {}
        for g in groups_list:
            group_legacy_id: str = g.get("id") or ""
            group_new_id = _resolve_id(group_legacy_id)
            group_id_map[group_legacy_id] = group_new_id

            raw_gp_ids: list[str] = g.get("playerIds") or []
            remapped_gp_ids = [player_id_map.get(pid, pid) for pid in raw_gp_ids]

            pg_stmt = (
                pg_insert(PlayerGroupORM)
                .values(
                    id=group_new_id,
                    round_id=new_id,
                    name=g.get("name") or "",
                    tee_time=g.get("teeTime"),
                    starting_hole=g.get("startingHole"),
                    player_ids=remapped_gp_ids,
                    created_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "name": g.get("name") or "",
                        "tee_time": g.get("teeTime"),
                        "starting_hole": g.get("startingHole"),
                        "player_ids": remapped_gp_ids,
                    },
                )
            )
            await db.execute(pg_stmt)

        # ── round_players ─────────────────────────────────────────────────────
        # Upsert on the unique constraint (round_id, player_id) so re-runs
        # update handicap/group_id without duplicating rows.
        for p in players_list:
            p_legacy_id: str = p.get("id") or ""
            p_new_id = player_id_map.get(p_legacy_id, _resolve_id(p_legacy_id))

            group_legacy_id = p.get("groupId")
            group_new_id = (
                group_id_map.get(group_legacy_id) if group_legacy_id else None
            )

            rp_stmt = (
                pg_insert(RoundPlayerORM)
                .values(
                    id=str(uuid.uuid4()),  # random; discarded on UQ conflict
                    round_id=new_id,
                    player_id=p_new_id,
                    group_id=group_new_id,
                    handicap=p.get("handicap"),
                    created_at=now,
                )
                .on_conflict_do_update(
                    constraint="round_players_round_player_uq",
                    set_={
                        "handicap": p.get("handicap"),
                        "group_id": group_new_id,
                    },
                )
            )
            await db.execute(rp_stmt)

        # ── scores ────────────────────────────────────────────────────────────
        # Upsert on the unique constraint (round_id, player_id, hole_number).
        # Matches the pattern in routes/rounds.py update_score.
        for s in scores_list:
            s_player_legacy_id: str = s.get("playerId") or ""
            s_player_id = player_id_map.get(
                s_player_legacy_id, _resolve_id(s_player_legacy_id)
            )
            sc_stmt = (
                pg_insert(ScoreORM)
                .values(
                    id=str(uuid.uuid4()),  # random; discarded on UQ conflict
                    round_id=new_id,
                    player_id=s_player_id,
                    hole_number=s.get("holeNumber") or 0,
                    strokes=s.get("strokes"),
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    constraint="scores_round_player_hole_uq",
                    set_={
                        "strokes": s.get("strokes"),
                        "updated_at": now,
                    },
                )
            )
            await db.execute(sc_stmt)

        # ── round-scoped games ────────────────────────────────────────────────
        # All player id references — including nested teams[].playerIds and
        # settings.*Id / *PlayerIds / partnerId — are remapped through player_id_map.
        for g in games_list:
            game_legacy_id: str = g.get("id") or ""
            game_new_id = _resolve_id(game_legacy_id)
            remapped_game_player_ids, remapped_teams, remapped_settings = (
                _remap_game_player_refs(g, player_id_map)
            )
            gm_stmt = (
                pg_insert(GameORM)
                .values(
                    id=game_new_id,
                    round_id=new_id,
                    tournament_id=None,
                    format=g.get("format") or "stroke",
                    name=g.get("name") or "",
                    player_ids=remapped_game_player_ids,
                    teams=remapped_teams,
                    settings=remapped_settings,
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        "player_ids": remapped_game_player_ids,
                        "teams": remapped_teams,
                        "settings": remapped_settings,
                        "updated_at": now,
                    },
                )
            )
            await db.execute(gm_stmt)

        upserted += 1

    return upserted, round_id_map


async def _patch_tournament_round_ids(
    db,
    tournament_records: list[dict],
    tournament_id_map: dict[str, str],
    round_id_map: dict[str, str],
    now: datetime,
) -> None:
    """Second pass: remap tournament.round_ids from legacy ids to new UUIDs.

    Runs whenever there are tournament records (even if rounds.json is empty), so
    that a tournament whose roundIds were already UUIDs (e.g. from a prior partial
    run) still gets its list remapped correctly.

    Round ids not found in round_id_map (not present in rounds.json) are passed
    through unchanged with a warning — they may refer to rounds imported separately
    or rounds not yet migrated.
    """
    from sqlalchemy import update as sa_update

    for rec in tournament_records:
        raw_round_ids: list[str] = rec.get("roundIds") or []
        if not raw_round_ids:
            continue
        tournament_new_id = tournament_id_map.get(rec.get("id") or "")
        if not tournament_new_id:
            continue

        remapped_round_ids: list[str] = []
        for rid in raw_round_ids:
            mapped = round_id_map.get(rid)
            if mapped:
                remapped_round_ids.append(mapped)
            else:
                log.warning(
                    "  tournament %r: roundId %r not in round_id_map "
                    "(not present in rounds.json) — passing through unchanged",
                    rec.get("id"), rid,
                )
                remapped_round_ids.append(rid)

        await db.execute(
            sa_update(TournamentORM)
            .where(TournamentORM.id == tournament_new_id)
            .values(round_ids=remapped_round_ids, updated_at=now)
        )


# ── dry-run plan reporter ──────────────────────────────────────────────────────


def _report_dry_run(
    player_records: list[dict],
    course_records: list[dict],
    tournament_records: list[dict],
    round_records: list[dict],
    owner_id: str,
) -> None:
    """Print what would be imported without touching the DB."""
    log.info("[DRY-RUN] owner_id=%r", owner_id)

    log.info("--- Players (%d) ---", len(player_records))
    player_id_map: dict[str, str] = {}
    for rec in player_records:
        lid = rec.get("id") or ""
        nid = _resolve_id(lid)
        player_id_map[lid] = nid
        id_note = "UUID preserved" if lid == nid else f"remapped → {nid}"
        log.info("  player %-30r  %s  (%s)", rec.get("name"), lid, id_note)

    log.info("--- Scoring Courses (%d) ---", len(course_records))
    course_id_map: dict[str, str] = {}
    for rec in course_records:
        lid = rec.get("id") or ""
        nid = _resolve_id(lid)
        course_id_map[lid] = nid
        id_note = "UUID preserved" if lid == nid else f"remapped → {nid}"
        log.info("  course %-30r  %s  (%s)", rec.get("name"), lid, id_note)

    log.info("--- Tournaments (%d) ---", len(tournament_records))
    tournament_id_map: dict[str, str] = {}
    for rec in tournament_records:
        lid = rec.get("id") or ""
        nid = _resolve_id(lid)
        tournament_id_map[lid] = nid
        id_note = "UUID preserved" if lid == nid else f"remapped → {nid}"
        raw_pids = rec.get("playerIds") or []
        remapped_pids = [player_id_map.get(p, p) for p in raw_pids]
        log.info(
            "  tournament %-30r  %s  (%s)  players=%d  games=%d  roundIds=%r",
            rec.get("name"), lid, id_note,
            len(remapped_pids), len(rec.get("games") or []), rec.get("roundIds"),
        )

    log.info("--- Rounds (%d) ---", len(round_records))
    for rec in round_records:
        lid = rec.get("id") or ""
        nid = _resolve_id(lid)
        id_note = "UUID preserved" if lid == nid else f"remapped → {nid}"
        raw_course_id = rec.get("courseId") or ""
        remapped_course_id = course_id_map.get(raw_course_id, raw_course_id)
        log.info(
            "  round %-30r  %s  (%s)  course=%s  players=%d  scores=%d  groups=%d  games=%d",
            rec.get("courseName"), lid, id_note, remapped_course_id,
            len(rec.get("players") or []),
            len(rec.get("scores") or []),
            len(rec.get("groups") or []),
            len(rec.get("games") or []),
        )

    total = (
        len(player_records)
        + len(course_records)
        + len(tournament_records)
        + len(round_records)
    )
    log.info(
        "[DRY-RUN] Would import: %d players, %d courses, %d tournaments, %d rounds  "
        "(total domain records: %d)",
        len(player_records), len(course_records),
        len(tournament_records), len(round_records),
        total,
    )
    log.info("[DRY-RUN] No DB writes performed. Pass without --dry-run to execute.")


# ── entry point ────────────────────────────────────────────────────────────────


async def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description=(
            "One-off backfill: import backend/data/*.json into Postgres core-scoring tables. "
            "Idempotent — re-runs upsert without duplicating. "
            "After a successful import the source .json files are renamed to .json.imported."
        )
    )
    parser.add_argument(
        "--owner-id",
        default=os.getenv("OWNER_CLERK_USER_ID", ""),
        metavar="CLERK_USER_ID",
        help=(
            "Clerk user id to assign as owner_id on all imported rows. "
            "Falls back to the $OWNER_CLERK_USER_ID environment variable."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print what would be imported without writing to the database. "
            "DATABASE_URL must still be set (engine module import requires it) "
            "but no live DB connection is made."
        ),
    )
    args = parser.parse_args()

    owner_id: str = args.owner_id.strip()
    if not owner_id:
        log.error(
            "owner_id is required.  "
            "Pass --owner-id <clerk_user_id> or set OWNER_CLERK_USER_ID."
        )
        return 1

    dry_run: bool = args.dry_run
    mode_tag = "[DRY-RUN] " if dry_run else ""
    log.info("%sBackfill starting.  owner_id=%r  data_dir=%s", mode_tag, owner_id, DATA_DIR)

    # ── Load all JSON files (no DB connection yet) ────────────────────────────
    player_records = _load_json("players.json")
    course_records = _load_json("courses.json")
    tournament_records = _load_json("tournaments.json")
    round_records = _load_json("rounds.json")

    log.info(
        "Loaded from JSON: %d players, %d courses, %d tournaments, %d rounds",
        len(player_records), len(course_records),
        len(tournament_records), len(round_records),
    )

    if not any([player_records, course_records, tournament_records, round_records]):
        log.info("All source files are empty, missing, or already retired.  Nothing to import.")
        return 0

    # ── Dry-run: report plan and exit ─────────────────────────────────────────
    if dry_run:
        _report_dry_run(
            player_records, course_records, tournament_records, round_records, owner_id
        )
        return 0

    # ── Live run: write to DB ─────────────────────────────────────────────────
    now = datetime.now(timezone.utc)

    async with async_session() as db:
        log.info("--- Importing players ---")
        n_players, player_id_map = await _import_players(db, player_records, owner_id)
        log.info("  %d player row(s) upserted", n_players)

        log.info("--- Importing scoring courses ---")
        n_courses, course_id_map = await _import_courses(db, course_records, owner_id)
        log.info("  %d scoring_course row(s) upserted", n_courses)

        log.info("--- Importing tournaments ---")
        n_tournaments, tournament_id_map = await _import_tournaments(
            db, tournament_records, owner_id, player_id_map
        )
        log.info("  %d tournament row(s) upserted (+ their games)", n_tournaments)

        log.info("--- Importing rounds ---")
        n_rounds, round_id_map = await _import_rounds(
            db,
            round_records,
            owner_id,
            player_id_map,
            course_id_map,
            tournament_id_map,
        )
        log.info("  %d round row(s) upserted (+ players/scores/groups/games)", n_rounds)

        # Second pass: remap tournament.round_ids now that we have round UUIDs.
        # Guard only on tournament_records — tournaments may carry roundIds even
        # if rounds.json is empty (e.g. rounds were imported in a previous run).
        if tournament_records:
            log.info("--- Patching tournament.round_ids ---")
            await _patch_tournament_round_ids(
                db, tournament_records, tournament_id_map, round_id_map, now
            )

        await db.commit()
        log.info("DB commit successful.")

    log.info(
        "Import complete — players=%d, scoring_courses=%d, tournaments=%d, rounds=%d",
        n_players, n_courses, n_tournaments, n_rounds,
    )

    # ── Retire source files (soft-delete: rename, never hard-delete) ──────────
    log.info("Retiring source files...")
    if player_records:
        _retire("players.json")
    if course_records:
        _retire("courses.json")
    if tournament_records:
        _retire("tournaments.json")
    if round_records:
        _retire("rounds.json")

    log.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
