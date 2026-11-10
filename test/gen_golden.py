"""Golden vectors for test/fsrs-golden.mjs from the py-fsrs reference.

    python3 -m venv .venv && .venv/bin/pip install fsrs==6.3.2
    .venv/bin/python test/gen_golden.py > test/fsrs-golden.json
"""
import json
from datetime import datetime, timedelta, timezone
from itertools import product

from fsrs import Card, Rating, Scheduler
from fsrs.scheduler import (
    DEFAULT_PARAMETERS,
    LOWER_BOUNDS_PARAMETERS,
    UPPER_BOUNDS_PARAMETERS,
)

D_GRID = [1.0, 2.5, 5.0, 7.1949, 9.0, 10.0]
S_GRID = [0.5, 3.0, 30.0, 300.0, 3000.0]
R_GRID = [0.5, 0.7, 0.85, 0.9, 0.99, 1.0]
T_GRID = [0, 1, 5, 30, 365]
RETENTIONS = [0.90, 0.94]
# no x.5 stability: at retention 0.90 the interval equals S, and a tie rounds
# half to even in Python but half up in JS
INTERVAL_S = [0.5, 1.7, 3.2, 14.3, 42.0, 120.6, 399.0, 5000.0]
MAX_INTERVAL = 365

# FSRS-5 defaults of py-fsrs 5.1.0 plus the two FSRS-6 weights that reproduce them
V5_PLUS = [
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
    0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655,
    0.6621, 0.0, 0.5,
]
# Every weight moved (clamped to the bounds) so no index can hide behind a default
FACTORS = [1.3, 0.8, 1.15, 0.9, 1.1, 0.7, 1.2, 1.5, 0.85, 1.25, 0.95,
           1.1, 1.4, 0.75, 1.05, 0.6, 0.9, 1.2, 1.3, 3.0, 2.0]
ALT = [
    round(min(max(p * f, lo), hi), 6)
    for p, f, lo, hi in zip(
        DEFAULT_PARAMETERS, FACTORS, LOWER_BOUNDS_PARAMETERS, UPPER_BOUNDS_PARAMETERS
    )
]
SETS = {"default": list(DEFAULT_PARAMETERS), "v5_plus": V5_PLUS, "alt": ALT}

# Ratings of consecutive reviews, each on the due day, never Again. Easy first
# graduates at once (no steps); Good first goes through the app's 10 min / 1 h steps.
STEPS = (timedelta(minutes=10), timedelta(minutes=60))
TRAJECTORIES = [
    ([4, 3, 3, 3, 3, 3, 3, 3], ()),
    ([4, 2, 3, 4, 3, 2, 3, 3, 4, 3], ()),
    ([4, 4, 4, 4, 4, 4, 4], ()),
    ([4, 2, 2, 2, 2, 2, 2, 2], ()),
    ([3, 3, 3, 3, 3, 3, 3, 3, 3], STEPS),
    ([3, 3, 2, 3, 4, 3, 2, 3, 3], STEPS),
    ([3, 3, 4, 4, 3, 3, 3, 2, 3], STEPS),
]


def vectors(params):
    ref = Scheduler(parameters=params, enable_fuzzing=False)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def retrievability(s, t):
        card = Card()
        card.stability = s
        card.last_review = now - timedelta(days=t)
        return ref.get_card_retrievability(card, now)

    return {
        "parameters": list(ref.parameters),
        "init": [
            {"g": g, "s": ref._initial_stability(rating=Rating(g)),
             "d": ref._initial_difficulty(rating=Rating(g), clamp=True)}
            for g in (1, 2, 3, 4)
        ],
        "next_d": [
            {"d": d, "g": g, "v": ref._next_difficulty(difficulty=d, rating=Rating(g))}
            for d, g in product(D_GRID, (1, 2, 3, 4))
        ],
        "recall": [
            {"d": d, "s": s, "r": r, "g": g,
             "v": ref._next_recall_stability(
                 difficulty=d, stability=s, retrievability=r, rating=Rating(g))}
            for d, s, r, g in product(D_GRID, S_GRID, R_GRID, (2, 3, 4))
        ],
        "forget": [
            {"d": d, "s": s, "r": r,
             "v": ref._next_forget_stability(difficulty=d, stability=s, retrievability=r)}
            for d, s, r in product(D_GRID, S_GRID, R_GRID)
        ],
        "short": [
            {"s": s, "g": g,
             "v": ref._short_term_stability(stability=s, rating=Rating(g))}
            for s, g in product(S_GRID, (1, 2, 3, 4))
        ],
        "retrievability": [
            {"s": s, "t": t, "v": retrievability(s, t)}
            for s, t in product(S_GRID, T_GRID)
        ],
        "interval": {
            str(retention): [
                {"s": s,
                 "v": Scheduler(
                     parameters=params, desired_retention=retention,
                     maximum_interval=MAX_INTERVAL, enable_fuzzing=False,
                 )._next_interval(stability=s)}
                for s in INTERVAL_S
            ]
            for retention in RETENTIONS
        },
    }


def trajectory(ratings, steps, retention=0.94):
    """Intervals (days) of py-fsrs's own review_card, each review on the due day."""
    sched = Scheduler(
        desired_retention=retention, learning_steps=steps, relearning_steps=(),
        maximum_interval=MAX_INTERVAL, enable_fuzzing=False,
    )
    card = Card()
    when = datetime(2026, 1, 1, 10, tzinfo=timezone.utc)
    out = []
    for rating in ratings:
        card, _ = sched.review_card(card, Rating(rating), review_datetime=when)
        out.append((card.due - when).total_seconds() / 86400)
        when = card.due
    return {"ratings": ratings, "retention": retention, "intervals": out}


def main():
    out = {
        "max_interval": MAX_INTERVAL,
        "bounds": {"lo": list(LOWER_BOUNDS_PARAMETERS), "hi": list(UPPER_BOUNDS_PARAMETERS)},
        "sets": [{"name": name, **vectors(params)} for name, params in SETS.items()],
        "trajectories": [trajectory(r, steps) for r, steps in TRAJECTORIES],
    }
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
