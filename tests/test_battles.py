import gzip
import json
from datetime import date

from fastapi.testclient import TestClient

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.battles import Engine
from tournament.pages import export_site
from tournament.service import Service
from tournament.store import Store


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
    records_text = gzip.decompress((output / "data" / manifest["records"]).read_bytes()).decode()
    records = json.loads(records_text)
    assert [deck["id"] for deck in records["decks"]] == [public["id"]]
    assert "Private notebook fixture" not in records_text
    assert "Private experiment fixture" not in records_text
    assert "Private battle fixture" not in records_text
    assert not list(output.rglob("*.sqlite3"))
