import io
import json
import os
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StringConstraints

from tournament.battles import Battles
from tournament.decks import validate_deck
from tournament.experiments import run_experiment
from tournament.policy import source_status
from tournament.service import Service
from tournament.store import Store

ROOT = Path(__file__).resolve().parents[1]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
AsOf = Annotated[date, Query(default_factory=date.today)]


class DeckInput(BaseModel):
    name: Name
    text: str = Field(min_length=1, max_length=20000)
    as_of: date = Field(default_factory=date.today)


class JobInput(BaseModel):
    kind: Literal["cards", "events", "all"] = "all"


class EventInput(BaseModel):
    top: int = Field(default=8, ge=1, le=32)


class ExperimentInput(BaseModel):
    name: Name
    deck_id: str
    target_ids: list[str] = Field(min_length=1, max_length=60)
    minimum: int = Field(default=1, ge=1, le=7)
    trials: int = Field(default=5000, ge=100, le=20000)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    as_of: date = Field(default_factory=date.today)


class BattleInput(BaseModel):
    name: Name
    deck_ids: list[str] = Field(min_length=2, max_length=2)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    max_actions: int = Field(default=1200, ge=2, le=5000)
    max_turns: int = Field(default=200, ge=1, le=500)
    as_of: date = Field(default_factory=date.today)


