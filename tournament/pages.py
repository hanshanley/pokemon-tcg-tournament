"""Export public source material, never local notebooks, into a static Pages site."""

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
from datetime import date
from pathlib import Path

from tournament.battles import ROOT, Engine, prepare_engine
from tournament.policy import POLICY
from tournament.service import Service
from tournament.sources import sync_cards
from tournament.store import Store, digest, now


def export_site(directory, output, refresh=False):
    directory, output = Path(directory).resolve(), Path(output).resolve()
    if output == ROOT or ROOT.is_relative_to(output) or output == directory:
        raise ValueError("Output must be a dedicated site directory.")
    store = Store(directory)
    service = Service(store)
    try:
        if refresh:
            sync_cards(store, print)
            service.sync_events(print)
            events = sorted(store.list("event"), key=lambda event: event["date"], reverse=True)
            if not events:
                raise ValueError("No published Standard events available.")
            result = service.import_event(events[0]["id"], 8, print)
            if result["failures"]:
                raise ValueError(f"Incomplete latest tournament import: {result['failures']}")
            prepare_engine(directory)
        snapshot = service.latest()
        engine = Engine(directory)
        build = engine.status()
        if not build["available"]:
            raise ValueError(build["message"])
        as_of = min(date.today().isoformat(), POLICY["reviewed_through"])
        decks = [
            deck
            for deck in store.list("deck")
            if deck["source"]["type"] == "in-person-tournament"
            and deck["snapshot_id"] == snapshot["id"]
        ]
        if not decks:
            raise ValueError("No public tournament decks for the current snapshot.")
        for deck in decks:
            deck["battle_coverage"] = engine.coverage(deck, snapshot)
        output.mkdir(parents=True, exist_ok=True)
        static, data = output / "static", output / "data"
        static.mkdir(exist_ok=True)
        data.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "web/index.html", output / "index.html")
        shutil.copyfile(ROOT / "web/style.css", static / "style.css")
        (static / "config.js").write_text("globalThis.FIELDNOTES_STATIC = true;\n")
        (output / ".nojekyll").touch()
        subprocess.run(["node", "scripts/build-pages.js", str(output)], cwd=ROOT, check=True)
        license_text = (ROOT / "engine/THIRD_PARTY_LICENSE.txt").read_text()
        for package in ("@progress/pako-esm", "fflate"):
            license_file = ROOT / "node_modules" / package / "LICENSE"
            if license_file.exists():
                license_text += f"\n\n{package}\n" + license_file.read_text()
        (static / "THIRD_PARTY_LICENSE.txt").write_text(license_text)

        def asset(name, raw):
            fingerprint = hashlib.sha256(raw).hexdigest()
            filename = f"{name}-{fingerprint[:16]}.gz"
            (data / filename).write_bytes(gzip.compress(raw, mtime=0))
            return filename

        def encoded(value):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

        site = {
            "built_at": now(),
            "engine": build,
            "application_sha256": hashlib.sha256((static / "app.js").read_bytes()).hexdigest(),
            "catalog": asset("catalog", encoded(snapshot)),
            "records": asset(
                "records",
                encoded(
                    {
                        "as_of": as_of,
                        "policy": POLICY,
                        "policy_sha256": digest(POLICY),
                        "decks": decks,
                        "events": sorted(
                            store.list("event"), key=lambda event: event["date"], reverse=True
                        ),
                        "card_rows": service.assessed(snapshot["id"], as_of),
                    }
                ),
            ),
            "browser_worker": asset(
                "battle-worker.js", (directory / "engine/browser.js").read_bytes()
            ),
            "node_worker": asset("engine.cjs", engine.bundle(build["bundle_sha256"]).read_bytes()),
        }
        (data / "manifest.json").write_text(json.dumps(site, indent=2))
        print(
            f"Pages site: {output}; {len(decks)} public decks; "
            f"{sum(deck['battle_coverage']['ready'] for deck in decks)} executable lists."
        )
    finally:
        service.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir", type=Path, default=Path(os.environ.get("TOURNAMENT_DATA_DIR", ROOT / "data"))
    )
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh public sources and prepare the pinned engine automatically.",
    )
    args = parser.parse_args()
    export_site(args.data_dir, args.output, args.refresh)


if __name__ == "__main__":
    main()
