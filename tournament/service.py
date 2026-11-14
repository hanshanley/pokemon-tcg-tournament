import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import lru_cache

from tournament.decks import resolve_deck, validate_deck
from tournament.policy import POLICY, Legality
from tournament.sources import (
    LIMITLESS,
    fetch,
    parse_deck_links,
    parse_deck_text,
    parse_tournaments,
    sync_cards,
)
from tournament.store import digest, now


class Service:
    def __init__(self, store):
        self.store = store
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="source-sync")
        self.lock = threading.Lock()
        self.snapshot = lru_cache(maxsize=3)(self._snapshot)
        self.assessed = lru_cache(maxsize=4)(self._assessed)
        for job in store.list("job"):
            if job["status"] in ("running", "queued"):
                store.put("job", {**job, "status": "interrupted", "message": "Service restarted."})

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.snapshot.cache_clear()
        self.assessed.cache_clear()

    def _snapshot(self, snapshot_id):
        return self.store.artifact("snapshots", snapshot_id)

    def latest(self):
        snapshots = self.store.list("snapshot")
        if not snapshots:
            raise ValueError("Sync the card catalog before importing decks or running experiments.")
        return self.snapshot(snapshots[0]["id"])

    def _assessed(self, snapshot_id, as_of):
        snapshot = self.snapshot(snapshot_id)
        legality = Legality(snapshot, date.fromisoformat(as_of))
        sets = legality.sets
        rows = []
        for card in snapshot["cards"]:
            expansion = sets.get(card["set_id"], {})
            rows.append(
                {
                    "id": card["id"],
                    "name": card["name"],
                    "category": card["supertype"],
                    "subtypes": card.get("subtypes", []),
                    "set_id": card["set_id"],
                    "set_name": expansion.get("name", card["set_id"]),
                    "set_code": expansion.get("ptcgoCode", ""),
                    "number": card.get("number"),
                    "mark": card.get("regulationMark"),
                    "hp": card.get("hp"),
                    "legality": legality.check(card),
                }
            )
        rows.sort(key=lambda row: row["name"].casefold())
        rows.sort(
            key=lambda row: sets.get(row["set_id"], {}).get("releaseDate", "").replace("/", "-"),
            reverse=True,
        )
        return rows

    def add_deck(self, name, text, snapshot, as_of, source=None):
        resolved = resolve_deck(text, snapshot)
        resolved.pop("cards")
        validation = validate_deck(resolved, snapshot, as_of)
        return self.store.put(
            "deck",
            {
                "name": name,
                "snapshot_id": snapshot["id"],
                "policy": POLICY,
                "text": text,
                **resolved,
                "validation": validation,
                "source": source or {"type": "manual"},
            },
        )

    def sync_events(self, progress=lambda message: None):
        progress("Fetching completed in-person international Standard events")
        raw = fetch(f"{LIMITLESS}/tournaments")
        events = parse_tournaments(raw)
        if not events:
            raise ValueError("No Standard events parsed. Source layout may have changed.")
        for event in events:
            if event["date"] > date.today().isoformat():
                continue
            self.store.put(
                "event",
                {
                    **event,
                    "id": f"limitless-{event['id']}",
                    "provider_id": event["id"],
                    "fetched_at": now(),
                    "source_sha256": hashlib.sha256(raw).hexdigest(),
                },
            )
        return len(events)

    def import_event(self, event_id, top, progress=lambda message: None):
        event = self.store.get("event", event_id)
        if not event:
            raise ValueError("Event not found. Sync the tournament index first.")
        snapshot = self.latest()
        progress(f"Reading {event['name']} standings")
        page = fetch(event["url"])
        links = parse_deck_links(page)
        if not links:
            raise ValueError("No decklist links found. Source layout may have changed.")
        selected = [
            link for link in links if link["placing"].isdigit() and int(link["placing"]) <= top
        ]
        if not selected:
            raise ValueError("No published decklists found within the requested placing cutoff.")
        imported, failures = [], []
        existing = {
            (
                deck.get("source", {}).get("event_id"),
                deck.get("source", {}).get("placing"),
                deck["snapshot_id"],
            )
            for deck in self.store.list("deck")
        }
        for link in selected:
            placing = int(link["placing"])
            if (event_id, placing, snapshot["id"]) in existing:
                continue
            progress(f"Importing placing {placing}: {link['archetype']}")
            try:
                raw = fetch(link["url"])
                text = parse_deck_text(raw)
                deck = self.add_deck(
                    f"{link['archetype']} · {event['name']} #{placing}",
                    text,
                    snapshot,
                    date.today(),
                    source={
                        "type": "in-person-tournament",
                        "event_id": event_id,
                        "event_name": event["name"],
                        "event_date": event["date"],
                        "placing": placing,
                        "archetype": link["archetype"],
                        "url": link["url"],
                        "fetched_at": now(),
                        "source_sha256": hashlib.sha256(raw).hexdigest(),
                        "coverage": f"Published top-{top} lists; "
                        "not all entrants or the full metagame.",
                    },
                )
                imported.append(deck["id"])
            except Exception as error:
                failures.append({"placing": placing, "url": link["url"], "error": str(error)})
        if failures and not imported:
            raise ValueError(json.dumps(failures))
        return {"imported_deck_ids": imported, "failures": failures, "selected": len(selected)}

    def start_job(self, kind, event_id=None, top=8):
        with self.lock:
            if any(job["status"] in ("queued", "running") for job in self.store.list("job")):
                raise ValueError("A source operation is already in progress.")
            job = self.store.put(
                "job",
                {
                    "kind": kind,
                    "event_id": event_id,
                    "status": "queued",
                    "message": "Queued",
                    "top": top,
                },
            )
            self.executor.submit(self._job, job)
        return job

    def _job(self, job):
        def progress(message):
            job.update(status="running", message=message, updated_at=now())
            self.store.put("job", job)

        try:
            progress("Starting source operation")
            result = {}
            if job["kind"] in ("cards", "all"):
                result["snapshot"] = sync_cards(self.store, progress)
            if job["kind"] in ("events", "all"):
                result["events"] = self.sync_events(progress)
            if job["kind"] == "import":
                result = self.import_event(job["event_id"], job["top"], progress)
            message = "Operation completed"
            if job["kind"] == "import":
                message = (
                    f"{len(result['imported_deck_ids'])} deck versions imported; "
                    f"{len(result['failures'])} source failures."
                )
                if result["failures"]:
                    message += " " + "; ".join(
                        f"#{failure['placing']}: {failure['error']}"
                        for failure in result["failures"]
                    )
            job.update(status="completed", message=message, result=result)
        except Exception as error:
            job.update(status="failed", message=str(error))
        job["updated_at"] = now()
        self.store.put("job", job)

    def card_map(self, snapshot):
        return {card["id"]: card for card in snapshot["cards"]}

    def provenance(self, snapshot):
        return {
            "snapshot_id": snapshot["id"],
            "content_sha256": snapshot["content_sha256"],
            "source_commit": snapshot["source_commit"],
            "policy_sha256": digest(POLICY),
        }
