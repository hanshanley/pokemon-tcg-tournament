import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from datetime import date, timedelta

HANDBOOK = (
    "https://mcdn.pokemon.com/pokemon-prod/raw/upload/v1/live/static-assets/"
    "content-assets/cms2/pdf/play-pokemon/rules/play-pokemon-tcg-tournament-handbook-en.pdf"
)
POLICY = {
    "id": "international-standard-2026-04-10",
    "version": 1,
    "format": "Standard",
    "region": "US/international",
    "language": "en",
    "effective_from": "2026-04-10",
    "reviewed_through": "2026-11-14",
    "legal_marks": ["H", "I", "J"],
    "basic_energy_types": [
        "Grass",
        "Fire",
        "Water",
        "Lightning",
        "Psychic",
        "Fighting",
        "Darkness",
        "Metal",
    ],
    "handbook": HANDBOOK,
    "handbook_sections": ["4.1.1", "4.1.2", "4.1.3"],
    "ban_evidence": "Dataset Banned flags are honored; not a judge certification.",
    "set_overrides": {
        "me2pt5": {
            "legal_from": "2026-03-06",
            "source": "https://community.pokemon.com/en-us/discussion/22216/"
            "pokemon-tcg-product-legality-update",
        }
    },
    "notes": [
        "Only reviewed regulation marks are accepted; future marks need a policy update.",
        "Promo release dates require per-card evidence or a proven currently legal reprint.",
        "Unresolved wording changes and errata require review; names alone never prove legality.",
        "Physical condition, language exceptions, event rules, and judge rulings are out of scope.",
    ],
}


def canonical(value):
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"\s+", " ", value.replace("\u2019", "'").replace("\u2018", "'")).strip()


def identity(card):
    fields = [
        "name",
        "supertype",
        "subtypes",
        "hp",
        "types",
        "evolvesFrom",
        "evolvesTo",
        "rules",
        "abilities",
        "attacks",
        "weaknesses",
        "resistances",
        "retreatCost",
    ]

    def normalize(value):
        if isinstance(value, str):
            return canonical(value)
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        return value

    return hashlib.sha256(
        json.dumps({key: normalize(card.get(key)) for key in fields}, sort_keys=True).encode()
    ).hexdigest()


def is_basic_energy(card):
    return card.get("supertype") == "Energy" and "Basic" in card.get("subtypes", [])


def basic_energy_kind(card):
    if not is_basic_energy(card):
        return None
    name = canonical(card["name"])
    match = re.fullmatch(r"(?:Basic )?(\w+) Energy", name, re.I)
    if not match:
        return None
    return next(
        (kind for kind in POLICY["basic_energy_types"] if kind.casefold() == match[1].casefold()),
        None,
    )


def second_friday(released):
    days = (4 - released.weekday()) % 7 or 7
    return released + timedelta(days=days + 7)


class Legality:
    def __init__(self, snapshot, as_of: date):
        self.as_of = as_of
        self.sets = {item["id"]: item for item in snapshot["sets"]}
        self.cards = {item["id"]: item for item in snapshot["cards"]}
        self.families = defaultdict(list)
        for card in snapshot["cards"]:
            self.families[identity(card)].append(card)

    def _result(self, status, reason, **extra):
        return {"status": status, "reason": reason, "as_of": self.as_of.isoformat(), **extra}

    def _direct(self, card):
        if (
            not date.fromisoformat(POLICY["effective_from"])
            <= self.as_of
            <= date.fromisoformat(POLICY["reviewed_through"])
        ):
            return self._result("review", "Date is outside the reviewed policy window.")
        if card.get("legalities", {}).get("standard") == "Banned":
            return self._result("illegal", "Source explicitly marks this printing banned.")
        if card.get("regulationMark") not in POLICY["legal_marks"]:
            return self._result("review", "Needs a functionally identical legal reprint.")
        expansion = self.sets.get(card.get("set_id"), {})
        released = expansion.get("releaseDate")
        if not released:
            return self._result("review", "No release date evidence.")
        released = date.fromisoformat(released.replace("/", "-"))
        if self.as_of < released:
            return self._result(
                "unreleased", "Printing has not been released.", released=str(released)
            )
        if "promo" in expansion.get("name", "").lower() or "Promo" in card.get("rarity", ""):
            return self._result("review", "Promo needs its individual official legality date.")
        override = POLICY["set_overrides"].get(expansion.get("id"))
        legal_from = (
            date.fromisoformat(override["legal_from"]) if override else second_friday(released)
        )
        if self.as_of < legal_from:
            return self._result(
                "waiting",
                "Tournament waiting period has not ended.",
                legal_from=str(legal_from),
                source=override["source"] if override else HANDBOOK,
            )
        return self._result(
            "legal",
            "Reviewed regulation mark and expansion waiting period satisfied.",
            legal_from=str(legal_from),
            source=override["source"] if override else HANDBOOK,
        )

    def check(self, card):
        direct = self._direct(card)
        if direct["status"] in ("legal", "illegal", "unreleased"):
            return direct
        if not POLICY["effective_from"] <= self.as_of.isoformat() <= POLICY["reviewed_through"]:
            return direct
        if basic_energy_kind(card):
            released = self.sets.get(card.get("set_id"), {}).get("releaseDate")
            if released and released.replace("/", "-") > self.as_of.isoformat():
                return direct
            return self._result(
                "legal",
                "Standard Basic Energy; no regulation mark required.",
                source=HANDBOOK,
            )
        for reprint in self.families[identity(card)]:
            if reprint["id"] != card["id"] and self._direct(reprint)["status"] == "legal":
                return self._result(
                    "legal",
                    "Exact structured rules match to a legal printing.",
                    reprint_id=reprint["id"],
                    source=HANDBOOK,
                )
        if card.get("regulationMark") and card["regulationMark"] < "H":
            return self._result("review", "Rotated mark; no exact legal reprint proven.")
        return direct
