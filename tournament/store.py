import gzip
import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path


def now():
    return datetime.now(UTC).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class Store:
    def __init__(self, directory: Path):
        self.directory = directory
        (directory / "snapshots").mkdir(parents=True, exist_ok=True)
        (directory / "experiments").mkdir(exist_ok=True)
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
            """)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.directory / "tournament.sqlite3", timeout=15)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def put(self, kind, value):
        value = {**value}
        value.setdefault("id", uuid.uuid4().hex)
        value.setdefault("created_at", now())
        with self.db() as db:
            db.execute(
                "INSERT OR REPLACE INTO records VALUES (?, ?, ?)",
                (value["id"], kind, json.dumps(value)),
            )
        return value

    def get(self, kind, record_id):
        with self.db() as db:
            row = db.execute(
                "SELECT payload FROM records WHERE kind = ? AND id = ?", (kind, record_id)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, kind):
        with self.db() as db:
            rows = db.execute(
                "SELECT payload FROM records WHERE kind = ? ORDER BY rowid DESC", (kind,)
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def artifact(self, folder, artifact_id, value=None):
        path = self.directory / folder / f"{artifact_id}.json.gz"
        if value is not None:
            temporary = path.with_suffix(".tmp")
            with gzip.open(temporary, "wt", encoding="utf-8") as file:
                json.dump(value, file)
            temporary.replace(path)
        with gzip.open(path, "rt", encoding="utf-8") as file:
            return json.load(file)

    def save_snapshot(self, snapshot):
        snapshot_id = uuid.uuid4().hex
        snapshot["id"] = snapshot_id
        snapshot["content_sha256"] = digest({"cards": snapshot["cards"], "sets": snapshot["sets"]})
        self.artifact("snapshots", snapshot_id, snapshot)
        return self.put(
            "snapshot",
            {key: value for key, value in snapshot.items() if key not in ("cards", "sets")},
        )
