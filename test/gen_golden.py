"""Golden vectors for test/fsrs-golden.mjs from the py-fsrs reference.

    python3 -m venv .venv && .venv/bin/pip install fsrs==5.1.0
    .venv/bin/python test/gen_golden.py > test/fsrs-golden.json
"""
import json
from itertools import product

from fsrs import Rating, Scheduler

D_GRID = [1.0, 2.5, 5.0, 7.1949, 9.0, 10.0]
S_GRID = [0.5, 3.0, 30.0, 300.0, 3000.0]
R_GRID = [0.5, 0.7, 0.85, 0.9, 0.99, 1.0]
RETENTIONS = [0.90, 0.94]
MAX_INTERVAL = 365


def main():
    ref = Scheduler(enable_fuzzing=False)
    out = {"parameters": list(ref.parameters), "max_interval": MAX_INTERVAL}
    out["init"] = [
        {"g": g, "s": ref._initial_stability(Rating(g)), "d": ref._initial_difficulty(Rating(g))}
        for g in (1, 2, 3, 4)
    ]
    out["next_d"] = [
        {"d": d, "g": g, "v": ref._next_difficulty(d, Rating(g))}
        for d, g in product(D_GRID, (1, 2, 3, 4))
    ]
    out["recall"] = [
        {"d": d, "s": s, "r": r, "g": g,
         "v": ref._next_recall_stability(d, s, r, Rating(g))}
        for d, s, r, g in product(D_GRID, S_GRID, R_GRID, (2, 3, 4))
    ]
    out["forget"] = [
        {"d": d, "s": s, "r": r, "v": ref._next_forget_stability(d, s, r)}
        for d, s, r in product(D_GRID, S_GRID, R_GRID)
    ]
    out["short"] = [
        {"s": s, "g": g, "v": ref._short_term_stability(s, Rating(g))}
        for s, g in product(S_GRID, (1, 2, 3, 4))
    ]
    out["interval"] = {}
    for retention in RETENTIONS:
        sched = Scheduler(
            desired_retention=retention, maximum_interval=MAX_INTERVAL, enable_fuzzing=False
        )
        out["interval"][str(retention)] = [
            {"s": s, "v": sched._next_interval(s)}
            for s in [0.5, 1.7, 3.2, 14.3, 42.0, 120.5, 399.0, 5000.0]
        ]
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
