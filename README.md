# Pokémon TCG Tournament Lab

**Fieldnotes** is a local research workspace for current English-language, US/international
Standard cards and real in-person tournament decklists. It is a separate companion to
[Counterplay](https://github.com/hanshanley/tcg-simulator), not an expansion of CABT's
supported card effects.

The workspace provides dated legality assessments, exact-printing deck validation,
tournament imports, seeded opening-hand/prize experiments, and **executable experimental
battles** with complete omniscient replays. There is no Kaggle workflow.

## Automatic browser-only GitHub Pages build

The Pages build runs entirely in the browser: no Python service, localhost connection,
account, or API key is needed. Battles execute in an isolated Web Worker. Manual decks,
experiments, frozen catalogs, engine executables, and full traces are saved in IndexedDB
on the user's device, not uploaded to GitHub. Keep the tab open during a battle and export
complete ZIPs before clearing site storage. Other browsers/devices do not share this notebook.

`.github/workflows/pages.yml` automatically refreshes public cards and latest published
top-eight lists, verifies the pinned engine archive, builds both executables, runs Python,
engine, and browser tests, and uploads a complete static site on pushes, manual dispatches,
and daily at 06:17 UTC. Failed refreshes or tests never deploy over the previous good site.
The exporter excludes local manual decks, experiments, battle traces, and the SQLite database.
Fresh source data does **not** extend the reviewed legality policy; the browser defaults to
the last reviewed date when the current date is beyond that window.

**Deployment is intentionally gated.** GitHub rejected Pages enablement for this private
repository under the current account plan. Repository visibility has not been changed.
Once Pages is eligible and enabled with GitHub Actions as its source, set the repository
Actions variable `PAGES_ENABLED=true` and dispatch the workflow. Until then, verified builds
remain downloadable as `tournament-pages-preview` Actions artifacts; no live Pages URL is claimed.

To build or preview the same site locally:

```sh
npm ci
uv sync --locked
uv run --locked python -m tournament.pages --refresh
uv run --locked python -m tests.pages_server
```

Open `http://127.0.0.1:8005/pokemon-tcg-tournament/`.

## Executable battles

The isolated MIT-licensed Twinleaf/ryuu-play dependency is pinned by source commit and
archive SHA-256 in `engine/source.json`; attribution is in `engine/THIRD_PARTY_LICENSE.txt`.
Only source files are downloaded, not artwork, accounts, databases, or upstream web servers.
The bridge sets current first-player Supporter/attack restrictions and validates AI prompt
choices. Its tracked build patch fixes upstream lexicographic sorting of numeric shuffle
permutations; the original source pin plus bridge and bundle hashes identify this deviation.

Legality and execution coverage are separate. Exact set/number/name mapping, card category,
Pokémon type/stage/HP, attack costs and fixed printed damage, Trainer/Energy categories, attack
and ability lists, handler presence, and unfinished-source checks screen each deck. Dynamic
damage expressions are not reduced to guessed fixed values. No name-only
substitution or silent rules correction is used. Mapping is **not proof of rules accuracy**.
In the November 14 snapshot, two of eight Gdańsk lists pass this screening; the other six expose
their missing or mismatched implementations instead of becoming pretend games.

Open **Battles**, choose two ready decks, set a seed and limits, and resolve the match.
The engine executes actual effects, prompts, attacks, damage, weaknesses/resistances,
knockouts, prize-taking, turn transitions, and natural game endings. Replay every accepted
action and both boards, including hidden zones. The upstream SimpleTactics baseline is weak,
not a competitive opponent or a justified estimate of real-world metagame win rates.
Game randomness and policy planning use separate seeded, explicitly 32-bit-wrapped Mulberry32
streams (v2); actual game
shuffles use Fisher-Yates. Wall-clock log timestamps are omitted for deterministic replays.
Limits, worker failures, unsupported prompts, and interrupted tabs never imply a winner.
The upstream sudden-death implementation is explicitly blocked: the 2026 simultaneous-win
tiebreaker is **not yet supported**.

Battle ZIPs include every frame/action/log, the exact engine input, both deck texts, complete
frozen card catalogs, policy, source/build hashes, dependency license, and the actual standalone
`engine.cjs` used. Reproduce offline with Node 22+: `node engine.cjs < input.json`.
Browser and Node full-match traces are compared in the Pages integration test.

The November 14 audit repaired mutable historical replay conditions/markers, overwritten
legality policies in battle downloads, and long-run RNG precision loss. New setup experiments
use `browser-fisher-yates-mulberry32-v2`; older saved artifacts are not rewritten. Legacy battle
downloads recover the deck-frozen policy instead of substituting today's policy.
Duplicate starts are reserved before asynchronous preparation. Web Locks identify live tab
owners without inheriting a cloned tab's session identifier; browsers without Web Locks use
the heartbeat timeout fallback. Worker fetches and execution have bounded waits, failed coverage
can be retried without disabling setup research, and storage failures do not imply a winner.
Content-hashed frontend filenames prevent reuse of stale JavaScript/CSS at the same asset URL.
CI imports two fixed, attributed real Gdańsk reference lists into an isolated test notebook,
so changing the latest public event does not remove the full-match/offline-reproduction test.

## Run locally

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/). Executable battles also require Node 22+.

```sh
git clone https://github.com/hanshanley/pokemon-tcg-tournament.git
cd pokemon-tcg-tournament
uv sync --locked
npm ci
uv run --locked python -m tournament engine-sync
uv run --locked python -m tournament sync
uv run --locked python -m tournament serve
```

Open **http://127.0.0.1:8002**. Counterplay can continue running independently on port 8000.
The local browser interface is served directly; Node is required for executable battles.
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

In these setup-only experiments there are no opponent mulligan bonus cards, setup effects, abilities, search, attacks, or
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

The browser-only setup model uses its separately versioned Fisher-Yates/Mulberry32 algorithm,
not Python's sampler. A seed is reproducible within its recorded algorithm, not interchangeable
between the two setup implementations.

## Validation

```sh
uv run --locked ruff check tournament tests
uv run --locked ruff format --check tournament tests
uv run --locked pytest

npm ci
npx playwright install chromium
npm run check
npm run build:engine
npm run test:engine
npm run test:e2e
uv run --locked python -m tournament.pages
npm run test:pages
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
