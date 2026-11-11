#!/usr/bin/env python3
"""Fit FSRS-6 weights to the review log exported from the app (Weights > Download).

    python3 -m venv .venv && .venv/bin/pip install "fsrs[optimizer]==6.3.2"   # pulls torch
    .venv/bin/python tools/optimize.py review_log.csv --holdout 0.2 > weights.json

Paste weights.json into Weights > Check in the app. With --holdout the fit uses only
the older reviews and the JSON says where they end ("train_until"); the app then
checks the weights on the newer reviews, which the fit has not seen. Use --holdout 0
to fit on everything (the app's check is then optimistic, and says so).

Recap (1.5) counts as Hard for the fit, like the app's own replay counts it as recalled.
"""
import argparse
import csv
import json
import sys
from datetime import datetime, timezone

MIN_TRAIN_REVIEWS = 500
RATINGS = {"1": 1, "1.5": 2, "2": 2, "3": 3, "4": 4}   # Recap -> Hard


def parse_time(text):
    when = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def read_rows(path):
    """(time, card id text, rating 1-4, duration ms or None), oldest first; bad rows skipped."""
    rows = []
    with open(path, newline="", encoding="utf-8") as handle:
        for line in csv.DictReader(handle):
            try:
                rating = RATINGS[str(line["rating"]).strip()]
                when = parse_time(line["review_time"])
                card = line["card_id"]
            except (KeyError, ValueError, AttributeError):
                continue
            ms = (line.get("duration_ms") or "").strip()
            rows.append((when, card, rating, int(float(ms)) if ms else None))
    rows.sort(key=lambda r: r[0])
    return rows


def split(rows, holdout):
    """(training rows, train_until) - the oldest 1 - holdout of the rows; no cut when 0."""
    if not holdout:
        return rows, None
    cut = rows[max(0, int(len(rows) * (1 - holdout)) - 1)][0]
    return [r for r in rows if r[0] <= cut], cut


def to_review_logs(rows, review_log, rating):
    """py-fsrs ReviewLog objects; the optimizer wants integer card ids."""
    ids = {}
    return [
        review_log(
            card_id=ids.setdefault(card, len(ids) + 1),
            rating=rating(value),
            review_datetime=when,
            review_duration=ms,
        )
        for when, card, value, ms in rows
    ]


def fit(path, holdout=0.2, force=False, optimizer=None, version=None):
    from fsrs import Rating, ReviewLog

    rows = read_rows(path)
    train, until = split(rows, holdout)
    if len(train) < MIN_TRAIN_REVIEWS and not force:
        raise SystemExit(
            f"only {len(train)} reviews to fit (need {MIN_TRAIN_REVIEWS}); "
            "review more, or pass --force"
        )
    if optimizer is None:
        from fsrs import Optimizer as optimizer
    if version is None:
        from importlib.metadata import version as pkg_version

        version = pkg_version("fsrs")
    weights = optimizer(to_review_logs(train, ReviewLog, Rating)).compute_optimal_parameters()
    out = {
        "w": [round(float(x), 6) for x in weights],
        "n_train": len(train),
        "n_total": len(rows),
        "source": f"fsrs {version} optimizer",
    }
    if until is not None:
        out["train_until"] = until.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return out


def main(argv=None, **kwargs):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("log", help="review_log.csv from the app")
    parser.add_argument("--holdout", type=float, default=0.2,
                        help="share of the newest reviews kept out of the fit (default 0.2)")
    parser.add_argument("--out", help="write the JSON here instead of stdout")
    parser.add_argument("--force", action="store_true",
                        help=f"fit even with fewer than {MIN_TRAIN_REVIEWS} reviews")
    args = parser.parse_args(argv)
    if not 0 <= args.holdout < 1:
        parser.error("--holdout must be in [0, 1)")
    text = json.dumps(fit(args.log, args.holdout, args.force, **kwargs))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
