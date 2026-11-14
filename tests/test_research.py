import copy
import io
import json
import math
import tarfile
import time
import zipfile
from collections import Counter
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.decks import resolve_deck, validate_deck
from tournament.experiments import run_experiment
from tournament.policy import Legality, second_friday
from tournament.sources import (
    fetch,
    fetch_energy_supplement,
    parse_deck_links,
    parse_deck_text,
    parse_tournaments,
    unpack_cards,
)
from tournament.store import Store

AS_OF = date(2026, 11, 14)


@pytest.fixture
def snapshot():
    return sample_snapshot()


@pytest.fixture
def client(tmp_path):
    Store(tmp_path).save_snapshot(sample_snapshot())
    with TestClient(create_app(tmp_path)) as instance:
        yield instance


def add_deck(client):
    response = client.post(
        "/api/decks", json={"name": "Research deck", "text": DECK_TEXT, "as_of": str(AS_OF)}
    )
    assert response.status_code == 201
    return response.json()


def test_second_friday_uses_calendar_not_fourteen_days():
    assert second_friday(date(2026, 11, 6)) == date(2026, 11, 20)
    assert second_friday(date(2026, 9, 16)) == date(2026, 9, 25)
    assert second_friday(date(2026, 11, 7)) == date(2026, 11, 20)


def test_release_waiting_period_and_ascended_override(snapshot):
    snapshot["sets"][0].update(id="me6", releaseDate="2026/11/06")
    snapshot["cards"][0]["set_id"] = "me6"
    result = Legality(snapshot, AS_OF).check(snapshot["cards"][0])
    assert result["status"] == "waiting"
    assert result["legal_from"] == "2026-11-20"
    snapshot["sets"][0].update(id="me2pt5", releaseDate="2026/01/30")
    snapshot["cards"][0]["set_id"] = "me2pt5"
    checker = Legality(snapshot, date(2026, 4, 10))
    result = checker.check(snapshot["cards"][0])
    assert result["status"] == "legal"
    assert result["legal_from"] == "2026-03-06"


def test_reprint_requires_matching_rules_not_just_name(snapshot):
    old = {**copy.deepcopy(snapshot["cards"][1]), "id": "old-2", "regulationMark": "G"}
    snapshot["cards"].append(old)
    checker = Legality(snapshot, AS_OF)
    assert checker.check(old)["status"] == "legal"
    assert checker.check(old)["reprint_id"] == "test-2"
    old["rules"] = ["Draw four cards."]
    assert Legality(snapshot, AS_OF).check(old)["status"] == "review"


def test_basic_energy_promos_bans_and_policy_window(snapshot):
    energy = snapshot["cards"][2]
    assert Legality(snapshot, AS_OF).check(energy)["status"] == "legal"
    fairy = {**energy, "name": "Fairy Energy", "id": "fairy"}
    assert Legality(snapshot, AS_OF).check(fairy)["status"] == "review"
    snapshot["sets"][0]["name"] = "Test Black Star Promos"
    assert Legality(snapshot, AS_OF).check(snapshot["cards"][0])["status"] == "review"
    assert Legality(snapshot, date(2027, 4, 15)).check(energy)["status"] == "review"
    banned = {**energy, "legalities": {"standard": "Banned"}}
    assert Legality(snapshot, AS_OF).check(banned)["status"] == "illegal"


def test_exact_printing_resolution_and_copy_limits(snapshot):
    resolved = resolve_deck(DECK_TEXT, snapshot)
    assert not resolved["resolution_errors"]
    assert validate_deck(resolved, snapshot, AS_OF)["status"] == "ready"
    wrong_set = resolve_deck(DECK_TEXT.replace("TST 1", "WRONG 1"), snapshot)
    assert wrong_set["resolution_errors"]
    assert wrong_set["total"] == 56
    duplicate = resolve_deck(DECK_TEXT.replace("4 Research Basic", "5 Research Basic"), snapshot)
    invalid = validate_deck(duplicate, snapshot, AS_OF)
    assert any("four-copy" in error for error in invalid["errors"])
    snapshot["cards"].append({**snapshot["cards"][0], "id": "duplicate-printing"})
    assert resolve_deck(DECK_TEXT, snapshot)["resolution_errors"]


