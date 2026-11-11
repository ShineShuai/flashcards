"""Run: python test/check_optimize.py   (needs: pip install fsrs==6.3.2; no torch)
tools/optimize.py with a stand-in optimizer: the log mapping, the hold-out cut, the JSON.
"""
import csv
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone

from fsrs import Rating
from fsrs.scheduler import DEFAULT_PARAMETERS

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "optimize", os.path.join(HERE, "..", "tools", "optimize.py"))
optimize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimize)

COLUMNS = ["review_time", "card_id", "rating", "state_before", "elapsed_days",
           "scheduled_days", "stability", "difficulty", "hints", "keywords", "duration_ms"]
START = datetime(2026, 1, 1, 8, tzinfo=timezone.utc)


def write_log(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(COLUMNS)
        writer.writerows(rows)


def synthetic(n):
    """n reviews over 7 cards, one a day, ratings cycling 1, 1.5, 2, 3, 4."""
    cycle = [3, 4, 2, 1.5, 3, 1, 3]
    return [
        [(START + timedelta(days=i)).strftime("%Y-%m-%dT%H:%M:%S.000Z"), f"card-{i % 7}",
         cycle[i % len(cycle)], 2, 1, 1, 5.0, 5.0, 0, 0, 800 if i % 2 else ""]
        for i in range(n)
    ]


class FakeOptimizer:
    seen = None

    def __init__(self, logs):
        FakeOptimizer.seen = list(logs)

    def compute_optimal_parameters(self):
        return list(DEFAULT_PARAMETERS)


def run(rows, **kwargs):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "review_log.csv")
        write_log(rows, path)
        return optimize.fit(path, optimizer=FakeOptimizer, version="6.3.2", **kwargs)


def test_mapping():
    out = run(synthetic(600), holdout=0)
    logs = FakeOptimizer.seen
    assert len(logs) == 600 and "train_until" not in out
    assert [log.card_id for log in logs[:8]] == [1, 2, 3, 4, 5, 6, 7, 1], "ints, first-seen order"
    assert all(isinstance(log.card_id, int) for log in logs)
    assert [log.rating for log in logs[:7]] == [
        Rating.Good, Rating.Easy, Rating.Hard, Rating.Hard, Rating.Good, Rating.Again, Rating.Good
    ], "Recap (1.5) is Hard"
    assert logs[0].review_datetime == START and logs[0].review_datetime.tzinfo is not None
    assert [log.review_duration for log in logs[:3]] == [None, 800, None]


def test_holdout():
    rows = synthetic(1000)
    out = run(rows, holdout=0.2)
    assert out["n_train"] == 800 and out["n_total"] == 1000
    assert len(FakeOptimizer.seen) == 800
    assert optimize.parse_time(out["train_until"]) == START + timedelta(days=799)
    assert max(log.review_datetime for log in FakeOptimizer.seen) == START + timedelta(days=799)
    assert run(rows, holdout=0.5)["n_train"] == 500


def test_output():
    out = run(synthetic(600), holdout=0)
    assert out["w"] == [round(x, 6) for x in DEFAULT_PARAMETERS] and len(out["w"]) == 21
    assert out["source"] == "fsrs 6.3.2 optimizer"
    json.dumps(out)


def test_order_and_bad_rows():
    rows = synthetic(600)
    messy = rows[::-1] + [["not a date", "x", 3, 2, 1, 1, 1, 1, 0, 0, 0],
                          [rows[0][0], "x", 5, 2, 1, 1, 1, 1, 0, 0, 0],
                          [rows[0][0], "x", "", 2, 1, 1, 1, 1, 0, 0, 0]]
    run(messy, holdout=0)
    assert [log.review_datetime for log in FakeOptimizer.seen] == sorted(
        log.review_datetime for log in FakeOptimizer.seen)
    assert len(FakeOptimizer.seen) == 600


def test_too_few():
    try:
        run(synthetic(300), holdout=0.2)
    except SystemExit as err:
        assert "only 240 reviews" in str(err)
    else:
        raise AssertionError("expected SystemExit")
    assert run(synthetic(300), holdout=0.2, force=True)["n_train"] == 240


def test_cli():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "review_log.csv")
        write_log(synthetic(1000), path)
        buf = io.StringIO()
        with redirect_stdout(buf):
            optimize.main([path, "--holdout", "0.2"], optimizer=FakeOptimizer, version="6.3.2")
        out = json.loads(buf.getvalue())
        assert out["n_train"] == 800 and out["train_until"].endswith("Z")
        target = os.path.join(tmp, "w.json")
        optimize.main([path, "--holdout", "0", "--out", target],
                      optimizer=FakeOptimizer, version="6.3.2")
        assert "train_until" not in json.load(open(target))
        try:
            optimize.main([path, "--holdout", "1.5"], optimizer=FakeOptimizer, version="6.3.2")
        except SystemExit as err:
            assert err.code == 2
        else:
            raise AssertionError("expected an argument error")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok  ", name)
    print("\nall passed")