def create_app(data_dir=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store(
            Path(data_dir or os.environ.get("TOURNAMENT_DATA_DIR", ROOT / "data"))
        )
        app.state.service = Service(app.state.store)
        app.state.battles = Battles(app.state.store, app.state.service)
        yield
        app.state.battles.close()
        app.state.service.close()

    app = FastAPI(title="Pokemon TCG Tournament Lab", lifespan=lifespan)

    @app.exception_handler(ValueError)
    async def value_error(request, error):
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.get("/api/health")
    def health():
        policy = app.state.service.policy()
        return {
            "status": "ok",
            "today": str(date.today()),
            "default_as_of": str(date.today()),
            "policy": policy,
            "source_status": source_status(policy),
        }

    @app.get("/api/overview")
    def overview(as_of: AsOf):
        snapshots = app.state.store.list("snapshot")
        counts = {}
        if snapshots:
            for card in app.state.service.assessed(snapshots[0]["id"], str(as_of)):
                status = card["legality"]["status"]
                counts[status] = counts.get(status, 0) + 1
        return {
            "today": str(date.today()),
            "as_of": str(as_of),
            "policy": app.state.service.policy(),
            "source_status": source_status(app.state.service.policy()),
            "snapshot": snapshots[0] if snapshots else None,
            "counts": counts,
            "decks": app.state.store.list("deck"),
            "events": app.state.store.list("event"),
            "experiments": app.state.store.list("experiment"),
            "jobs": app.state.store.list("job")[:20],
            "battles": app.state.store.list("battle"),
            "engine": app.state.battles.engine.status(),
        }

    @app.post("/api/sync", status_code=202)
    def sync(body: JobInput):
        return app.state.service.start_job(body.kind)

    @app.get("/api/cards")
    def cards(
        as_of: AsOf,
        q: str = Query(default="", max_length=100),
        status: Literal["all", "legal", "waiting", "review", "illegal", "unreleased"] = "legal",
        category: str = "",
        page: int = Query(default=1, ge=1),
    ):
        service = app.state.service
        snapshot = service.latest()
        items = service.assessed(snapshot["id"], str(as_of))
        query = q.casefold()
        filtered = [
            card
            for card in items
            if (status == "all" or card["legality"]["status"] == status)
            and (not category or card["category"] == category)
            and query
            in f"{card['name']} {card['set_code']} {card['number']} {card['id']}".casefold()
        ]
        return {
            "items": filtered[(page - 1) * 40 : page * 40],
            "total": len(filtered),
            "page": page,
            "page_size": 40,
            "snapshot_id": snapshot["id"],
        }

    @app.get("/api/cards/{card_id}")
    def card(card_id: str, as_of: AsOf):
        service = app.state.service
        snapshot = service.latest()
        raw = service.card_map(snapshot).get(card_id)
        if raw is None:
            raise HTTPException(404, "Card not found")
        assessed = next(
            item for item in service.assessed(snapshot["id"], str(as_of)) if item["id"] == card_id
        )
        return {"card": raw, **assessed, "provenance": service.provenance(snapshot)}

    @app.post("/api/events/{event_id}/import", status_code=202)
    def import_event(event_id: str, body: EventInput):
        if not app.state.store.get("event", event_id):
            raise HTTPException(404, "Event not found")
        return app.state.service.start_job("import", event_id, body.top)

    @app.post("/api/decks", status_code=201)
    def add_deck(body: DeckInput):
        service = app.state.service
        return service.add_deck(body.name, body.text, service.latest(), body.as_of)

    @app.get("/api/decks/{deck_id}")
    def deck(deck_id: str, as_of: AsOf):
        result = app.state.store.get("deck", deck_id)
        if result is None:
            raise HTTPException(404, "Deck not found")
        service = app.state.service
        snapshot = service.snapshot(result["snapshot_id"])
        raw_map = service.card_map(snapshot)
        return {
            **result,
            "current_validation": validate_deck(result, snapshot, as_of, service.policy()),
            "card_details": [
                {**line, "card": raw_map[line["card_id"]]} for line in result["lines"]
            ],
            "battle_coverage": app.state.battles.engine.coverage(result, snapshot),
        }

    @app.post("/api/battles", status_code=202)
    def battle(body: BattleInput):
        return app.state.battles.start(
            body.name, body.deck_ids, body.as_of, body.seed, body.max_actions, body.max_turns
        )

    @app.get("/api/battles/{battle_id}")
    def get_battle(battle_id: str):
        result = app.state.store.get("battle", battle_id)
        if result is None:
            raise HTTPException(404, "Battle not found")
        return result

    @app.get("/api/battles/{battle_id}/replay")
    def replay(battle_id: str):
        result = get_battle(battle_id)
        if result["status"] in ("queued", "running", "interrupted"):
            raise HTTPException(409, "Replay has not been saved.")
        if not (app.state.store.directory / "battles" / f"{battle_id}.json.gz").exists():
            raise HTTPException(409, "No replay artifact available.")
        full = app.state.store.artifact("battles", battle_id)
        return full["result"]

    @app.get("/api/battles/{battle_id}/download")
    def download_battle(battle_id: str):
        result = get_battle(battle_id)
        if not (app.state.store.directory / "battles" / f"{battle_id}.json.gz").exists():
            raise HTTPException(409, "No completed research artifact available.")
        full = app.state.store.artifact("battles", battle_id)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("battle.json", json.dumps(full))
            archive.writestr("input.json", json.dumps(full["input"]))
            archive.writestr("engine-manifest.json", json.dumps(result["engine"]))
            policy = result["policy"]
            if not isinstance(policy, dict):
                policy = full["decks"][0]["policy"]
            archive.writestr("policy.json", json.dumps(policy))
            for i, deck in enumerate(full["decks"]):
                archive.writestr(f"deck-{i + 1}.txt", deck["text"])
                archive.writestr(
                    f"card-snapshot-{i + 1}.json",
                    json.dumps(app.state.service.snapshot(deck["snapshot_id"])),
                )
            archive.write(
                app.state.battles.engine.bundle(result["engine"]["bundle_sha256"]), "engine.cjs"
            )
            archive.write(ROOT / "engine/THIRD_PARTY_LICENSE.txt", "THIRD_PARTY_LICENSE.txt")
            archive.writestr(
                "README.txt",
                "Full omniscient replay, frozen sources and executable.\n"
                "Rerun offline: node engine.cjs < input.json\n"
                "Experimental community rules; no winner is inferred from incomplete games.\n",
            )
        return Response(
            buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="battle-{battle_id}.zip"'},
        )

    @app.post("/api/experiments", status_code=201)
    def experiment(body: ExperimentInput):
        store, service = app.state.store, app.state.service
        deck = store.get("deck", body.deck_id)
        if deck is None:
            raise HTTPException(404, "Deck not found")
        snapshot = service.snapshot(deck["snapshot_id"])
        policy = service.policy()
        validation = validate_deck(deck, snapshot, body.as_of, policy)
        if validation["status"] != "ready":
            raise HTTPException(
                422, {"message": "Deck is not ready under the dated policy.", **validation}
            )
        result = run_experiment(
            deck,
            service.card_map(snapshot),
            body.target_ids,
            body.trials,
            body.seed,
            body.minimum,
        )
        result.update(
            id=uuid.uuid4().hex,
            name=body.name,
            deck=deck,
            as_of=str(body.as_of),
            validation=validation,
            provenance=service.provenance(snapshot, policy),
            policy=policy,
        )
        store.artifact("experiments", result["id"], result)
        return store.put(
            "experiment", {key: value for key, value in result.items() if key != "samples"}
        )

    @app.get("/api/experiments/{experiment_id}")
    def get_experiment(experiment_id: str):
        result = app.state.store.get("experiment", experiment_id)
        if result is None:
            raise HTTPException(404, "Experiment not found")
        return result

    @app.get("/api/experiments/{experiment_id}/download")
    def download_experiment(experiment_id: str):
        result = get_experiment(experiment_id)
        store, service = app.state.store, app.state.service
        full = store.artifact("experiments", result["id"])
        snapshot = service.snapshot(result["provenance"]["snapshot_id"])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("experiment.json", json.dumps(full))
            archive.writestr("card-snapshot.json", json.dumps(snapshot))
            archive.writestr("policy.json", json.dumps(result["policy"]))
            archive.writestr("deck.txt", result["deck"]["text"])
            archive.writestr(
                "README.txt",
                "Complete recorded trials, source card catalog, policy, and deck.\n"
                "Opening-hand/prize sampling only; no gameplay or matchup inference.\n"
                "Card data retains upstream rights. Do not treat this as judge certification.\n",
            )
        return Response(
            buffer.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="experiment-{experiment_id}.zip"'
            },
        )

    @app.get("/api/snapshot/download")
    def download_snapshot():
        snapshot = app.state.service.latest()
        return Response(
            json.dumps(snapshot),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="cards-{snapshot["id"]}.json"'},
        )

    @app.get("/")
    def index():
        return FileResponse(ROOT / "web/index.html")

    app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")
    return app


app = create_app()
