# Pokémon TCG Tournament Lab

**Fieldnotes** is a local research workspace for current English-language, US/international
Standard cards and real in-person tournament decklists. It is a separate companion to
[Counterplay](https://github.com/hanshanley/tcg-simulator), not an expansion of CABT's
supported card effects.

The first working milestone provides dated legality assessments, exact-printing deck
validation, tournament imports, and seeded opening-hand/prize experiments. **It does not
simulate full games, card effects, or matchup win rates.** There is no Kaggle workflow.

## Run locally

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/hanshanley/pokemon-tcg-tournament.git
cd pokemon-tcg-tournament
uv sync --locked
uv run --locked python -m tournament sync
uv run --locked python -m tournament serve
```

Open **http://127.0.0.1:8002**. Counterplay can continue running independently on port 8000.
The browser interface is served directly: Node and a frontend build are not required.
`--port 8004` selects another port. `TOURNAMENT_DATA_DIR` overrides the default `data/`
directory, which contains SQLite metadata and compressed immutable artifacts.

In the interface:

1. Explore assessed-legal printings, or switch to waiting/review/all records.
2. Open **Tournament decks** and import an event's published top-eight lists, or paste a list.
3. Open a validated deck, select a target printing, and run a consistency experiment.
4. Download the **complete experiment**, not just its summary.

The initial source sync does not automatically import every tournament deck. Source operations
also run in the background through the interface and expose their progress and failures.
Run one server per data directory; stop it before using the standalone `sync` command.

## Card data and tournament evidence

The bulk English catalog comes from an immutable commit of
[PokemonTCG/pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data).
The app downloads the GitHub archive rather than relying on the retiring Pokémon TCG API
service. This upstream repository is a legacy provider: future freshness and completeness
are **not guaranteed**. Inspect the source commit time and latest included release before
interpreting a result.

The observed bulk snapshot lacks the `MEE` Basic Energy set used in current tournament
lists. The importer fills that specific gap from
[Limitless's exact MEE card pages](https://limitlesstcg.com/cards/MEE), verifying that each
record is Basic Energy. Supplemental cards retain their exact collector number, URL,
retrieval time, and source-page hash; the combined catalog has its own content hash.
If source parsing fails, the previous completed snapshot remains available.

Recent event listings and published lists come from
[Limitless TCG](https://limitlesstcg.com/tournaments). The import scope is completed,
in-person, international Standard events; Japanese-format and online events are not
mixed into this sample. Published top-N lists are **not all entrants or a metagame census**.
Lists retain their event date, placing, source URL, original parsed text, and source hash.
The source may normalize a list's printing; this is not proof of the physical printing
used by its player.

Each import is tied to a card snapshot. Reimporting against a newer snapshot creates
another deck version rather than rewriting the old record. Unresolved old imports remain
visible. Source HTML and card artwork are not committed; downloaded catalogs remain in
ignored local storage.

## Dated Standard policy

`tournament/policy.py` contains the explicit policy and evidence links. This milestone
reviews in-person Standard from **April 10 through November 14, 2026**, accepting marks
**H, I, J**. Dates outside that window produce `review`, not extrapolated eligibility.
TCG Live's separate rotation date and other regions/formats are not modeled.

The policy uses the
[official tournament handbook](https://mcdn.pokemon.com/pokemon-prod/raw/upload/v1/live/static-assets/content-assets/cms2/pdf/play-pokemon/rules/play-pokemon-tcg-tournament-handbook-en.pdf):

- New expansions normally become legal on the **second Friday following the US release**,
  not an unconditional release-plus-14-days calculation.
- Ascended Heroes uses the separately published March 6, 2026 legality exception.
- Older or waiting-period printings require an exact structured rules match to an already
  legal printing. A shared card name alone is insufficient.
- Promos without individual official release evidence or a proven legal reprint need review.
- The eight supported Standard Basic Energy types do not require a regulation mark.
  Fairy Energy is not automatically admitted.
- Explicit upstream Standard `Banned` flags are rejected. This is not an independently
  exhaustive official ban-list service or judge certification.

As of November 14, novel Delta Reign cards are still waiting until November 20; matching
already-legal reprints are handled separately. Advancing the date past the reviewed window
does not automatically authorize those cards.

Decks must resolve exactly by **set code + collector number + name**. The only name
representation exception is `Fire Energy` versus `Basic Fire Energy` and equivalent
supported Basic Energy types, still at the exact same printing. Missing or ambiguous
printings are never replaced with a name-only guess.

Validation checks 60 cards, at least one Basic Pokémon, the four-copy name limit,
Basic Energy exemptions, and ACE SPEC/Radiant limits. Unknown wording, errata, language
exceptions, physical-card requirements, and event-specific rulings still need review.
Only decks assessed `ready` for the selected date can run experiments.

To update the policy, verify the current official handbook, rotation announcement,
release/legality notices, promo schedule, and ban list. Update the policy version, reviewed
dates, accepted marks, and any evidenced exceptions; add regression tests before extending
the reviewed window. Fetching fresh card data alone does not update the policy.

## Experiment model and downloads

Each experiment uniformly shuffles the resolved 60-card deck, redraws seven until a Basic
Pokémon is present, samples six prizes from the remaining 53 cards, and records the next
natural draw. It measures:

- At least the chosen number of target copies in the **accepted** opening seven.
- Any target copy in prizes.
- The target threshold by the first natural draw.
- At least one mulligan, and the mean mulligan count.

Empirical rates include Wilson 95% intervals. The exact initial mulligan probability and
**unconditioned** target probability are labeled separately; the latter is not the same
quantity as the valid-opening-hand result.

There are no opponent mulligan bonus cards, setup effects, abilities, search, attacks, or
turn-by-turn gameplay. Prizing and availability do not imply that a card can be played,
that a combo succeeds, or that a deck wins.

Every ZIP includes:

| File | Contents |
| --- | --- |
| `experiment.json` | **Every accepted trial**, including hand, prizes, first draw, mulligan count, metrics, seed, protocol, Python version, algorithm hash, and provenance |
| `card-snapshot.json` | **All card and set records** from the frozen source snapshot, including supplements |
| `deck.txt` | Original imported deck text |
| `policy.json` | Frozen dated policy |
| `README.txt` | Scope and interpretation notes |

The source catalog is also independently downloadable in full. Seeds reproduce sampling
with the same algorithm, deck ordering, and Python version. Existing experiment artifacts
are not recomputed when sources change.

## Validation

```sh
uv run --locked ruff check tournament tests
uv run --locked ruff format --check tournament tests
uv run --locked pytest

npm ci
npx playwright install chromium
npm run check
npm run test:e2e
```

Unit/API tests use synthetic fixtures only. Browser tests start an isolated temporary-data
server on port 8003 and cover desktop/mobile navigation, exact imports, dated policy
behavior, experiment creation, persistence, and full downloads. They do not fetch network
sources or insert demonstration data into the normal workspace.

Real-source integration was separately checked with the October 31, 2026 Gdańsk Regional
top eight: all eight published lists resolved to 60 cards and passed the reviewed
November 14 policy. This is a sampled integration check, not a coverage guarantee.

Pokémon names, card text, and source data retain their respective owners' rights.
No official artwork is required or redistributed by this application.