def test_seeded_trials_are_reproducible_valid_setups_and_match_exact_probability(snapshot):
    deck = resolve_deck(DECK_TEXT, snapshot)
    mapping = {card["id"]: card for card in snapshot["cards"]}
    first = run_experiment(deck, mapping, ["test-2"], 10000, 42, 1)
    second = run_experiment(deck, mapping, ["test-2"], 10000, 42, 1)
    assert first["samples"] == second["samples"]
    assert first["metrics"] == second["metrics"]
    original = Counter({line["card_id"]: line["count"] for line in deck["lines"]})
    for trial in first["samples"]:
        assert len(trial["hand"]) == 7
        assert "test-1" in trial["hand"]
        assert len(trial["prizes"]) == 6
        used = Counter(trial["hand"] + trial["prizes"] + [trial["first_draw"]])
        assert all(count <= original[card_id] for card_id, count in used.items())
    exact_conditional = 1 - (
        (math.comb(56, 7) - math.comb(52, 7)) / (math.comb(60, 7) - math.comb(56, 7))
    )
    assert abs(first["metrics"]["opening_target"]["probability"] - exact_conditional) < 0.02
    exact_mulligan = math.comb(56, 7) / math.comb(60, 7)
    assert abs(first["metrics"]["any_mulligan"]["probability"] - exact_mulligan) < 0.02


def test_nonterminating_setup_and_invalid_targets_rejected(snapshot):
    mapping = {card["id"]: card for card in snapshot["cards"]}
    with pytest.raises(ValueError, match="No Basic"):
        run_experiment(
            {"lines": [{"card_id": "test-3", "count": 60}]}, mapping, ["test-3"], 100, 1, 1
        )
    with pytest.raises(ValueError, match="Targets"):
        run_experiment(resolve_deck(DECK_TEXT, snapshot), mapping, ["missing"], 100, 1, 1)


def test_api_experiment_download_has_every_trial_and_full_snapshot(client, tmp_path):
    deck = add_deck(client)
    response = client.post(
        "/api/experiments",
        json={
            "name": "Consistency test",
            "deck_id": deck["id"],
            "target_ids": ["test-2"],
            "trials": 100,
            "seed": 42,
            "as_of": str(AS_OF),
        },
    )
    assert response.status_code == 201, response.text
    experiment = response.json()
    assert experiment["trials"] == 100
    download = client.get(f"/api/experiments/{experiment['id']}/download")
    assert download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        trace = json.loads(archive.read("experiment.json"))
        cards = json.loads(archive.read("card-snapshot.json"))
        assert len(trace["samples"]) == 100
        assert len(cards["cards"]) == 3
        assert cards["sets"]
        assert archive.read("deck.txt").decode() == DECK_TEXT
        assert json.loads(archive.read("policy.json"))["legal_marks"] == ["H", "I", "J"]
    persisted = Store(tmp_path).artifact("experiments", experiment["id"])
    assert persisted["samples"] == trace["samples"]
    snapshot = client.get("/api/snapshot/download").json()
    assert len(snapshot["cards"]) == 3
    assert snapshot["content_sha256"]


def test_api_refuses_unvalidated_decks_and_reports_missing_records(client):
    deck = client.post(
        "/api/decks",
        json={"name": "Bad deck", "text": "60 Missing Card TST 99", "as_of": str(AS_OF)},
    ).json()
    response = client.post(
        "/api/experiments",
        json={
            "name": "Must fail",
            "deck_id": deck["id"],
            "target_ids": ["test-2"],
            "as_of": str(AS_OF),
        },
    )
    assert response.status_code == 422
    assert client.get("/api/decks/missing").status_code == 404
    assert client.get("/api/experiments/missing").status_code == 404
    assert client.get("/api/cards/missing").status_code == 404
    assert client.get(f"/api/cards?as_of={AS_OF}&status=legal").json()["total"] == 3


