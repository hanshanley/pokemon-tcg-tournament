import tempfile
from datetime import date
from pathlib import Path

import uvicorn

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.service import Service
from tournament.store import Store


def main():
    with tempfile.TemporaryDirectory(prefix="tournament-browser-test-") as directory:
        store = Store(Path(directory))
        store.save_snapshot(sample_snapshot())
        service = Service(store)
        try:
            service.add_deck(
                "Fixture research deck", DECK_TEXT, service.latest(), date(2026, 11, 14)
            )
        finally:
            service.close()
        uvicorn.run(create_app(Path(directory)), host="127.0.0.1", port=8003)


if __name__ == "__main__":
    main()
