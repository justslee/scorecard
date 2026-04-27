"""Async SQLAlchemy engine bound to DATABASE_URL.

DATABASE_URL must use the asyncpg driver, e.g.
    postgresql+asyncpg://user:pass@host:5432/scorecard
"""

import os
from typing import AsyncIterator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Configure it to a Postgres instance with the asyncpg driver, "
        "e.g. postgresql+asyncpg://user:pass@host:5432/scorecard. See backend/.env.example."
    )


engine = create_async_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
    echo=False,
)

async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an async session."""
    async with async_session() as session:
        yield session
