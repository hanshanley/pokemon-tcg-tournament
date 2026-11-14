import inspect
import math
import platform
import random
from collections import Counter

from tournament.store import digest, now


def wilson(successes, trials):
    z = 1.959963984540054
    probability = successes / trials
    divisor = 1 + z * z / trials
    middle = (probability + z * z / (2 * trials)) / divisor
    margin = (
        z
        * math.sqrt(probability * (1 - probability) / trials + z * z / (4 * trials * trials))
        / divisor
    )
    return [max(0, middle - margin), min(1, middle + margin)]


def sample_setup(cards, basic_ids, rng):
    mulligans = 0
    while True:
        shuffled = rng.sample(cards, len(cards))
        hand = shuffled[:7]
        if any(card in basic_ids for card in hand):
            return {
                "hand": hand,
                "prizes": shuffled[7:13],
                "first_draw": shuffled[13],
                "mulligans": mulligans,
            }
        mulligans += 1


def run_experiment(deck, card_map, target_ids, trials, seed, minimum):
    flat = [line["card_id"] for line in deck["lines"] for _ in range(line["count"])]
    if len(flat) != 60:
        raise ValueError("A setup experiment requires exactly 60 resolved cards.")
    basic_ids = {
        card_id
        for card_id in flat
        if card_map[card_id]["supertype"] == "Pokémon"
        and "Basic" in card_map[card_id].get("subtypes", [])
    }
    if not basic_ids:
        raise ValueError("No Basic Pokémon; legal setup would never terminate.")
    if not set(target_ids) or not set(target_ids) <= set(flat):
        raise ValueError("Targets must be resolved printings present in the deck.")
    if not 1 <= minimum <= 7 or not 1 <= trials <= 20000:
        raise ValueError("Invalid trial or target bounds.")
    rng = random.Random(seed)
    target_ids = set(target_ids)
    counters = Counter()
    samples = []
    for trial in range(trials):
        setup = sample_setup(flat, basic_ids, rng)
        hand_count = sum(card in target_ids for card in setup["hand"])
        prize_count = sum(card in target_ids for card in setup["prizes"])
        counters["opening_target"] += hand_count >= minimum
        counters["target_prized"] += prize_count > 0
        counters["target_by_first_draw"] += (
            hand_count + (setup["first_draw"] in target_ids) >= minimum
        )
        counters["any_mulligan"] += setup["mulligans"] > 0
        counters["mulligans"] += setup["mulligans"]
        samples.append({"trial": trial + 1, **setup})
    metrics = {}
    for key in ("opening_target", "target_prized", "target_by_first_draw", "any_mulligan"):
        successes = counters[key]
        metrics[key] = {
            "successes": successes,
            "trials": trials,
            "probability": successes / trials,
            "ci95": wilson(successes, trials),
        }
    basic_count = sum(card in basic_ids for card in flat)
    target_count = sum(card in target_ids for card in flat)
    return {
        "kind": "opening-hand-and-prizes",
        "algorithm_version": "1",
        "algorithm_sha256": digest(
            inspect.getsource(sample_setup) + inspect.getsource(run_experiment)
        ),
        "python_version": platform.python_version(),
        "created_at": now(),
        "trials": trials,
        "seed": seed,
        "minimum": minimum,
        "target_ids": sorted(target_ids),
        "metrics": metrics,
        "mean_mulligans": counters["mulligans"] / trials,
        "exact_initial_mulligan_probability": math.comb(60 - basic_count, 7) / math.comb(60, 7),
        "unconditional_opening_target_probability": sum(
            math.comb(target_count, n) * math.comb(60 - target_count, 7 - n)
            for n in range(minimum, min(target_count, 7) + 1)
            if 0 <= 7 - n <= 60 - target_count
        )
        / math.comb(60, 7),
        "assumptions": [
            "Uniform random 60-card shuffles; redraw seven until a Basic Pokemon is present.",
            "Target opening probability is conditional on a valid opening hand, before placement.",
            "Six prizes sampled from the remaining 53 cards; then one natural first-turn draw.",
            "No opponent mulligan bonus draws, setup abilities, card effects, search, or gameplay.",
            "Not a full-game simulator, matchup model, or battle win-rate estimator.",
        ],
        "samples": samples,
    }