def test_source_failure_keeps_previous_snapshot(client, monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("Source unavailable")

    monkeypatch.setattr("tournament.service.sync_cards", broken)
    previous = client.get("/api/overview").json()["snapshot"]["id"]
    response = client.post("/api/sync", json={"kind": "cards"})
    assert response.status_code == 202
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        overview = client.get("/api/overview").json()
        if overview["jobs"][0]["status"] == "failed":
            break
        time.sleep(0.02)
    assert overview["jobs"][0]["status"] == "failed"
    assert overview["snapshot"]["id"] == previous


def test_parser_separates_japanese_formats_and_extracts_actual_deck_structure():
    html = """
    <table><tr><td>31 Oct 26</td><td><a href="/tournaments/584">Regional Test</a></td>
    <td><img alt="standard"></td></tr>
    <tr><td>20 Sep 26</td><td><a href="/tournaments/500">Japanese Test</a></td>
    <td><img alt="standard-jp"></td></tr></table>
    """
    assert [event["id"] for event in parse_tournaments(html)] == ["584"]
    standings = """
    <table><tr data-deck="Research"><td>1</td>
    <td><a href="/decks/list/123">List</a></td></tr></table>
    """
    assert parse_deck_links(standings)[0]["url"] == "https://limitlesstcg.com/decks/list/123"
    page = """
    <div class="decklist-card"><a href="/cards/TST/1">
    <span class="card-count">4</span><span class="card-name">Research Basic</span></a></div>
    """
    assert parse_deck_text(page) == "4 Research Basic TST 1"
    with pytest.raises(ValueError, match="No complete"):
        parse_deck_text("<html>Layout changed</html>")


def test_archive_import_reads_english_only_and_never_extracts_paths():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, data in [
            ("repo/sets/en.json", [{"id": "test"}]),
            ("repo/cards/en/test.json", [{"id": "test-1"}]),
            ("repo/cards/fr/test.json", [{"id": "french"}]),
            ("repo/../cards/en/evil.json", [{"id": "evil"}]),
        ]:
            encoded = json.dumps(data).encode()
            member = tarfile.TarInfo(path)
            member.size = len(encoded)
            archive.addfile(member, io.BytesIO(encoded))
    sets, cards = unpack_cards(buffer.getvalue())
    assert sets == [{"id": "test"}]
    assert cards == [{"id": "test-1", "set_id": "test"}]


def test_source_retries_transport_failures(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            raise httpx.ConnectError("Temporary connection failure")
        return httpx.Response(200, content=b"Recovered", request=httpx.Request("GET", url))

    monkeypatch.setattr("tournament.sources.httpx.get", get)
    monkeypatch.setattr("tournament.sources.time.sleep", lambda _: None)
    assert fetch("https://example.com/fixture") == b"Recovered"
    assert len(calls) == 2


def test_missing_energy_supplement_keeps_exact_printing_evidence(monkeypatch):
    def fake_fetch(url):
        if url.endswith("/MEE"):
            return (
                b'<div class="infobox-line">25th September 2025</div>'
                b'<a href="/cards/MEE/13">Psychic Energy</a>'
            )
        return (
            b'<p class="card-text-name">Psychic Energy</p>'
            b'<p class="card-text-type">Energy - Basic Energy</p>'
        )

    monkeypatch.setattr("tournament.sources.fetch", fake_fetch)
    expansion, cards, evidence = fetch_energy_supplement()
    assert expansion["ptcgoCode"] == "MEE"
    assert expansion["releaseDate"] == "2025-09-25"
    assert cards[0]["number"] == "13"
    assert cards[0]["source"] == "https://limitlesstcg.com/cards/MEE/13"
    assert cards[0]["source_sha256"]
    assert evidence["cards"] == 1


def test_partial_import_failures_are_reported_in_source_status(client, monkeypatch):
    service = client.app.state.service
    monkeypatch.setattr(
        service,
        "import_event",
        lambda *args: {
            "imported_deck_ids": ["one-deck"],
            "failures": [{"placing": 2, "error": "Source layout changed"}],
            "selected": 2,
        },
    )
    job = service.store.put("job", {"kind": "import", "event_id": "fixture", "top": 8})
    service._job(job)
    result = service.store.get("job", job["id"])
    assert result["status"] == "completed"
    assert "1 source failures" in result["message"]
    assert "#2: Source layout changed" in result["message"]


def test_copy_limit_combines_printings_and_ace_spec_limit_combines_names(snapshot):
    second_printing = {**snapshot["cards"][0], "id": "test-4", "number": "4"}
    snapshot["cards"].append(second_printing)
    deck = resolve_deck(
        "3 Research Basic TST 1\n2 Research Basic TST 4\n55 Fire Energy TST 3", snapshot
    )
    assert any("four-copy" in error for error in validate_deck(deck, snapshot, AS_OF)["errors"])
    snapshot["cards"].extend(
        [
            {
                **snapshot["cards"][1],
                "id": "test-5",
                "number": "5",
                "name": "Test Spec One",
                "subtypes": ["Item", "ACE SPEC"],
            },
            {
                **snapshot["cards"][1],
                "id": "test-6",
                "number": "6",
                "name": "Test Spec Two",
                "subtypes": ["Item", "ACE SPEC"],
            },
        ]
    )
    deck = resolve_deck(
        "4 Research Basic TST 1\n1 Test Spec One TST 5\n"
        "1 Test Spec Two TST 6\n54 Fire Energy TST 3",
        snapshot,
    )
    assert "More than one ACE SPEC card." in validate_deck(deck, snapshot, AS_OF)["errors"]


def test_current_catalog_prioritizes_newest_expansions_over_old_legal_energy(client):
    snapshot = sample_snapshot()
    snapshot["sets"].append(
        {"id": "recent", "name": "Recent Expansion", "releaseDate": "2026/10/09"}
    )
    snapshot["cards"].append(
        {**snapshot["cards"][0], "id": "recent-1", "set_id": "recent", "name": "Recent Basic"}
    )
    client.app.state.store.save_snapshot(snapshot)
    rows = client.get(f"/api/cards?as_of={AS_OF}").json()["items"]
    assert rows[0]["id"] == "recent-1"
    assert rows[-1]["set_id"] == "test"
