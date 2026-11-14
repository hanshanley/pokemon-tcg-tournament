import hashlib
import io
import json
import re
import tarfile
import time
from datetime import datetime
from pathlib import PurePosixPath
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from tournament.store import now

REPOSITORY = "PokemonTCG/pokemon-tcg-data"
LIMITLESS = "https://limitlesstcg.com"
USER_AGENT = "PokemonTournamentResearch/0.1 (local research, source snapshots)"


def fetch(url, *, json_body=False):
    for attempt in range(4):
        try:
            response = httpx.get(
                url, timeout=60, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            )
        except httpx.TransportError:
            if attempt == 3:
                raise
            time.sleep(2**attempt)
            continue
        if response.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            retry = response.headers.get("retry-after", "")
            time.sleep(min(15, int(retry)) if retry.isdigit() else 2**attempt)
            continue
        response.raise_for_status()
        return response.json() if json_body else response.content
    raise RuntimeError("Source request failed")


def unpack_cards(archive):
    sets = None
    cards = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if not member.isfile() or ".." in path.parts:
                continue
            relative = "/".join(path.parts[1:])
            if relative == "sets/en.json":
                sets = json.load(tar.extractfile(member))
            elif re.fullmatch(r"cards/en/[^/]+\.json", relative):
                set_id = path.stem
                cards.extend(
                    {**card, "set_id": set_id} for card in json.load(tar.extractfile(member))
                )
    if not sets or not cards:
        raise ValueError("Source archive did not contain English sets and cards.")
    if len({card["id"] for card in cards}) != len(cards):
        raise ValueError("Source has duplicate card IDs.")
    return sets, cards


def sync_cards(store, progress=lambda message: None):
    progress("Resolving the card dataset commit")
    commit = fetch(f"https://api.github.com/repos/{REPOSITORY}/commits/master", json_body=True)
    sha = commit["sha"]
    progress(f"Downloading immutable card archive {sha[:10]}")
    url = f"https://codeload.github.com/{REPOSITORY}/tar.gz/{sha}"
    archive = fetch(url)
    sets, cards = unpack_cards(archive)
    supplements = []
    if not any(expansion.get("ptcgoCode") == "MEE" for expansion in sets):
        progress("Filling the missing MEE Basic Energy printings from exact source pages")
        expansion, energy_cards, evidence = fetch_energy_supplement()
        sets.append(expansion)
        cards.extend(energy_cards)
        supplements.append(evidence)
    progress(f"Indexing {len(cards):,} English printings")
    snapshot = {
        "source": f"https://github.com/{REPOSITORY}",
        "source_commit": sha,
        "source_updated_at": commit["commit"]["committer"]["date"],
        "archive_url": url,
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "fetched_at": now(),
        "provider_notice": "Compatibility snapshot of a legacy public dataset, not the retiring "
        "Pokemon TCG API. Future source updates are not guaranteed. Verify coverage and dates.",
        "card_count": len(cards),
        "set_count": len(sets),
        "latest_release": max(item.get("releaseDate", "") for item in sets).replace("/", "-"),
        "supplements": supplements,
        "sets": sets,
        "cards": cards,
    }
    return store.save_snapshot(snapshot)


