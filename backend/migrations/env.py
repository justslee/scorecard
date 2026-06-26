"""Alembic environment — async SQLAlchemy setup wired to DATABASE_URL.

Running offline (--sql flag): generates SQL without a live DB connection.
Running online: uses the async engine from app.db.engine.

Baseline protocol for the live RDS (EC2 deploy box):
  1. alembic stamp 001_baseline   # mark the caddie 001-004 schema as applied
  2. alembic upgrade head          # apply only 005 (002_core_scoring here)
DATABASE_URL must be set in the environment; see backend/.env.example.
"""

import asyncio
import os
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# --- Alembic config object ---
config = context.config

# Override URL from environment (alembic.ini has no sqlalchemy.url key).
# For offline SQL generation a real connection is not made, so a placeholder URL works.
_db_url = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://user:pass@localhost/scorecard",
)
config.set_main_option("sqlalchemy.url", _db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Import Base so metadata is populated with all ORM models.
# app.db.models registers the caddie + new scoring models via Base.
from app.db.engine import Base  # noqa: E402
import app.db.models  # noqa: E402, F401  — side-effect: registers models with metadata

target_metadata = Base.metadata


def _offline_url(url: str) -> str:
    """Strip the +asyncpg driver suffix for offline SQL rendering.

    The asyncpg async dialect is only needed for live connections.
    The plain postgresql dialect renders identical DDL and works without
    asyncpg being imported in offline mode.
    """
    return url.replace("+asyncpg", "")


def run_migrations_offline() -> None:
    """Generate SQL script without a live DB connection (alembic upgrade --sql)."""
    url = _offline_url(config.get_main_option("sqlalchemy.url"))
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=False,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
