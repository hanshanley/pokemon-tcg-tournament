import tempfile
from datetime import date, timedelta
from pathlib import Path

import uvicorn

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.policy import POLICY
from tournament.service import Service
from tournament.store import Store


def browser_snapshot(as_of: date):
    snapshot = sample_snapshot()
    snapshot["policy"] = {
        **POLICY,
        "id": "synthetic-browser-test-policy",
        "reviewed_through": str(as_of + timedelta(days=1)),
    }
    return snapshot


def main():
    with tempfile.TemporaryDirectory(prefix="tournament-browser-test-") as directory:
        store = Store(Path(directory))
        store.save_snapshot(browser_snapshot(date.today()))
        service = Service(store)
        try:
            service.add_deck("Fixture research deck", DECK_TEXT, service.latest(), date.today())
        finally:
            service.close()
        uvicorn.run(create_app(Path(directory)), host="127.0.0.1", port=8003)


if __name__ == "__main__":
    main()