def fetch_energy_supplement():
    url = f"{LIMITLESS}/cards/MEE"
    raw = fetch(url)
    soup = BeautifulSoup(raw, "html.parser")
    info = soup.select_one(".infobox-line")
    match = re.search(
        r"(\d+)(?:st|nd|rd|th)? (\w+) (\d{4})", info.get_text(" ", strip=True) if info else ""
    )
    if not match:
        raise ValueError("MEE source no longer exposes a parseable release date.")
    released = datetime.strptime(" ".join(match.groups()), "%d %B %Y").date()
    paths = sorted(
        {link["href"] for link in soup.find_all("a", href=re.compile(r"^/cards/MEE/\d+$"))}
    )
    if not paths or len(paths) > 40:
        raise ValueError("Unexpected MEE card index size.")
    cards = []
    for path in paths:
        page = fetch(urljoin(LIMITLESS, path))
        card_soup = BeautifulSoup(page, "html.parser")
        name, card_type = (
            card_soup.select_one(".card-text-name"),
            card_soup.select_one(".card-text-type"),
        )
        if (
            not name
            or not card_type
            or canonical_card_type(card_type.get_text(" ", strip=True)) != "energy-basicenergy"
        ):
            raise ValueError(
                f"Expected a Basic Energy at {path}; refusing an inferred replacement."
            )
        number = path.rsplit("/", 1)[-1]
        cards.append(
            {
                "id": f"limitless-MEE-{number}",
                "name": name.get_text(" ", strip=True),
                "supertype": "Energy",
                "subtypes": ["Basic"],
                "number": number,
                "set_id": "limitless-MEE",
                "source": urljoin(LIMITLESS, path),
                "source_sha256": hashlib.sha256(page).hexdigest(),
            }
        )
    return (
        {
            "id": "limitless-MEE",
            "name": "Mega Evolution Energy",
            "ptcgoCode": "MEE",
            "releaseDate": released.isoformat(),
            "source": url,
            "total": len(cards),
        },
        cards,
        {
            "source": url,
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "cards": len(cards),
            "fetched_at": now(),
        },
    )


def canonical_card_type(value):
    return re.sub(r"\s+", "", value).lower()


def parse_tournaments(html):
    soup = BeautifulSoup(html, "html.parser")
    tournaments = []
    for row in soup.select("table tr"):
        link = row.find("a", href=re.compile(r"^/tournaments/\d+$"))
        cells = row.find_all("td")
        if not link or len(cells) < 3:
            continue
        standard = any(
            image.get("alt", "").lower() == "standard"
            or image.get("src", "").endswith("/standard.png")
            for image in row.find_all("img")
        )
        if not standard:
            continue
        raw_date = cells[0].get_text(" ", strip=True)
        try:
            event_date = datetime.strptime(raw_date, "%d %b %y").date().isoformat()
        except ValueError:
            continue
        tournaments.append(
            {
                "id": link["href"].rsplit("/", 1)[-1],
                "name": link.get_text(" ", strip=True),
                "date": event_date,
                "url": urljoin(LIMITLESS, link["href"]),
                "format": "international-standard",
                "medium": "in-person",
            }
        )
    return tournaments


def parse_deck_links(html):
    soup = BeautifulSoup(html, "html.parser")
    result = []
    for row in soup.select("table tr"):
        link = row.find("a", href=re.compile(r"^/(?:decklist|decks/list)/\d+$"))
        if not link:
            continue
        cells = row.find_all("td")
        placing = cells[0].get_text(" ", strip=True) if cells else ""
        result.append(
            {
                "url": urljoin(LIMITLESS, link["href"]),
                "placing": placing,
                "archetype": row.get("data-deck", "Unclassified"),
            }
        )
    return result


def parse_deck_text(html):
    soup = BeautifulSoup(html, "html.parser")
    textarea = soup.find("textarea")
    if textarea:
        text = textarea.get_text("\n", strip=True)
        if re.search(r"^\d+ .+ \S+ \S+$", text, re.MULTILINE):
            return text
    lines = []
    for element in soup.select(".decklist-card"):
        count = element.select_one(".card-count")
        name = element.select_one(".card-name")
        link = element.find("a", href=re.compile(r"/cards/"))
        if not count or not name or not link:
            continue
        match = re.search(r"/cards/(?:en/)?([^/]+)/([^/?#]+)", link["href"])
        if match:
            lines.append(
                f"{count.get_text(strip=True)} {name.get_text(strip=True)} "
                f"{match.group(1)} {match.group(2)}"
            )
    if not lines:
        raise ValueError("No complete decklist found; source HTML may have changed.")
    return "\n".join(lines)
