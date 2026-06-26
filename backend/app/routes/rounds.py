"""Rounds API routes — Postgres-backed (migration 002_core_scoring).

Replaces the JSON-file rounds_storage. The camelCase Pydantic contract
(Round / RoundCreate / RoundUpdate / Score) is preserved unchanged so
the frontend api.ts layer needs no adjustment.

Normalization strategy
───────────────────────
  round_players  — one row per (round, player); player name resolved via join
                   to the players table (plain-text cross-domain ref, no FK).
  player_groups  — one row per group within a round.
  scores         — one row per (round, player, hole); unique constraint drives
                   upsert semantics (scores_round_player_hole_uq).
  games          — one row per game scoped to this round (round_id FK).

rounds.holes stays as JSONB (hole snapshot for this round; structural course
data lives in the course-mapping tables per spec §C).

Owner scoping: every query filters by owner_id == current_user_id.
The require_owner gate is applied at the app level (main.py).
"""

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm.attributes import flag_modified

from app.db.engine import async_session
from app.db.models import (
    Game as GameORM,
    Player as PlayerORM,
    PlayerGroup as PlayerGroupORM,
    Round as RoundORM,
    RoundPlayer as RoundPlayerORM,
    Score as ScoreORM,
    Tournament as TournamentORM,
)
from app.models import (
    Game as GameModel,
    HoleInfo,
    Player as PlayerModel,
    PlayerGroup as PlayerGroupModel,
    Round,
    RoundCreate,
    RoundUpdate,
    Score,
)
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/rounds", tags=["rounds"])


# ─── helpers ──────────────────────────────────────────────────────────────────


async def _build_full_round(db, row: RoundORM, owner_id: str) -> Round:
    """Reassemble the full Round Pydantic shape from normalised DB tables.

    Queries: round_players, players (name join), scores, player_groups, games.
    owner_id is used to scope the player-name join to the caller's own roster,
    preventing cross-tenant name resolution.
    """
    round_id = row.id

    # Load round_players
    rp_result = await db.execute(
        select(RoundPlayerORM).where(RoundPlayerORM.round_id == round_id)
    )
    rp_rows = rp_result.scalars().all()

    # Resolve player names via join to the players table, scoped to this owner.
    # round_players.player_id is a plain text FK (no DB-level constraint).
    # Falls back to "Unknown" when a player has been deleted from the roster.
    player_ids = [rp.player_id for rp in rp_rows]
    player_name_map: dict[str, str] = {}
    if player_ids:
        p_result = await db.execute(
            select(PlayerORM.id, PlayerORM.name).where(
                PlayerORM.id.in_(player_ids),
                PlayerORM.owner_id == owner_id,
            )
        )
        for p_id, p_name in p_result.all():
            player_name_map[str(p_id)] = p_name

    players = [
        PlayerModel(
            id=rp.player_id,
            name=player_name_map.get(rp.player_id, "Unknown"),
            handicap=float(rp.handicap) if rp.handicap is not None else None,
            groupId=rp.group_id,
        )
        for rp in rp_rows
    ]

    # Load scores
    s_result = await db.execute(
        select(ScoreORM).where(ScoreORM.round_id == round_id)
    )
    scores = [
        Score(
            playerId=s.player_id,
            holeNumber=s.hole_number,
            strokes=s.strokes,
        )
        for s in s_result.scalars().all()
    ]

    # Load player_groups
    pg_result = await db.execute(
        select(PlayerGroupORM).where(PlayerGroupORM.round_id == round_id)
    )
    pg_rows = pg_result.scalars().all()
    groups: list[PlayerGroupModel] | None = (
        [
            PlayerGroupModel(
                id=g.id,
                name=g.name,
                teeTime=g.tee_time,
                startingHole=g.starting_hole,
                playerIds=g.player_ids or [],
            )
            for g in pg_rows
        ]
        if pg_rows
        else None
    )

    # Load games
    gm_result = await db.execute(
        select(GameORM).where(GameORM.round_id == round_id)
    )
    games = [
        GameModel(
            id=g.id,
            roundId=row.id,
            format=g.format,
            name=g.name,
            playerIds=g.player_ids or [],
            teams=g.teams,
            settings=g.settings,
        )
        for g in gm_result.scalars().all()
    ]

    # Holes are stored as JSONB (list of dicts); convert back to HoleInfo.
    holes = [
        HoleInfo(**h) if isinstance(h, dict) else h
        for h in (row.holes or [])
    ]

    return Round(
        id=row.id,
        courseId=row.course_id,
        courseName=row.course_name,
        teeId=row.tee_id,
        teeName=row.tee_name,
        date=row.date,
        players=players,
        scores=scores,
        holes=holes,
        games=games,
        groups=groups,
        status=row.status,
        tournamentId=row.tournament_id,
        createdAt=row.created_at.isoformat() if row.created_at else "",
        updatedAt=row.updated_at.isoformat() if row.updated_at else "",
    )


