import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import unicodedata
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import lru_cache
from pathlib import Path, PurePosixPath

from tournament.decks import validate_deck
from tournament.policy import basic_energy_kind, canonical
from tournament.sources import fetch
from tournament.store import now

ROOT = Path(__file__).resolve().parents[1]


def manifest():
    return json.loads((ROOT / "engine/source.json").read_text())


def prepare_engine(directory, progress=print):
    source = manifest()
    directory = Path(directory).resolve()
    target = directory / "engine" / "sources" / source["commit"]
    if not (target / ".verified.json").exists():
        progress("Downloading the pinned executable rules engine")
        raw = fetch(f"https://codeload.github.com/{source['repository']}/tar.gz/{source['commit']}")
        if hashlib.sha256(raw).hexdigest() != source["archive_sha256"]:
            raise ValueError("Engine archive checksum differs from the reviewed manifest.")
        stage = target.with_name(f"{source['commit']}.tmp-{uuid.uuid4().hex}")
        stage.mkdir(parents=True)
        try:
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
                for member in archive:
                    path = PurePosixPath(member.name)
                    if not member.isfile() or ".." in path.parts:
                        continue
                    relative = PurePosixPath(*path.parts[1:])
                    if str(relative).startswith(source["entry"] + "/") and relative.suffix in (
                        ".ts",
                        ".json",
                    ):
                        output = stage / str(relative)
                        output.parent.mkdir(parents=True, exist_ok=True)
                        output.write_bytes(archive.extractfile(member).read())
            (stage / ".verified.json").write_text(json.dumps(source))
            stage.rename(target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    if not shutil.which("node") or not shutil.which("npm"):
        raise ValueError("Install Node.js 22+ and run npm ci before preparing the battle engine.")
    progress("Bundling the isolated rules engine")
    result = subprocess.run(
        ["npm", "run", "build:engine"],
        cwd=ROOT,
        env={**os.environ, "TOURNAMENT_DATA_DIR": str(directory)},
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode:
        raise ValueError(result.stderr[-4000:] or result.stdout[-4000:])
    progress("Rules engine prepared; coverage is checked separately from card legality.")
    return json.loads((directory / "engine/build.json").read_text())


def normalized_name(value):
    return canonical(value).casefold()


def mechanical_errors(card, candidate):
    def key(value):
        value = unicodedata.normalize("NFKD", normalized_name(value))
        value = re.sub("[^a-z0-9]", "", value)
        return "darkness" if value == "dark" else value

    def values(items):
        return sorted(key(item) for item in (items or []))

    errors = []
    if key(card["supertype"]) != key(candidate.get("category")):
        errors.append("Source and executable card categories differ.")
    if card["supertype"] == "Pokémon":
        if values(card.get("types")) != values(candidate.get("types")):
            errors.append("Source and executable Pokémon types differ.")
        stage = next(
            (s for s in card.get("subtypes", []) if s in ("Basic", "Stage 1", "Stage 2")), None
        )
        if stage and key(stage) != key(candidate.get("stage")):
            errors.append("Source and executable evolution stages differ.")
        for attack, implemented in zip(card.get("attacks", []), candidate["attacks"], strict=False):
            if values(attack.get("cost")) != values(implemented.get("cost")):
                errors.append(f"Source and executable attack costs differ ({attack['name']}).")
            damage = str(attack.get("damage", ""))
            if damage.isascii() and damage.isdigit() and int(damage) != implemented["damage"]:
                errors.append(
                    f"Source and executable fixed attack damage differ ({attack['name']})."
                )
    categories = {
        "Trainer": (("Item", "Supporter", "Stadium", "Pokémon Tool"), "trainer_type"),
        "Energy": (("Basic", "Special"), "energy_type"),
    }
    if card["supertype"] in categories:
        names, field = categories[card["supertype"]]
        subtypes = card.get("subtypes", [])
        expected = (
            "Pokémon Tool"
            if "Pokémon Tool" in subtypes
            else next((s for s in subtypes if s in names), None)
        )
        if expected == "Pokémon Tool":
            expected = "tool"
        if expected and key(expected) != key(candidate.get(field)):
            errors.append(f"Source and executable {card['supertype']} categories differ.")
    return errors


class Engine:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.load_catalog = lru_cache(maxsize=2)(self._load_catalog)
        (self.directory / "engine/catalogs").mkdir(parents=True, exist_ok=True)

    def status(self):
        source = manifest()
        build_path = self.directory / "engine/build.json"
        if not build_path.exists() or not shutil.which("node"):
            return {
                "available": False,
                "message": "Run npm ci, then python -m tournament engine-sync.",
                **source,
            }
        build = json.loads(build_path.read_text())
        bridge = hashlib.sha256()
        for filename in source["bridge_files"]:
            bridge.update(f"{filename}\0".encode())
            bridge.update((ROOT / filename).read_bytes())
            bridge.update(b"\0")
        bridge_hash = bridge.hexdigest()
        bundle = self.bundle(build["bundle_sha256"])
        if (
            build.get("commit") != source["commit"]
            or build.get("bridge_sha256") != bridge_hash
            or not bundle.exists()
        ):
            return {
                "available": False,
                "message": "Engine out of date. Run python -m tournament engine-sync.",
                **source,
            }
        return {"available": True, **build}

    def bundle(self, fingerprint):
        if len(fingerprint) != 64 or any(c not in "0123456789abcdef" for c in fingerprint):
            raise ValueError("Invalid engine bundle fingerprint.")
        return self.directory / "engine/bundles" / f"{fingerprint}.cjs"

    def call(self, payload, build=None):
        build = build or self.status()
        if not build.get("available"):
            raise ValueError(build["message"])
        bundle = self.bundle(build["bundle_sha256"])
        if hashlib.sha256(bundle.read_bytes()).hexdigest() != build["bundle_sha256"]:
            raise ValueError("Executable engine bundle checksum mismatch.")
        try:
            result = subprocess.run(
                ["node", "--max-old-space-size=1024", str(bundle.resolve())],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=180,
                cwd=ROOT,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError(
                "Battle exceeded the 180-second worker limit; no result inferred."
            ) from error
        if result.returncode:
            raise ValueError(f"Rules worker failed: {result.stderr[-4000:]}")
        return json.loads(result.stdout)

    def _load_catalog(self, fingerprint):
        path = self.directory / "engine/catalogs" / f"{fingerprint}.json.gz"
        if path.exists():
            with gzip.open(path, "rt") as file:
                return json.load(file)
        cards = self.call({"mode": "catalog"})
        with gzip.open(path, "wt") as file:
            json.dump(cards, file)
        return cards

    def coverage(self, deck, snapshot):
        build = self.status()
        if not build["available"]:
            return {"ready": False, "engine": build, "cards": [], "message": build["message"]}
        index = defaultdict(list)
        try:
            catalog = self.load_catalog(build["bundle_sha256"])
        except (ValueError, OSError) as error:
            message = f"Executable coverage unavailable: {error}"
            return {
                "ready": False,
                "engine": {**build, "available": False, "message": message},
                "cards": [],
                "message": message,
            }
        for card in catalog:
            index[(card["set"].upper(), card["number"].lstrip("0") or "0")].append(card)
        sets = {entry["id"]: entry for entry in snapshot["sets"]}
        cards = {card["id"]: card for card in snapshot["cards"]}
        results = []
        for line in deck["lines"]:
            card = cards[line["card_id"]]
            expansion = sets[card["set_id"]]
            key = (
                expansion.get("ptcgoCode", card["set_id"]).upper(),
                card["number"].lstrip("0") or "0",
            )
            accepted_names = {normalized_name(card["name"])}
            if basic_energy_kind(card):
                accepted_names.add(normalized_name(f"{basic_energy_kind(card)} Energy"))
                accepted_names.add(normalized_name(f"Basic {basic_energy_kind(card)} Energy"))
            matches = [
                candidate
                for candidate in index[key]
                if normalized_name(candidate["name"]) in accepted_names
            ]
            errors = []
            candidate = matches[0] if len(matches) == 1 else None
            if candidate is None:
                errors.append(f"{len(matches)} exact engine printings; no name-only substitution.")
            else:
                errors.extend(candidate["blockers"])
                errors.extend(mechanical_errors(card, candidate))
                if card["supertype"] == "Pokémon":
                    if str(candidate["hp"]) != str(card.get("hp")):
                        errors.append("Source and executable HP differ.")
                    if [normalized_name(a["name"]) for a in card.get("attacks", [])] != [
                        normalized_name(a["name"]) for a in candidate["attacks"]
                    ]:
                        errors.append("Source and executable attack lists differ.")
                    if [normalized_name(a["name"]) for a in card.get("abilities", [])] != [
                        normalized_name(a["name"]) for a in candidate["abilities"]
                    ]:
                        errors.append("Source and executable ability lists differ.")
            results.append(
                {
                    **line,
                    "name": card["name"],
                    "set_code": key[0],
                    "number": key[1],
                    "status": "blocked" if errors else "mapped",
                    "errors": errors,
                    "engine_full_name": candidate["full_name"] if candidate else None,
                    "implementation_sources": candidate["sources"] if candidate else [],
                }
            )
        ready = (
            bool(results)
            and not deck.get("resolution_errors")
            and all(card["status"] == "mapped" for card in results)
        )
        return {
            "ready": ready,
            "engine": build,
            "cards": results,
            "message": "Experimental exact-printing coverage, not judge certification.",
        }


class Battles:
    def __init__(self, store, service):
        self.store, self.service = store, service
        self.engine = Engine(store.directory)
        (store.directory / "battles").mkdir(exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="battle-worker")
        self.lock = threading.Lock()
        for battle in store.list("battle"):
            if battle["status"] in ("queued", "running"):
                store.put(
                    "battle",
                    {
                        **battle,
                        "status": "interrupted",
                        "reason": "Server restarted before completion.",
                    },
                )

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.engine.load_catalog.cache_clear()

    def start(self, name, deck_ids, as_of: date, seed, max_actions, max_turns):
        decks, snapshots, coverage = [], [], []
        policy = self.service.policy()
        for deck_id in deck_ids:
            deck = self.store.get("deck", deck_id)
            if deck is None:
                raise ValueError("Battle deck not found.")
            snapshot = self.service.snapshot(deck["snapshot_id"])
            validation = validate_deck(deck, snapshot, as_of, policy)
            if validation["status"] != "ready":
                raise ValueError(
                    f"{deck['name']}: dated deck validation is {validation['status']}."
                )
            report = self.engine.coverage(deck, snapshot)
            if not report["ready"]:
                missing = [
                    f"{card['name']}: {'; '.join(card['errors'])}"
                    for card in report["cards"]
                    if card["status"] != "mapped"
                ]
                raise ValueError(
                    "Executable coverage incomplete: " + (" | ".join(missing) or report["message"])
                )
            decks.append(deck)
            snapshots.append(snapshot)
            coverage.append(report)
        build = coverage[0]["engine"]
        payload = {
            "mode": "battle",
            "seed": seed,
            "max_actions": max_actions,
            "max_turns": max_turns,
            "decks": [
                {
                    "name": f"Seat {index + 1} - {deck['name']}",
                    "cards": [
                        card["engine_full_name"]
                        for card in coverage[index]["cards"]
                        for _ in range(card["count"])
                    ],
                }
                for index, deck in enumerate(decks)
            ],
        }
        with self.lock:
            if (
                sum(
                    battle["status"] in ("queued", "running")
                    for battle in self.store.list("battle")
                )
                >= 8
            ):
                raise ValueError("Battle queue is full; wait for an existing match.")
            battle = self.store.put(
                "battle",
                {
                    "name": name,
                    "policy": policy,
                    "status": "queued",
                    "seed": seed,
                    "as_of": str(as_of),
                    "deck_ids": deck_ids,
                    "deck_names": [deck["name"] for deck in decks],
                    "engine": build,
                    "coverage": coverage,
                    "snapshot_ids": [snapshot["id"] for snapshot in snapshots],
                    "max_actions": max_actions,
                    "max_turns": max_turns,
                },
            )
            self.executor.submit(self._run, battle, payload, decks)
        return battle

    def _run(self, battle, payload, decks):
        battle.update(status="running", updated_at=now())
        self.store.put("battle", battle)
        try:
            result = self.engine.call(payload, battle["engine"])
            battle.update({key: value for key, value in result.items() if key != "frames"})
            self.store.artifact(
                "battles",
                battle["id"],
                {
                    "battle": battle,
                    "input": payload,
                    "decks": decks,
                    "result": result,
                },
            )
        except Exception as error:
            battle.update(status="failed", reason=str(error), winner=None, draw=False)
        battle["updated_at"] = now()
        self.store.put("battle", battle)
