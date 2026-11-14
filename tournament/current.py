"""Verify the live Standard table and independently check expansion coverage."""

import copy
import hashlib
import io
import re
from datetime import UTC, datetime, timedelta

from bs4 import BeautifulSoup
from pypdf import PdfReader

from tournament.policy import HANDBOOK, POLICY, second_friday

SET_INDEX = "https://limitlesstcg.com/cards"


def parse_standard_table(text, today):
    start = text.index("Legal Regulation Marks")
    end = text.index("Expanded Format", start)
    lines = text[start:end].splitlines()
    header = next(line for line in lines if "Standard" in line and "Expanded" in line)
    standard, expanded = header.index("Standard"), header.index("Expanded")
    marks, dates = [], []
    for line in lines:
        match = re.match(r"\s*(\w+ \d{1,2}, \d{4})\s+([A-Z])\s+", line)
        if not match:
            continue
        columns = line[standard:expanded].strip(), line[expanded:].strip()
        if columns[1] not in ("✔", "✓") or columns[0] not in ("", "✔", "✓"):
            raise ValueError("Unrecognized official Standard/Expanded table columns.")
        if columns[0]:
            introduced = datetime.strptime(match[1], "%B %d, %Y").date()
            if introduced > today:
                raise ValueError("Future Standard table requires dated rotation evidence.")
            marks.append(match[2])
            dates.append(introduced)
    if (
        not marks
        or len(marks) > 8
        or any(ord(right) != ord(left) + 1 for left, right in zip(marks, marks[1:], strict=False))
    ):
        raise ValueError("Official Standard regulation marks could not be verified.")
    return marks, min(dates)


def expansion_coverage(raw, snapshot, policy, earliest, today):
    sets = {item.get("ptcgoCode", "").upper(): item for item in snapshot["sets"]}
    counts = {}
    for card in snapshot["cards"]:
        counts[card["set_id"]] = counts.get(card["set_id"], 0) + 1
    checked, waiting = [], []
    for row in BeautifulSoup(raw, "html.parser").select("table tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        link = cells[0].find("a", href=re.compile(r"^/cards/[A-Z0-9]+$"))
        released = cells[1].get_text(" ", strip=True)
        if not link or not re.fullmatch(r"\d{2} [A-Z][a-z]{2} \d{2}", released):
            continue
        released = datetime.strptime(released, "%d %b %y").date()
        if released < earliest - timedelta(days=14):
            continue
        code = link["href"].rsplit("/", 1)[-1]
        expansion = sets.get(code)
        legal_from = second_friday(released)
        if expansion and expansion["id"] in policy["set_overrides"]:
            legal_from = datetime.fromisoformat(
                policy["set_overrides"][expansion["id"]]["legal_from"]
            ).date()
        present = bool(expansion and counts.get(expansion["id"]))
        item = {"code": code, "released": str(released), "legal_from": str(legal_from)}
        if legal_from <= today:
            if not present:
                raise ValueError(f"Card source is missing the currently legal expansion {code}.")
            source_date = expansion.get("releaseDate", "").replace("/", "-")
            if source_date != str(released):
                raise ValueError(f"Conflicting release dates for {code}; refusing stale legality.")
            checked.append(item)
        elif not present:
            waiting.append(item)
    if not checked:
        raise ValueError("Expansion index no longer exposes current released sets.")
    return {
        "source": SET_INDEX,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "checked_expansions": checked,
        "missing_upcoming": waiting,
        "scope": "Released expansion presence, not independent per-printing completeness.",
    }


def refresh_policy(fetch, snapshot, *, at=None, previous=None):
    at = at or datetime.now(UTC)
    raw = fetch(HANDBOOK)
    reader = PdfReader(io.BytesIO(raw))
    pages = [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
    text = next((page for page in pages if "Legal Regulation Marks" in page), "")
    marks, earliest = parse_standard_table(text, at.date())
    rules = re.sub(r"\s+", " ", " ".join(pages)).casefold()
    if "second friday" not in rules or "functionally identical" not in rules:
        raise ValueError("Official waiting-period/reprint rules changed; review is required.")
    policy = copy.deepcopy(POLICY)
    previous = previous or POLICY
    policy.update(
        id=f"international-standard-live-{''.join(marks).lower()}",
        version=2,
        legal_marks=marks,
        effective_from=previous["effective_from"]
        if marks == previous["legal_marks"]
        else str(at.date()),
        waiting_period_rule="second-friday-strictly-after-release",
    )
    coverage = expansion_coverage(fetch(SET_INDEX), snapshot, policy, earliest, at.date())
    expires = at + timedelta(hours=30)
    for expansion in coverage["missing_upcoming"]:
        expires = min(
            expires,
            datetime.fromisoformat(expansion["legal_from"]).replace(tzinfo=UTC),
        )
    policy["reviewed_through"] = str(expires.date())
    policy["verification"] = {
        "checked_at": at.isoformat(),
        "valid_until": expires.isoformat(),
        "handbook_sha256": hashlib.sha256(raw).hexdigest(),
        "method": "official-handbook-standard-columns-v1",
        "expansion_coverage": coverage,
    }
    policy["notes"][0] = (
        "Standard marks are refreshed from the official handbook; future formats are not guessed."
    )
    return policy
