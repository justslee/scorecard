"""JSON file-based storage for the Scorecard API."""

import json
import os
from pathlib import Path
from typing import TypeVar, Generic
from pydantic import BaseModel

# Data directory
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

T = TypeVar("T", bound=BaseModel)


class JSONStorage(Generic[T]):
    """Simple JSON file storage for a collection of items."""
    
    def __init__(self, filename: str, model_class: type[T]):
        self.filepath = DATA_DIR / filename
        self.model_class = model_class
        self._ensure_file()
    
    def _ensure_file(self):
        """Create file with empty list if it doesn't exist."""
        if not self.filepath.exists():
            self.filepath.write_text("[]")
    
    def _read_all(self) -> list[dict]:
        """Read all items from file."""
        try:
            return json.loads(self.filepath.read_text())
        except (json.JSONDecodeError, FileNotFoundError):
            return []
    
    def _write_all(self, items: list[dict]):
        """Write all items to file."""
        self.filepath.write_text(json.dumps(items, indent=2))
    
    def get_all(self) -> list[T]:
        """Get all items."""
        data = self._read_all()
        return [self.model_class(**item) for item in data]
    
    def get_by_id(self, id: str) -> T | None:
        """Get item by ID."""
        data = self._read_all()
        for item in data:
            if item.get("id") == id:
                return self.model_class(**item)
        return None
    
    def create(self, item: T) -> T:
        """Create a new item."""
        data = self._read_all()
        data.insert(0, item.model_dump())  # Add to beginning
        self._write_all(data)
        return item
    
    def update(self, id: str, item: T) -> T | None:
        """Update an existing item."""
        data = self._read_all()
        for i, existing in enumerate(data):
            if existing.get("id") == id:
                data[i] = item.model_dump()
                self._write_all(data)
                return item
        return None
    
    def delete(self, id: str) -> bool:
        """Delete an item by ID."""
        data = self._read_all()
        original_len = len(data)
        data = [item for item in data if item.get("id") != id]
        if len(data) < original_len:
            self._write_all(data)
            return True
        return False
    
    def find(self, predicate) -> list[T]:
        """Find items matching a predicate."""
        data = self._read_all()
        return [self.model_class(**item) for item in data if predicate(item)]


# Storage instances
from app.models import SavedPlayer, Round, Tournament, Course

players_storage = JSONStorage("players.json", SavedPlayer)
rounds_storage = JSONStorage("rounds.json", Round)
tournaments_storage = JSONStorage("tournaments.json", Tournament)
courses_storage = JSONStorage("courses.json", Course)


def seed_default_data():
    """Seed default data if storage is empty."""
    from datetime import datetime
    
    # Seed default players
    if len(players_storage.get_all()) == 0:
        now = datetime.now().isoformat()
        default_players = [
            SavedPlayer(
                id="player-justin-lee", name="Justin Lee", nickname="JL",
                handicap=3.2, email="justin@email.com", roundsPlayed=0,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-mike-chen", name="Mike Chen", nickname="Bomber",
                handicap=8.2, email="mike.chen@email.com", roundsPlayed=24,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-david-kim", name="David Kim", nickname="DK",
                handicap=5.1, email="dkim@email.com", roundsPlayed=18,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-sarah-park", name="Sarah Park", nickname="Steady",
                handicap=12.5, email="sarah.p@email.com", phone="+1 555-234-5678",
                roundsPlayed=15, createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-kevin-zhang", name="Kevin Zhang", nickname="KZ",
                handicap=7.4, email="kevin.z@email.com", roundsPlayed=12,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-james-wilson", name="James Wilson", nickname="JW",
                handicap=18.4, roundsPlayed=8, createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-alex-rodriguez", name="Alex Rodriguez", nickname="A-Rod",
                handicap=14.8, phone="+1 555-876-5432", roundsPlayed=6,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-emily-watson", name="Emily Watson", nickname="Em",
                handicap=10.3, email="emily.w@email.com", phone="+1 555-345-6789",
                roundsPlayed=5, createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-tom-bradley", name="Tom Bradley", nickname="TB",
                handicap=22.1, email="tom.bradley@email.com", roundsPlayed=3,
                createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-chris-nguyen", name="Chris Nguyen", nickname="Slice King",
                handicap=16.7, roundsPlayed=2, createdAt=now, updatedAt=now
            ),
            SavedPlayer(
                id="player-ryan-murphy", name="Ryan Murphy", nickname="Murph",
                handicap=25.6, roundsPlayed=1, createdAt=now, updatedAt=now
            ),
        ]
        for player in default_players:
            players_storage.create(player)
    
    # Seed default courses
    if len(courses_storage.get_all()) == 0:
        default_holes = [
            {"number": i, "par": [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5][i-1]}
            for i in range(1, 19)
        ]
        from app.models import HoleInfo
        holes = [HoleInfo(**h) for h in default_holes]
        
        default_courses = [
            Course(id="course-pebble", name="Pebble Beach Golf Links", holes=holes, location="Pebble Beach, CA"),
            Course(id="course-tpc", name="TPC Sawgrass", holes=holes, location="Ponte Vedra Beach, FL"),
            Course(id="course-augusta", name="Augusta National", holes=holes, location="Augusta, GA"),
        ]
        for course in default_courses:
            courses_storage.create(course)
