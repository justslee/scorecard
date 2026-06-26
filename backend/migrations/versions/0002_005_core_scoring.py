"""005_core_scoring: core scoring domain tables.

Revision ID: 002_core_scoring
Revises: 001_baseline
Create Date: 2026-06-26

Creates the 8 new relational tables that replace backend/data/*.json for the
core scoring domain: players, golfer_profiles, tournaments, rounds,
player_groups, round_players, scores, games.

All tables carry an owner_id column (single-owner beta, multi-user-ready),
mirroring the caddie tables. Apply on the EC2 deploy box after stamping the
baseline revision — see 0001_baseline_caddie_schema.py for the protocol.

Table creation order respects FK dependencies:
  players → golfer_profiles → tournaments → rounds →
  player_groups → round_players → scores → games
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

# revision identifiers
revision: str = "002_core_scoring"
down_revision: Union[str, Sequence[str], None] = "001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── players ─────────────────────────────────────────────────────────────
    # The roster of saved golfers. Distinct from caddie.player_profiles, which
    # stores AI-facing stats; this table stores user-facing identity.
    op.create_table(
        "players",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_id", sa.Text, nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("nickname", sa.Text, nullable=True),
        sa.Column("email", sa.Text, nullable=True),
        sa.Column("phone", sa.Text, nullable=True),
        sa.Column("handicap", sa.Numeric, nullable=True),
        sa.Column("avatar_url", sa.Text, nullable=True),
        sa.Column("clerk_user_id", sa.Text, nullable=True),
        sa.Column(
            "rounds_played", sa.Integer, nullable=False, server_default="0"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("players_owner_id_idx", "players", ["owner_id"])

    # ── golfer_profiles ──────────────────────────────────────────────────────
    # User-facing identity, handicap history, bag, and strokes-gained summary.
    # Distinct from caddie.player_profiles (AI stats). May cross-reference later.
    op.create_table(
        "golfer_profiles",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Text, nullable=False),
        sa.Column("owner_id", sa.Text, nullable=True),
        sa.Column("handicap_index", sa.Numeric, nullable=True),
        sa.Column("scoring_average", sa.Numeric, nullable=True),
        sa.Column(
            "bag_clubs", JSONB, nullable=False, server_default="'{}'::jsonb"
        ),
        sa.Column("home_course_id", sa.Text, nullable=True),
        sa.Column(
            "play_count", sa.Integer, nullable=False, server_default="0"
        ),
        sa.Column(
            "handicap_history",
            JSONB,
            nullable=False,
            server_default="'[]'::jsonb",
        ),
        sa.Column(
            "strokes_gained",
            JSONB,
            nullable=False,
            server_default="'{}'::jsonb",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "golfer_profiles_user_id_idx", "golfer_profiles", ["user_id"], unique=True
    )
    op.create_index("golfer_profiles_owner_id_idx", "golfer_profiles", ["owner_id"])

    # ── tournaments ──────────────────────────────────────────────────────────
    # Created before rounds so rounds.tournament_id can FK reference it.
    op.create_table(
        "tournaments",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_id", sa.Text, nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("num_rounds", sa.Integer, nullable=True),
        sa.Column(
            "round_ids", JSONB, nullable=False, server_default="'[]'::jsonb"
        ),
        sa.Column(
            "player_ids", JSONB, nullable=False, server_default="'[]'::jsonb"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("tournaments_owner_id_idx", "tournaments", ["owner_id"])

    # ── rounds ───────────────────────────────────────────────────────────────
    # One row per scoring round. `holes` is kept as JSONB (the hole-par/handicap
    # snapshot for this round) because structural course data lives in the
    # course-mapping tables (courses/tee_sets/holes from migration 001).
    op.create_table(
        "rounds",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_id", sa.Text, nullable=True),
        sa.Column("course_id", sa.Text, nullable=False),
        sa.Column("course_name", sa.Text, nullable=False),
        sa.Column("tee_id", sa.Text, nullable=True),
        sa.Column("tee_name", sa.Text, nullable=True),
        sa.Column("date", sa.Text, nullable=False),
        sa.Column(
            "status", sa.Text, nullable=False, server_default=sa.text("'active'")
        ),
        sa.Column(
            "tournament_id",
            UUID(as_uuid=False),
            sa.ForeignKey("tournaments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Hole snapshot (par, handicap, yards) stored as JSONB for the round;
        # structural course data is in the course-mapping tables.
        sa.Column(
            "holes", JSONB, nullable=False, server_default="'[]'::jsonb"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("rounds_owner_id_idx", "rounds", ["owner_id"])
    op.create_index("rounds_tournament_id_idx", "rounds", ["tournament_id"])
    op.create_index("rounds_date_idx", "rounds", ["date"])

    # ── player_groups ────────────────────────────────────────────────────────
    # Tee-time groups within a round (e.g. "Group A, 8:00am, hole 1").
    op.create_table(
        "player_groups",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "round_id",
            UUID(as_uuid=False),
            sa.ForeignKey("rounds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("tee_time", sa.Text, nullable=True),
        sa.Column("starting_hole", sa.Integer, nullable=True),
        sa.Column(
            "player_ids", JSONB, nullable=False, server_default="'[]'::jsonb"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("player_groups_round_id_idx", "player_groups", ["round_id"])

    # ── round_players ────────────────────────────────────────────────────────
    # Normalized: one row per (round, player). group_id is optional (player may
    # not be assigned to a group).
    op.create_table(
        "round_players",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "round_id",
            UUID(as_uuid=False),
            sa.ForeignKey("rounds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("player_id", sa.Text, nullable=False),
        sa.Column(
            "group_id",
            UUID(as_uuid=False),
            sa.ForeignKey("player_groups.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("handicap", sa.Numeric, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("round_players_round_id_idx", "round_players", ["round_id"])
    op.create_index(
        "round_players_player_id_idx", "round_players", ["player_id"]
    )
    op.create_unique_constraint(
        "round_players_round_player_uq", "round_players", ["round_id", "player_id"]
    )

    # ── scores ───────────────────────────────────────────────────────────────
    # Normalized: one row per (round, player, hole). Unique constraint enforces
    # upsert semantics (one score per player per hole per round).
    op.create_table(
        "scores",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "round_id",
            UUID(as_uuid=False),
            sa.ForeignKey("rounds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("player_id", sa.Text, nullable=False),
        sa.Column("hole_number", sa.Integer, nullable=False),
        sa.Column("strokes", sa.Integer, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("scores_round_id_idx", "scores", ["round_id"])
    op.create_index("scores_player_id_idx", "scores", ["player_id"])
    op.create_unique_constraint(
        "scores_round_player_hole_uq",
        "scores",
        ["round_id", "player_id", "hole_number"],
    )

    # ── games ────────────────────────────────────────────────────────────────
    # Normalized scoring games, each scoped to a round OR a tournament (nullable
    # FKs). Managed via round/tournament endpoints — no standalone /api/games.
    # player_ids, teams, settings stored as JSONB for flexible per-format shapes.
    op.create_table(
        "games",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "round_id",
            UUID(as_uuid=False),
            sa.ForeignKey("rounds.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "tournament_id",
            UUID(as_uuid=False),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("format", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column(
            "player_ids", JSONB, nullable=False, server_default="'[]'::jsonb"
        ),
        sa.Column("teams", JSONB, nullable=True),
        sa.Column("settings", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("games_round_id_idx", "games", ["round_id"])
    op.create_index("games_tournament_id_idx", "games", ["tournament_id"])


def downgrade() -> None:
    # Drop in reverse FK order.
    op.drop_table("games")
    op.drop_table("scores")
    op.drop_table("round_players")
    op.drop_table("player_groups")
    op.drop_table("rounds")
    op.drop_table("tournaments")
    op.drop_table("golfer_profiles")
    op.drop_table("players")