async def _get_owned_round_row(db, round_id: str, owner_id: str) -> RoundORM:
    """Return the Round ORM row for this owner; raise 404 if missing."""
    result = await db.execute(
        select(RoundORM).where(
            RoundORM.id == round_id,
            RoundORM.owner_id == owner_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Round not found")
    return row


# ─── routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=list[Round])
async def get_rounds(owner_id: str = Depends(current_user_id)):
    """List all rounds belonging to the calling owner (newest first)."""
    async with async_session() as db:
        result = await db.execute(
            select(RoundORM)
            .where(RoundORM.owner_id == owner_id)
            .order_by(RoundORM.date.desc())
        )
        rows = result.scalars().all()
        return [await _build_full_round(db, row, owner_id) for row in rows]


@router.get("/{round_id}", response_model=Round)
async def get_round(round_id: str, owner_id: str = Depends(current_user_id)):
    """Get a single round by id. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        row = await _get_owned_round_row(db, round_id, owner_id)
        return await _build_full_round(db, row, owner_id)


@router.post("", response_model=Round)
async def create_round(
    data: RoundCreate, owner_id: str = Depends(current_user_id)
):
    """Create a new round and its normalised children.

    Inserts rows into: rounds, player_groups (if any), round_players, games.
    Also appends the new round id to the linked tournament's round_ids (if any).
    """
    now = datetime.now(timezone.utc)
    new_id = str(uuid.uuid4())

    async with async_session() as db:
        # 1. Resolve tournament linkage BEFORE creating the round row.
        #
        # Guard: tournaments are still JSON-backed (ids like "tournament-xxxxxxxx",
        # not UUIDs) and the Postgres tournaments table is empty until
        # backend-tournaments-db lands. Writing a non-UUID or unresolved FK
        # crashes with a DBAPIError. Strategy:
        #   - Validate the supplied id parses as a UUID (otherwise it's legacy JSON).
        #   - Attempt to find an owned Postgres tournaments row.
        #   - Only set tournament_id (and append to round_ids) if resolved.
        #   - Otherwise leave tournament_id null and skip linkage silently.
        # Linkage activates automatically once backend-tournaments-db migrates
        # tournaments to Postgres and the Postgres row exists.
        resolved_tournament_id: str | None = None
        if data.tournamentId:
            try:
                uuid.UUID(data.tournamentId)  # validates UUID format; raises ValueError if not
                t_result = await db.execute(
                    select(TournamentORM).where(
                        TournamentORM.id == data.tournamentId,
                        TournamentORM.owner_id == owner_id,
                    )
                )
                pg_tournament = t_result.scalar_one_or_none()
                if pg_tournament:
                    resolved_tournament_id = data.tournamentId
            except ValueError:
                # Non-UUID legacy tournament id (e.g. "tournament-abc123") — skip linkage.
                pass

        # 2. Create the rounds row
        round_row = RoundORM(
            id=new_id,
            owner_id=owner_id,
            course_id=data.courseId,
            course_name=data.courseName,
            tee_id=data.teeId,
            tee_name=data.teeName,
            date=now.isoformat(),
            status="active",
            tournament_id=resolved_tournament_id,
            holes=[h.model_dump() for h in data.holes],
            created_at=now,
            updated_at=now,
        )
        db.add(round_row)
        await db.flush()  # makes round.id available for FK children

        # 3. Create player_groups first (round_players.group_id references them)
        for group in (data.groups or []):
            db.add(
                PlayerGroupORM(
                    id=group.id,  # use client-provided id (client sets it)
                    round_id=new_id,
                    name=group.name,
                    tee_time=group.teeTime,
                    starting_hole=group.startingHole,
                    player_ids=group.playerIds,
                    created_at=now,
                )
            )
        if data.groups:
            await db.flush()  # ensures player_groups.id exists before round_players FK

        # 4. Create round_players
        for player in data.players:
            db.add(
                RoundPlayerORM(
                    id=str(uuid.uuid4()),
                    round_id=new_id,
                    player_id=player.id,
                    group_id=player.groupId if player.groupId else None,
                    handicap=player.handicap,
                    created_at=now,
                )
            )

        # 5. Create games
        for game in data.games:
            db.add(
                GameORM(
                    id=game.id,
                    round_id=new_id,
                    format=game.format,
                    name=game.name,
                    player_ids=game.playerIds,
                    teams=game.teams,
                    settings=game.settings,
                    created_at=now,
                    updated_at=now,
                )
            )

        # 6. Update tournament.round_ids JSONB if linkage was resolved
        if resolved_tournament_id and pg_tournament:
            pg_tournament.round_ids = list(pg_tournament.round_ids or []) + [new_id]
            pg_tournament.updated_at = now
            flag_modified(pg_tournament, "round_ids")

        await db.commit()
        # Reload full shape (holes JSONB + children) for the response
        return await _build_full_round(db, round_row, owner_id)


@router.put("/{round_id}", response_model=Round)
async def update_round(
    round_id: str,
    data: RoundUpdate,
    owner_id: str = Depends(current_user_id),
):
    """Wholesale-replace scores, games, groups, and/or status on a round.

    Only fields provided (non-None) are touched. Scores, games, and groups
    are replaced in their entirety (delete-then-insert), matching the contract
    the frontend api-contract-align item expects.
    """
    now = datetime.now(timezone.utc)

    async with async_session() as db:
        row = await _get_owned_round_row(db, round_id, owner_id)

        # Status update
        if data.status is not None:
            row.status = data.status

        # Wholesale-replace scores
        if data.scores is not None:
            await db.execute(
                delete(ScoreORM).where(ScoreORM.round_id == round_id)
            )
            for score in data.scores:
                db.add(
                    ScoreORM(
                        id=str(uuid.uuid4()),
                        round_id=round_id,
                        player_id=score.playerId,
                        hole_number=score.holeNumber,
                        strokes=score.strokes,
                        created_at=now,
                        updated_at=now,
                    )
                )

        # Wholesale-replace groups (ON DELETE SET NULL nullifies round_players.group_id)
        if data.groups is not None:
            await db.execute(
                delete(PlayerGroupORM).where(PlayerGroupORM.round_id == round_id)
            )
            for group in data.groups:
                db.add(
                    PlayerGroupORM(
                        id=group.id,
                        round_id=round_id,
                        name=group.name,
                        tee_time=group.teeTime,
                        starting_hole=group.startingHole,
                        player_ids=group.playerIds,
                        created_at=now,
                    )
                )
            await db.flush()  # groups must exist before we re-link round_players
            # Re-link round_players to their new groups
            for group in data.groups:
                for pid in group.playerIds:
                    await db.execute(
                        sa_update(RoundPlayerORM)
                        .where(
                            RoundPlayerORM.round_id == round_id,
                            RoundPlayerORM.player_id == pid,
                        )
                        .values(group_id=group.id)
                    )

        # Wholesale-replace games
        if data.games is not None:
            await db.execute(
                delete(GameORM).where(GameORM.round_id == round_id)
            )
            for game in data.games:
                db.add(
                    GameORM(
                        id=game.id,
                        round_id=round_id,
                        format=game.format,
                        name=game.name,
                        player_ids=game.playerIds,
                        teams=game.teams,
                        settings=game.settings,
                        created_at=now,
                        updated_at=now,
                    )
                )

        row.updated_at = now
        await db.commit()
        return await _build_full_round(db, row, owner_id)


@router.post("/{round_id}/scores", response_model=Round)
async def update_score(
    round_id: str,
    score: Score,
    owner_id: str = Depends(current_user_id),
):
    """Upsert a single score by (round_id, player_id, hole_number).

    Uses the DB unique constraint (scores_round_player_hole_uq) for atomic
    upsert. If strokes is None, the score row is deleted instead (matching
    the old JSON-file behaviour).
    """
    now = datetime.now(timezone.utc)

    async with async_session() as db:
        row = await _get_owned_round_row(db, round_id, owner_id)

        if score.strokes is None:
            # Delete the score if it exists
            await db.execute(
                delete(ScoreORM).where(
                    ScoreORM.round_id == round_id,
                    ScoreORM.player_id == score.playerId,
                    ScoreORM.hole_number == score.holeNumber,
                )
            )
        else:
            # Upsert: insert or update on the unique (round, player, hole) key
            stmt = (
                pg_insert(ScoreORM)
                .values(
                    id=str(uuid.uuid4()),
                    round_id=round_id,
                    player_id=score.playerId,
                    hole_number=score.holeNumber,
                    strokes=score.strokes,
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    constraint="scores_round_player_hole_uq",
                    set_={"strokes": score.strokes, "updated_at": now},
                )
            )
            await db.execute(stmt)

        row.updated_at = now
        await db.commit()
        return await _build_full_round(db, row, owner_id)


@router.post("/{round_id}/complete", response_model=Round)
async def complete_round(
    round_id: str, owner_id: str = Depends(current_user_id)
):
    """Mark a round as completed."""
    now = datetime.now(timezone.utc)
    async with async_session() as db:
        row = await _get_owned_round_row(db, round_id, owner_id)
        row.status = "completed"
        row.updated_at = now
        await db.commit()
        return await _build_full_round(db, row, owner_id)


@router.delete("/{round_id}")
async def delete_round(
    round_id: str, owner_id: str = Depends(current_user_id)
):
    """Delete a round and all its normalised children (CASCADE on FK).

    Also removes this round_id from the linked tournament's round_ids JSONB.
    """
    now = datetime.now(timezone.utc)
    async with async_session() as db:
        row = await _get_owned_round_row(db, round_id, owner_id)

        # Remove from tournament.round_ids if linked, scoped to owner
        if row.tournament_id:
            t_result = await db.execute(
                select(TournamentORM).where(
                    TournamentORM.id == row.tournament_id,
                    TournamentORM.owner_id == owner_id,
                )
            )
            tournament = t_result.scalar_one_or_none()
            if tournament and round_id in (tournament.round_ids or []):
                tournament.round_ids = [
                    r for r in tournament.round_ids if r != round_id
                ]
                tournament.updated_at = now
                flag_modified(tournament, "round_ids")

        await db.delete(row)
        await db.commit()
    return {"status": "deleted"}
