import copy
import hashlib
import io
import json
import zipfile
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from tests.sample_data import DECK_TEXT, sample_snapshot
from tournament.app import create_app
from tournament.current import SET_INDEX, expansion_coverage, parse_standard_table, refresh_policy
from tournament.policy import HANDBOOK, POLICY, Legality, policy_window, source_status
from tournament.service import Service
from tournament.sources import sync_cards
from tournament.store import Store, digest

AT = datetime(2026, 11, 14, 12, tzinfo=UTC)


def table(marks="GHIJ"):
    dates = {
        "G": "April 14, 2023",
        "H": "April 5, 2024",
        "I": "April 11, 2025",
        "J": "March 6, 2026",
        "K": "March 5, 2027",
    }
    return "\n".join(
        [
            "Legal Regulation Marks",
            f"{'Legality Date':25}{'Regulation Mark':20}{'Standard':20}Expanded",
            *(f"{dates[mark]:25}{mark:20}{'✔' if mark != 'G' else '':20}✔" for mark in marks),
            "Expanded Format Regulation Marks",
            "Second Friday following release; functionally identical reprints.",
        ]
    )


def index(code="TST", released="22 Mar 24"):
    return (
        f'<table><tr><td><a href="/cards/{code}">{code}</a></td><td>{released}</td></tr></table>'
    ).encode()


def live_policy(at=AT):
    policy = copy.deepcopy(POLICY)
    policy["reviewed_through"] = str((at + timedelta(hours=30)).date())
    policy["verification"] = {
        "checked_at": at.isoformat(),
        "valid_until": (at + timedelta(hours=30)).isoformat(),
    }
    return policy


def mock_handbook(monkeypatch, text=None):
    page = SimpleNamespace(extract_text=lambda **kwargs: text or table())
    monkeypatch.setattr("tournament.current.PdfReader", lambda raw: SimpleNamespace(pages=[page]))
    return lambda url: b"official PDF fixture" if url == HANDBOOK else index()


def test_official_table_distinguishes_standard_from_expanded_and_updates_marks():
    marks, earliest = parse_standard_table(table(), AT.date())
    assert marks == ["H", "I", "J"]
    assert str(earliest) == "2024-04-05"
    marks, _ = parse_standard_table(table("IJK"), AT.date().replace(year=2027))
    assert marks == ["I", "J", "K"]
    with pytest.raises(ValueError, match="Future"):
        parse_standard_table(table("IJK"), AT.date())


@pytest.mark.parametrize(
    "text",
    [table().replace("✔", "x"), table("HJ"), table("G"), "<html>Layout changed</html>"],
)
def test_unrecognized_tables_fail_closed(text):
    with pytest.raises(ValueError):
        parse_standard_table(text, AT.date())


def test_refresh_records_source_hashes_and_lifts_the_old_cutoff(monkeypatch):
    fetch = mock_handbook(monkeypatch)
    snapshot = sample_snapshot()
    snapshot["policy"] = refresh_policy(fetch, snapshot, at=AT)
    policy = snapshot["policy"]
    assert policy["legal_marks"] == ["H", "I", "J"]
    assert (
        policy["verification"]["handbook_sha256"]
        == hashlib.sha256(b"official PDF fixture").hexdigest()
    )
    assert policy["verification"]["expansion_coverage"]["source"] == SET_INDEX
    snapshot["sets"][0]["releaseDate"] = "2026/11/06"
    assert Legality(snapshot, AT.date(), at=AT).check(snapshot["cards"][0])["status"] == "waiting"
    policy = refresh_policy(fetch, sample_snapshot(), at=AT.replace(day=20))
    snapshot["policy"] = policy
    assert (
        Legality(snapshot, AT.date().replace(day=20), at=AT.replace(day=20)).check(
            snapshot["cards"][0]
        )["status"]
        == "legal"
    )
    assert not policy_window(policy, AT.date().replace(day=21), AT.replace(day=20))


def test_refresh_preserves_the_observed_format_start(monkeypatch):
    fetch = mock_handbook(monkeypatch)
    previous = {**POLICY, "effective_from": "2026-10-01"}
    policy = refresh_policy(fetch, sample_snapshot(), at=AT, previous=previous)
    assert policy["effective_from"] == previous["effective_from"]


def test_changed_official_marks_rotate_current_validation_automatically(monkeypatch):
    fetch = mock_handbook(monkeypatch, table("IJK"))
    snapshot = sample_snapshot()
    snapshot["sets"][0]["releaseDate"] = "2026/09/18"
    snapshot["cards"][1]["regulationMark"] = "I"
    at = AT.replace(year=2027, month=4, day=10)

    def fetch_current(url):
        return fetch(url) if url == HANDBOOK else index(released="18 Sep 26")

    policy = refresh_policy(fetch_current, snapshot, at=at)
    assert policy["legal_marks"] == ["I", "J", "K"]
    assert policy["effective_from"] == "2027-04-10"
    assert (
        Legality(snapshot, at.date(), policy, at=at).check(snapshot["cards"][0])["status"]
        == "review"
    )
    assert (
        Legality(snapshot, at.date(), policy, at=at).check(snapshot["cards"][1])["status"]
        == "legal"
    )
    refreshed = refresh_policy(fetch_current, snapshot, at=at + timedelta(days=1), previous=policy)
    assert refreshed["effective_from"] == policy["effective_from"]


