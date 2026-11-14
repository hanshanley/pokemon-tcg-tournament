import argparse
import os
from pathlib import Path

import uvicorn

from tournament.service import Service
from tournament.sources import sync_cards
from tournament.store import Store


def main():
    parser = argparse.ArgumentParser(description="Pokemon TCG Tournament Lab")
    parser.add_argument("command", choices=["serve", "sync"])
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run("tournament.app:app", host="127.0.0.1", port=args.port)
    else:
        root = Path(__file__).resolve().parents[1]
        store = Store(Path(os.environ.get("TOURNAMENT_DATA_DIR", root / "data")))
        service = Service(store)
        try:
            snapshot = sync_cards(store, print)
            print(f"Saved {snapshot['card_count']} printings at {snapshot['source_commit'][:10]}")
            print(f"Indexed {service.sync_events(print)} in-person Standard events")
        finally:
            service.close()


if __name__ == "__main__":
    main()
