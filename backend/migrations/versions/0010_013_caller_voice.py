"""013_caller_voice: the owner's saved AI-caller preset voice pick.

Adds nullable ``caller_voice`` (a preset OpenAI Realtime voice name, e.g.
"cedar") to ``golfer_profiles``. Powers the owner-gated caller-voice picker
(specs/voice-clone-caller-plan.md §2B/§3, Option B — no voice cloning; the
Realtime bridge speaks in a natural PRESET voice the owner chooses).

Additive and nullable: existing rows are unaffected; a null column falls
through to the env/default via caller_voice.resolve_caller_voice(). No backfill.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers
revision: str = "013_caller_voice"
down_revision: Union[str, Sequence[str], None] = "012_round_course_anchor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("golfer_profiles", sa.Column("caller_voice", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("golfer_profiles", "caller_voice")