def test_changed_waiting_or_reprint_rules_require_review(monkeypatch):
    fetch = mock_handbook(monkeypatch, table().replace("Second Friday", "Third Friday"))
    with pytest.raises(ValueError, match="rules changed"):
        refresh_policy(fetch, sample_snapshot(), at=AT)


def test_missing_legal_expansions_or_conflicting_release_dates_stop_refresh():
    snapshot = sample_snapshot()
    earliest = AT.date().replace(year=2024, month=4, day=5)
    with pytest.raises(ValueError, match="missing.*NEW"):
        expansion_coverage(index("NEW"), snapshot, POLICY, earliest, AT.date())
    with pytest.raises(ValueError, match="Conflicting"):
        expansion_coverage(index(released="23 Mar 24"), snapshot, POLICY, earliest, AT.date())
    with pytest.raises(ValueError, match="no longer"):
        expansion_coverage(b"<html>layout changed</html>", snapshot, POLICY, earliest, AT.date())


def test_known_missing_upcoming_set_shortens_the_verification_lease(monkeypatch):
    fetch = mock_handbook(monkeypatch)
    raw = index() + index("NEW", "06 Nov 26")
    policy = refresh_policy(
        lambda url: fetch(url) if url == HANDBOOK else raw,
        sample_snapshot(),
        at=AT.replace(day=19, hour=20),
    )
    assert policy["verification"]["valid_until"] == "2026-11-20T00:00:00+00:00"
    assert policy["verification"]["expansion_coverage"]["missing_upcoming"][0]["code"] == "NEW"


def test_expiration_blocks_energy_and_reprints_but_keeps_verified_history():
    snapshot = sample_snapshot()
    policy = live_policy()
    later = AT + timedelta(days=2)
    assert source_status(policy, AT)["status"] == "fresh"
    assert source_status(policy, later)["status"] == "stale"
    snapshot["policy"] = policy
    assert all(
        Legality(snapshot, later.date(), at=later).check(card)["status"] == "review"
        for card in snapshot["cards"]
    )
    assert all(
        Legality(snapshot, AT.date(), at=later).check(card)["status"] == "legal"
        for card in snapshot["cards"]
    )


def test_cached_assessments_expire_without_a_server_restart(tmp_path, monkeypatch):
    clock = [AT]

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0]

    monkeypatch.setattr("tournament.policy.datetime", Clock)
    snapshot = sample_snapshot()
    snapshot["policy"] = live_policy()
    snapshot["policy"]["verification"]["valid_until"] = (AT + timedelta(hours=1)).isoformat()
    store = Store(tmp_path)
    saved = store.save_snapshot(snapshot)
    service = Service(store)
    try:
        assert service.assessed(saved["id"], str(AT.date()))[0]["legality"]["status"] == "legal"
        clock[0] += timedelta(hours=2)
        assert service.assessed(saved["id"], str(AT.date()))[0]["legality"]["status"] == "review"
    finally:
        service.close()


def test_current_validation_uses_latest_policy_without_rewriting_downloads(tmp_path):
    store = Store(tmp_path)
    snapshot = sample_snapshot()
    store.save_snapshot(snapshot)
    with TestClient(create_app(tmp_path)) as client:
        deck = client.post(
            "/api/decks", json={"name": "Frozen list", "text": DECK_TEXT, "as_of": str(AT.date())}
        ).json()
        experiment = client.post(
            "/api/experiments",
            json={
                "name": "Frozen run",
                "deck_id": deck["id"],
                "target_ids": ["test-2"],
                "trials": 100,
                "as_of": str(AT.date()),
            },
        ).json()
        changed = sample_snapshot()
        changed["policy"] = {**POLICY, "legal_marks": ["I", "J", "K"]}
        store.save_snapshot(changed)
        detail = client.get(f"/api/decks/{deck['id']}?as_of={AT.date()}").json()
        assert detail["current_validation"]["status"] != "ready"
        assert detail["policy"] == POLICY
        assert client.get("/api/overview").json()["policy"]["legal_marks"] == ["I", "J", "K"]
        download = client.get(f"/api/experiments/{experiment['id']}/download")
        with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
            assert json.loads(archive.read("policy.json")) == POLICY
            assert json.loads(archive.read("experiment.json"))["provenance"][
                "policy_sha256"
            ] == digest(POLICY)


def test_failed_policy_verification_never_replaces_the_good_snapshot(tmp_path, monkeypatch):
    store = Store(tmp_path)
    previous = store.save_snapshot(sample_snapshot())
    monkeypatch.setattr(
        "tournament.sources.fetch",
        lambda url, **kwargs: (
            {"sha": "a", "commit": {"committer": {"date": AT.isoformat()}}}
            if kwargs.get("json_body")
            else b"archive"
        ),
    )
    monkeypatch.setattr(
        "tournament.sources.unpack_cards",
        lambda raw: (
            [{**sample_snapshot()["sets"][0], "ptcgoCode": "MEE"}],
            sample_snapshot()["cards"],
        ),
    )

    def broken(*args, **kwargs):
        raise ValueError("Official source unavailable")

    monkeypatch.setattr("tournament.sources.refresh_policy", broken)
    with pytest.raises(ValueError, match="Official source"):
        sync_cards(store)
    assert [item["id"] for item in store.list("snapshot")] == [previous["id"]]
