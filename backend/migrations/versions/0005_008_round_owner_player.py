"""008_round_owner_player: add owner_player_id column to rounds.

Records WHICH player in a round represents the round's owner (the signed-in
user), so owner stats are no longer derived from the brittle `players[0]`
assumption (a round where the owner is not first-listed otherwise attributes
another player's scores to the owner — see backlog owner-player-identity).

Schema decisions:
  * Nullable Text — existing rows (and any round created before the client
    sends `ownerPlayerId`) stay NULL; the API falls back to the first
    round_player, preserving the prior behaviour for legacy rounds.
  * Plain text id (matches round_players.player_id, which is itself a plain
    text FK with no DB-level constraint), so no FK is added here.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision: str = "008_round_owner_player"
down_revision: Union[str, Sequence[str], None] = "007_golfer_profile_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "rounds",
        sa.Column("owner_player_id", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rounds", "owner_player_id")
