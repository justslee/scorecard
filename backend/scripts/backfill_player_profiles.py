"""One-shot backfill: seed `player_profiles` from existing JSON-stored players.

Run once after applying migration 002. Idempotent — re-running upserts.

Usage:
    cd backend && DATABASE_URL=postgresql+asyncpg://... python -m scripts.backfill_player_profiles
"""

import asyncio
import sys
from sqlalchemy.dialects.postgresql import insert

from app.db.engine import async_session
from app.db.models import PlayerProfile
from app.storage import players_storage


async def main() -> int:
    saved = players_storage.get_all()
    if not saved:
        print("No saved players found in JSON storage. Nothing to backfill.")
        return 0

    upserted = 0
    async with async_session() as db:
        for p in saved:
            stmt = insert(PlayerProfile).values(
                user_id=p.id,
                handicap=p.handicap,
            ).on_conflict_do_update(
                index_elements=["user_id"],
                set_={"handicap": p.handicap},
            )
            await db.execute(stmt)
            upserted += 1
        await db.commit()

    print(f"Upserted {upserted} player profiles.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
