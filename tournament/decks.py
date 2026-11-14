import re
from collections import Counter, defaultdict
from datetime import date

from tournament.policy import Legality, basic_energy_kind, canonical, is_basic_energy
from tournament.store import digest


def resolve_deck(text, snapshot):
    by_printing = defaultdict(list)
    sets = {item["id"]: item for item in snapshot["sets"]}
    cards = {card["id"]: card for card in snapshot["cards"]}
    for card in snapshot["cards"]:
        expansion = sets.get(card["set_id"], {})
        code = expansion.get("ptcgoCode", card["set_id"]).upper()
        number = card.get("number", "").lstrip("0") or "0"
        by_printing[(code, number)].append(card)
    lines, errors = [], []
    for line_number, raw in enumerate(text.splitlines(), 1):
        raw = raw.strip()
        if (
            not raw
            or raw.startswith(("#", "*"))
            or re.match(r"^(?:Pok.mon|Trainer|Energy|Total Cards)\s*(?:[:\-\d]|Cards)", raw, re.I)
        ):
            continue
        match = re.fullmatch(r"(\d+)\s+(.+)\s+(\S+)\s+(\S+)", raw)
        if not match:
            errors.append(f"Line {line_number}: expected 'quantity name SET number'.")
            continue
        count, name, code, number = match.groups()
        count = int(count)
        if not 1 <= count <= 60:
            errors.append(f"Line {line_number}: quantity must be 1..60.")
            continue
        candidates = [
            card
            for card in by_printing[(code.upper(), number.lstrip("0") or "0")]
            if (
                canonical(card["name"]).casefold() == canonical(name).casefold()
                or (
                    basic_energy_kind(card)
                    and canonical(name).casefold()
                    in (
                        f"{basic_energy_kind(card)} Energy".casefold(),
                        f"Basic {basic_energy_kind(card)} Energy".casefold(),
                    )
                )
            )
        ]
        if len(candidates) != 1:
            errors.append(
                f"Line {line_number}: cannot uniquely resolve '{name} {code} {number}' "
                f"({len(candidates)} exact matches). No name-only fallback was used."
            )
            continue
        lines.append({"card_id": candidates[0]["id"], "count": count})
    counts = Counter()
    for line in lines:
        counts[line["card_id"]] += line["count"]
    return {
        "lines": [{"card_id": card_id, "count": count} for card_id, count in counts.items()],
        "resolution_errors": errors,
        "sha256": digest(sorted(counts.items())),
        "total": sum(counts.values()),
        "cards": cards,
    }


def validate_deck(deck, snapshot, as_of: date):
    legality = Legality(snapshot, as_of)
    errors = list(deck.get("resolution_errors", []))
    warnings = []
    count_by_name = Counter()
    total, basics, ace_specs, radiants = 0, 0, 0, 0
    card_results = []
    for line in deck["lines"]:
        card = legality.cards.get(line["card_id"])
        if not card:
            errors.append(f"Unknown card ID {line['card_id']}")
            continue
        count = line["count"]
        total += count
        if not is_basic_energy(card):
            count_by_name[canonical(card["name"])] += count
        if card["supertype"] == "Pokémon" and "Basic" in card.get("subtypes", []):
            basics += count
        ace_specs += count if "ACE SPEC" in card.get("subtypes", []) else 0
        radiants += count if "Radiant" in card.get("subtypes", []) else 0
        result = legality.check(card)
        card_results.append({"card_id": card["id"], "count": count, **result})
        if result["status"] in ("illegal", "waiting", "unreleased"):
            errors.append(f"{card['name']} ({card['id']}): {result['reason']}")
        elif result["status"] == "review":
            warnings.append(f"{card['name']} ({card['id']}): {result['reason']}")
    if total != 60:
        errors.append(f"Expected 60 cards; resolved {total}.")
    if not basics:
        errors.append("At least one Basic Pokémon is required for these setup experiments.")
    for name, count in count_by_name.items():
        if count > 4:
            errors.append(f"{name}: {count} copies exceeds the four-copy limit.")
    if ace_specs > 1:
        errors.append("More than one ACE SPEC card.")
    if radiants > 1:
        errors.append("More than one Radiant Pokémon.")
    return {
        "status": "invalid" if errors else "review" if warnings else "ready",
        "as_of": str(as_of),
        "total": total,
        "basic_count": basics,
        "errors": errors,
        "warnings": warnings,
        "cards": card_results,
        "scope": "Card-data checks, not physical-card or judge certification.",
    }
