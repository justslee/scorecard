"""Tournaments API routes — Postgres-backed (migration 002_core_scoring).

Replaces the JSON-file tournaments_storage. The camelCase Pydantic contract
(Tournament / TournamentCreate / TournamentUpdate) is preserved unchanged so
the frontend api.ts layer needs no adjustment.

Owner scoping: every query filters by owner_id == current_user_id.
The require_owner gate is applied at the app level (main.py); here we
only need current_user_id to pull the caller's identity for row-level
filtering.

playerNamesById: derived on read via a join to the players table (owner-scoped,
same pattern as rounds.py _build_full_round). No separate JSONB column is needed;
falls back to "Unknown" when a player has been deleted from the roster.

Games: tournament-scoped games live in the games table with tournament_id FK
(round_id NULL). They are loaded by _build_full_tournament and wholesale-replaced
on PUT if data.games is supplied.
"""

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm.attributes import flag_modified

from app.db.engine import async_session
from app.db.models import (
    Game as GameORM,
    Player as PlayerORM,
    Tournament as TournamentORM,
)
from app.models import (
    Game as GameModel,
    Tournament,
    TournamentCreate,
    TournamentUpdate,
)
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/tournaments", tags=["tournaments"])


# ─── helpers ──────────────────────────────────────────────────────────────────


async def _build_full_tournament(
    db, row: TournamentORM, owner_id: str
) -> Tournament:
    """Reassemble the full Tournament Pydantic shape from normalised DB tables.

    Derives playerNamesById via a join to the players table (owner-scoped, same
    pattern as rounds.py). Falls back to "Unknown" for deleted-roster players
    (cross-domain plain-text ref, no DB-level FK — per spec §C loose coupling).

    Loads tournament-scoped games from the games table (tournament_id FK).
    """
    tournament_id = row.id

    # Derive playerNamesById via players join — owner-scoped to prevent
    # cross-tenant name resolution.
    player_ids: list[str] = list(row.player_ids or [])
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

    # Load tournament-scoped games (round_id is NULL for these rows).
    gm_result = await db.execute(
        select(GameORM).where(GameORM.tournament_id == tournament_id)
    )
    games = [
        GameModel(
            id=g.id,
            roundId=None,  # tournament-scoped games have no round
            format=g.format,
            name=g.name,
            playerIds=g.player_ids or [],
            teams=g.teams,
            settings=g.settings,
        )
        for g in gm_result.scalars().all()
    ]

    return Tournament(
        id=row.id,
        name=row.name,
        numRounds=row.num_rounds,
        roundIds=list(row.round_ids or []),
        playerIds=player_ids,
        playerNamesById=player_name_map if player_name_map else None,
        games=games,
        createdAt=row.created_at.isoformat() if row.created_at else "",
        updatedAt=row.updated_at.isoformat() if row.updated_at else "",
    )


async def _get_owned_tournament_row(
    db, tournament_id: str, owner_id: str
) -> TournamentORM:
    """Return the Tournament ORM row for this owner; raise 404 if missing."""
    result = await db.execute(
        select(TournamentORM).where(
            TournamentORM.id == tournament_id,
            TournamentORM.owner_id == owner_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return row


# ─── routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=list[Tournament])
async def get_tournaments(owner_id: str = Depends(current_user_id)):
    """List all tournaments belonging to the calling owner (newest first)."""
    async with async_session() as db:
        result = await db.execute(
            select(TournamentORM)
            .where(TournamentORM.owner_id == owner_id)
            .order_by(TournamentORM.created_at.desc())
        )
        rows = result.scalars().all()
        return [await _build_full_tournament(db, row, owner_id) for row in rows]


@router.get("/{tournament_id}", response_model=Tournament)
async def get_tournament(
    tournament_id: str, owner_id: str = Depends(current_user_id)
):
    """Get a single tournament by id. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        row = await _get_owned_tournament_row(db, tournament_id, owner_id)
        return await _build_full_tournament(db, row, owner_id)


@router.post("", response_model=Tournament)
async def create_tournament(
    data: TournamentCreate, owner_id: str = Depends(current_user_id)
):
    """Create a new tournament owned by the calling user.

    id is a real UUID so that rounds can FK to it via rounds.tournament_id.
    """
    now = datetime.now(timezone.utc)
    row = TournamentORM(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        name=data.name,
        num_rounds=data.numRounds,
        player_ids=list(data.playerIds),
        round_ids=[],
        created_at=now,
        updated_at=now,
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return await _build_full_tournament(db, row, owner_id)


@router.put("/{tournament_id}", response_model=Tournament)
async def update_tournament(
    tournament_id: str,
    data: TournamentUpdate,
    owner_id: str = Depends(current_user_id),
):
    """Update a tournament. Returns 404 if not owned by the caller.

    Only fields provided (non-None) are touched. Games are wholesale-replaced
    (delete-then-insert) when data.games is supplied, matching the rounds
    endpoint convention.
    """
    now = datetime.now(timezone.utc)
    async with async_session() as db:
        row = await _get_owned_tournament_row(db, tournament_id, owner_id)

        if data.name is not None:
            row.name = data.name
        if data.numRounds is not None:
            row.num_rounds = data.numRounds
        if data.roundIds is not None:
            row.round_ids = data.roundIds
            flag_modified(row, "round_ids")
        if data.playerIds is not None:
            row.player_ids = data.playerIds
            flag_modified(row, "player_ids")

        # Wholesale-replace tournament-scoped games when supplied
        if data.games is not None:
            await db.execute(
                delete(GameORM).where(GameORM.tournament_id == tournament_id)
            )
            for game in data.games:
                db.add(
                    GameORM(
                        id=game.id,
                        tournament_id=tournament_id,
                        round_id=None,
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
        return await _build_full_tournament(db, row, owner_id)


@router.delete("/{tournament_id}")
async def delete_tournament(
    tournament_id: str, owner_id: str = Depends(current_user_id)
):
    """Delete a tournament and its tournament-scoped games (CASCADE on FK).

    Rounds that reference this tournament have their tournament_id SET NULL
    (per the FK ondelete='SET NULL' on rounds.tournament_id) — round rows
    are preserved; only the tournament grouping is removed.
    """
    async with async_session() as db:
        row = await _get_owned_tournament_row(db, tournament_id, owner_id)
        await db.delete(row)
        await db.commit()
    return {"status": "deleted"}


@router.post("/{tournament_id}/players/{player_id}")
async def add_player_to_tournament(
    tournament_id: str,
    player_id: str,
    player_name: str = "",
    owner_id: str = Depends(current_user_id),
):
    """Add a player to a tournament.

    Appends player_id to tournament.player_ids (JSONB list). playerNamesById
    is derived from the players table on every read (no separate storage column
    needed). The player_name query param is accepted for API compat but is not
    stored — the players table is the source of truth for names.
    """
    now = datetime.now(timezone.utc)
    async with async_session() as db:
        row = await _get_owned_tournament_row(db, tournament_id, owner_id)

        current_ids: list[str] = list(row.player_ids or [])
        if player_id not in current_ids:
            current_ids.append(player_id)
            row.player_ids = current_ids
            flag_modified(row, "player_ids")
            row.updated_at = now
            await db.commit()

    return {"status": "added"}
