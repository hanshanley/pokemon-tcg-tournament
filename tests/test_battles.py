import gzip
import hashlib
import io
import json
import zipfile
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.battles import Engine, mechanical_errors
from tournament.pages import export_site
from tournament.policy import POLICY
from tournament.service import Service
from tournament.store import Store


def test_mechanical_coverage_matches_browser_cases():
    cases = json.loads(
        (Path(__file__).parents[1] / "tests-engine/mechanics-cases.json").read_text()
    )
    assert mechanical_errors(cases["card"], cases["implementation"]) == []
    for mismatch in cases["mismatches"]:
        errors = mechanical_errors(cases["card"], {**cases["implementation"], **mismatch["change"]})
        assert any(mismatch["error"] in error for error in errors)
    assert (
        mechanical_errors(
            {"supertype": "Trainer", "subtypes": ["Item", "Pokémon Tool"]},
            {"category": "TRAINER", "trainer_type": "TOOL"},
        )
        == []
    )


def test_legacy_battle_download_recovers_frozen_policy(tmp_path):
    store = Store(tmp_path)
    snapshot = store.save_snapshot(sample_snapshot())
    bundle = tmp_path / "engine/bundles" / f"{'a' * 64}.cjs"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("fixture executable")
    (tmp_path / "battles").mkdir()
    battle = store.put(
        "battle",
        {
            "status": "completed",
            "policy": "upstream-simple-tactics-v1",
            "engine": {"bundle_sha256": "a" * 64},
        },
    )
    store.artifact(
        "battles",
        battle["id"],
        {
            "battle": battle,
            "input": {"seed": 42},
            "result": {"status": "completed"},
            "decks": [{"policy": POLICY, "snapshot_id": snapshot["id"], "text": DECK_TEXT}],
        },
    )
    with TestClient(create_app(tmp_path)) as client:
        response = client.get(f"/api/battles/{battle['id']}/download")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert json.loads(archive.read("policy.json")) == POLICY
        assert archive.read("engine.cjs") == b"fixture executable"
        assert json.loads(archive.read("card-snapshot-1.json"))["cards"]


def test_failed_engine_catalog_does_not_break_deck_research(tmp_path, monkeypatch):
    store = Store(tmp_path)
    store.save_snapshot(sample_snapshot())
    service = Service(store)
    try:
        deck = service.add_deck("Exact list", DECK_TEXT, service.latest(), date(2026, 11, 14))
    finally:
        service.close()
    monkeypatch.setattr(
        Engine, "status", lambda self: {"available": True, "bundle_sha256": "broken"}
    )

    def broken_catalog(*args):
        raise ValueError("Malformed executable catalog")

    monkeypatch.setattr(Engine, "_load_catalog", broken_catalog)
    with TestClient(create_app(tmp_path)) as client:
        response = client.get(f"/api/decks/{deck['id']}?as_of=2026-11-14")
    assert response.status_code == 200
    report = response.json()
    assert report["battle_coverage"]["ready"] is False
    assert "Malformed executable catalog" in report["battle_coverage"]["message"]
    assert report["card_details"]


def test_missing_engine_rejects_battle_without_inventing_a_result(tmp_path):
    store = Store(tmp_path)
    store.save_snapshot(sample_snapshot())
    service = Service(store)
    try:
        deck = service.add_deck("Exact list", DECK_TEXT, service.latest(), date(2026, 11, 14))
    finally:
        service.close()
    with TestClient(create_app(tmp_path)) as client:
        report = client.get(f"/api/decks/{deck['id']}?as_of=2026-11-14").json()
        assert report["battle_coverage"]["ready"] is False
        response = client.post(
            "/api/battles",
            json={
                "name": "Unavailable engine",
                "deck_ids": [deck["id"], deck["id"]],
                "as_of": "2026-11-14",
            },
        )
        assert response.status_code == 422
        assert client.get("/api/overview").json()["battles"] == []


def test_static_export_only_includes_public_source_material(tmp_path, monkeypatch):
    directory, output = tmp_path / "input", tmp_path / "site"
    store = Store(directory)
    store.save_snapshot(sample_snapshot())
    service = Service(store)
    try:
        snapshot = service.latest()
        public = service.add_deck(
            "Published list",
            DECK_TEXT,
            snapshot,
            date(2026, 11, 14),
            source={"type": "in-person-tournament"},
        )
        service.add_deck("Private notebook fixture", DECK_TEXT, snapshot, date(2026, 11, 14))
        store.put("experiment", {"name": "Private experiment fixture"})
        store.put("battle", {"name": "Private battle fixture"})
    finally:
        service.close()
    engine = directory / "engine"
    (engine / "bundles").mkdir(parents=True)
    (engine / "browser.js").write_text("browser fixture")
    bundle = engine / "bundles/fixture.cjs"
    bundle.write_text("node fixture")
    monkeypatch.setattr(
        Engine, "status", lambda self: {"available": True, "bundle_sha256": "fixture"}
    )
    monkeypatch.setattr(Engine, "bundle", lambda self, fingerprint: bundle)
    monkeypatch.setattr(Engine, "coverage", lambda *args: {"ready": False})

    def build_frontend(*args, **kwargs):
        (output / "static/app.js").write_text("frontend fixture")

    monkeypatch.setattr("tournament.pages.subprocess.run", build_frontend)
    export_site(directory, output)
    manifest = json.loads((output / "data/manifest.json").read_text())
    frontend = next((output / "static").glob("app-*.js"))
    assert manifest["application_sha256"] == hashlib.sha256(frontend.read_bytes()).hexdigest()
    assert frontend.name in (output / "index.html").read_text()
    assert "./static/app.js" not in (output / "index.html").read_text()
    records_text = gzip.decompress((output / "data" / manifest["records"]).read_bytes()).decode()
    records = json.loads(records_text)
    assert [deck["id"] for deck in records["decks"]] == [public["id"]]
    assert "Private notebook fixture" not in records_text
    assert "Private experiment fixture" not in records_text
    assert "Private battle fixture" not in records_text
    assert not list(output.rglob("*.sqlite3"))
