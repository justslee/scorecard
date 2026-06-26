"""JSON file-based storage for the Scorecard API."""

import json
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
# NOTE: players_storage removed — players migrated to Postgres (routes/players.py).
from app.models import Round, Tournament, Course  # noqa: E402  (late import avoids a circular dependency)

rounds_storage = JSONStorage("rounds.json", Round)
tournaments_storage = JSONStorage("tournaments.json", Tournament)
courses_storage = JSONStorage("courses.json", Course)


def seed_default_data():
    """Seed default data if storage is empty.

    Players are now Postgres-backed (routes/players.py); only course seeding
    remains here until backend-courses-db migrates courses to Postgres.
    """
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
