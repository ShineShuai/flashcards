"""Fails when test/fsrs-golden.json differs from what py-fsrs (pinned in
gen_golden.py's docstring) generates now.

    pip install fsrs==5.1.0 && python test/check_golden.py
"""
import contextlib
import io
import json
import pathlib
import sys

here = pathlib.Path(__file__).parent
sys.path.insert(0, str(here))
import gen_golden  # noqa: E402


def main() -> int:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        gen_golden.main()
    fresh = json.loads(buffer.getvalue())
    committed = json.loads((here / "fsrs-golden.json").read_text())
    if fresh != committed:
        keys = [k for k in fresh if fresh[k] != committed.get(k)]
        print("fsrs-golden.json is stale; differing sections:", keys)
        return 1
    print("fsrs-golden.json matches py-fsrs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
