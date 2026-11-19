// Run: node test/fsrs-golden.mjs   (no dependencies; any TZ via TZ=... env)
// Checks the FSRS and replay blocks of index.html (@fsrs-begin/@fsrs-end,
// @replay-begin/@replay-end) against
// py-fsrs 6.3.2 vectors (three weight sets, py-fsrs's own review_card
// trajectories) and pins the app-specific behaviour (Recap, rollover, max interval).
process.env.TZ ||= 'Europe/Berlin';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fsrs-golden.json'), 'utf8'));

function load(patch = (s) => s, guard = true) {
  const block = html.match(/\/\/ @fsrs-begin([\s\S]*?)\/\/ @fsrs-end/)[1];
  const replay = html.match(/\/\/ @replay-begin([\s\S]*?)\/\/ @replay-end/)[1];
  const clock = { t: Date.now() };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(clock.t);
      }
    }
    static now() {
      return clock.t;
    }
  }
  const ctx = vm.createContext({ Date: FakeDate, Math });
  const names = 'W initS initD nextD sRecall sForget sShort intervalDays dueDate ' +
    'daysBetween scheduleCard nextInterval forgettingCurve curveFactor LEARNING_STEPS ' +
    'MAX_INTERVAL parseReviewLog holdoutCut replayLoss isScored recallRecord parseTrail ' +
    'TRAIL_LEN stabilityFor horizonPull recallStatus RECALL_ORDER aheadRatio AHEAD_FRACTION';
  const api = vm.runInContext(
    `${patch(block)}\n${replay}\nHORIZON_GUARD = ${guard};\n` +
    `({${names.split(' ').join(',')}})`, ctx);
  const at = (...args) => {
    clock.t = new FakeDate(...args).getTime();
  };
  const setGuard = (on) => vm.runInContext(`HORIZON_GUARD = ${on}`, ctx);
  return { api, at, FakeDate, setGuard };
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
}
const close = (a, b, msg) => {
  const tol = 1e-9 * Math.max(1, Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b}`);
};

const { api, at, FakeDate, setGuard } = load();

// ── py-fsrs parity ──────────────────────────────────────────────────────────
test('weights equal py-fsrs 6.3.2 defaults', () => {
  assert.equal(golden.sets[0].name, 'default');
  assert.deepEqual([...api.W], golden.sets[0].parameters);
  assert.equal(api.W.length, 21);
});

for (const set of golden.sets) {
  // a fresh app per weight set; weights are replaced in place
  const withWeights = (patch) => {
    const loaded = load(patch, false);               // py-fsrs has no horizon guard
    loaded.api.W.splice(0, loaded.api.W.length, ...set.parameters);
    return loaded.api;
  };
  const a = withWeights();
  test(`[${set.name}] initial stability / difficulty`, () => {
    for (const { g, s, d } of set.init) {
      close(a.initS(g), s, `initS(${g})`);
      close(a.initD(g), d, `initD(${g})`);
    }
  });
  test(`[${set.name}] next difficulty (linear damping, revert to D0(4))`, () => {
    for (const { d, g, v } of set.next_d) {
      close(a.nextD(d, g), v, `nextD(${d},${g})`);
    }
  });
  test(`[${set.name}] recall stability`, () => {
    for (const { d, s, r, g, v } of set.recall) {
      close(a.sRecall(d, s, r, g), v, `sRecall(${d},${s},${r},${g})`);
    }
  });
  test(`[${set.name}] forget stability (incl. S/e^(w17*w18) cap)`, () => {
    for (const { d, s, r, v } of set.forget) {
      close(a.sForget(d, s, r), v, `sForget(${d},${s},${r})`);
    }
  });
  test(`[${set.name}] short-term stability (w17..w19, never lowered for Hard+)`, () => {
    for (const { s, g, v } of set.short) {
      close(a.sShort(s, g), v, `sShort(${s},${g})`);
    }
  });
  test(`[${set.name}] forgetting curve (decay w20)`, () => {
    for (const { s, t, v } of set.retrievability) {
      close(a.forgettingCurve(t, s), v, `R(t=${t}, S=${s})`);
    }
    close(a.forgettingCurve(10, 10), 0.9, 'R(t = S) = 0.9');
  });
  test(`[${set.name}] interval for retention 0.94 and 0.90, max 365`, () => {
    for (const [retention, rows] of Object.entries(set.interval)) {
      const b = withWeights((src) =>
        src.replace(/DESIRED_RETENTION = [\d.]+/, `DESIRED_RETENTION = ${retention}`));
      assert.equal(b.MAX_INTERVAL, golden.max_interval);
      for (const { s, v } of rows) {
        assert.equal(b.intervalDays(s), v, `intervalDays(${s}) @ ${retention}`);
      }
    }
  });
}

// ── scheduling behaviour ───────────────────────────────────────────────────
function reviewAtDueDay(card, rating, streak = 0) {
  // review on the due study day at 10:00 local (sub-day: exactly at due)
  const due = new FakeDate(card.due);
  if (card.scheduled_days >= 1) {
    due.setHours(10, 0, 0, 0);
  }
  at(due.getTime());
  return { ...card, ...api.scheduleCard(card, rating, streak) };
}

// ── review-log replay (weights screen) ──────────────────────────────────────
// The sheet's review_log in the shape getReviewLog() returns, from the golden rows.
const LOG_COLUMNS = ['review_time', 'card_id', 'rating', 'state_before', 'elapsed_days',
  'scheduled_days', 'stability', 'difficulty', 'hints', 'keywords', 'duration_ms'];
const toSheet = (rows) => ({
  columns: LOG_COLUMNS,
  rows: rows.map(([t, card, rating, state, elapsed, s, d]) =>
    [new Date(t).toISOString(), card, rating, state, elapsed, 1, s, d, 0, 0, 0]),
});
const replayRows = (rows = golden.replay.rows) => api.parseReviewLog(toSheet(rows));
const sameMetrics = (got, want, label) => {
  assert.equal(got.n, want.n, `${label} n`);
  for (const k of ['logloss', 'meanR', 'recall']) {
    close(got[k], want[k], `${label} ${k}`);
  }
};

for (const set of golden.sets) {
  test(`[${set.name}] replay loss equals the py-fsrs reference (all and held out)`, () => {
    const rows = replayRows();
    const res = golden.replay.results[set.name];
    sameMetrics(api.replayLoss(rows, set.parameters, -1), res.all, 'all');
    sameMetrics(api.replayLoss(rows, set.parameters, golden.replay.holdout_cut), res.held_out,
      'held out');
  });
}

test('replay: the hold-out cut equals the reference; a fifth of the scored rows follow', () => {
  const rows = replayRows();
  assert.equal(api.holdoutCut(rows), golden.replay.holdout_cut);
  const held = api.replayLoss(rows, [...api.W], golden.replay.holdout_cut).n;
  const all = api.replayLoss(rows, [...api.W], -1).n;
  assert.ok(held > 0.15 * all && held < 0.25 * all, `${held} of ${all}`);
});

test('replay: input order does not matter; weights are restored; bad rows are skipped', () => {
  const before = [...api.W];
  const rows = golden.replay.rows;
  const shuffled = [...rows].sort((a, b) => ((a[1] + a[0]) > (b[1] + b[0]) ? 1 : -1));
  const w = golden.sets[2].parameters;
  sameMetrics(api.replayLoss(replayRows(shuffled), w, -1),
    api.replayLoss(replayRows(rows), w, -1), 'shuffled');
  assert.deepEqual([...api.W], before, 'W restored');
  const dirty = toSheet(rows);
  const when = dirty.rows[0][0];
  dirty.rows.push(['not a date', 'x', 3, 2, 5, 1, 9, 5, 0, 0, 0],
    [when, 'x', 0, 2, 5, 1, 9, 5, 0, 0, 0], [when, 'x', 5, 2, 5, 1, 9, 5, 0, 0, 0]);
  assert.equal(api.parseReviewLog(dirty).length, rows.length);
});

test('replay: an empty log, and a log without scored reviews', () => {
  const none = api.replayLoss([], [...api.W], -1);
  assert.equal(none.n, 0);
  assert.ok(Number.isNaN(none.logloss));
  const learning = replayRows(golden.replay.rows.filter((r) => r[3] !== 2));
  assert.equal(api.holdoutCut(learning), Infinity);
  assert.equal(api.replayLoss(learning, [...api.W], -1).n, 0);
});

test('replay: longer stability scores better here; Again is the only forgotten rating', () => {
  // one card: New Good, Learning Good, then six reviews 10 days apart, all recalled
  const log = [];
  let t = Date.UTC(2026, 0, 1);
  log.push([t, 'c', 3, 0, 0, 1, 1]);
  t += 3_600_000;
  log.push([t, 'c', 3, 1, 0, 1, 1]);
  for (let i = 0; i < 6; i++) {
    t += 10 * 86_400_000;
    log.push([t, 'c', i === 5 ? 1.5 : 3, 2, 10, 1, 1]);
  }
  const base = golden.sets[0].parameters;
  const forgetful = api.replayLoss(replayRows(log), base, -1);
  const sticky = base.slice();
  sticky[1] = 20;
  sticky[2] = 20;                                     // far longer initial stability
  assert.equal(forgetful.n, 6);
  assert.equal(forgetful.recall, 1, 'Recap counts as recalled');
  assert.ok(api.replayLoss(replayRows(log), sticky, -1).logloss < forgetful.logloss);
  log[4][2] = 1;                                      // one Again among the reviews
  close(api.replayLoss(replayRows(log), base, -1).recall, 5 / 6, 'recall with one Again');
});

test('trajectories equal py-fsrs review_card (Easy start; Good start, 10 min/1 h)', () => {
  setGuard(false);                                   // py-fsrs has no horizon guard
  for (const { ratings, intervals } of golden.trajectories) {
    at(2026, 10, 6, 9, 0);
    let card = { state: 0 };
    ratings.forEach((rating, i) => {
      card = i === 0 ? { ...card, ...api.scheduleCard(card, rating, 0) }
                     : reviewAtDueDay(card, rating);
      const want = intervals[i];
      if (want < 1) {
        close(card.scheduled_days, want, `step ${i} of ${ratings}`);
      } else {
        assert.equal(card.scheduled_days, want, `step ${i} of ${ratings}`);
      }
    });
  }
  setGuard(true);
});
test('MAX_INTERVAL caps scheduled_days, not stability', () => {
  at(2026, 10, 6, 9, 0);
  const card = { state: 2, stability: 5000, difficulty: 3, scheduled_days: 365,
                 last_review: new Date(2026, 9, 6, 10).toISOString() };
  const f = api.scheduleCard(card, 4, 0);
  assert.equal(f.scheduled_days, 365);
  assert.ok(f.stability > 5000);
});
test('Recap never grows stability or the interval', () => {
  at(2026, 10, 6, 10, 0);
  for (const s of [3, 20, 82, 400]) {
    for (let streak = 0; streak <= 4; streak++) {
      const sch = api.intervalDays(s);
      const card = { state: 2, stability: s, difficulty: 6, scheduled_days: sch,
                     last_review: new Date(2026, 10, 6 - sch, 10).toISOString() };
      const f = api.scheduleCard(card, 1.5, streak);
      assert.ok(f.stability <= s + 1e-3, `S grew: s=${s} streak=${streak} -> ${f.stability}`);
      assert.ok(f.scheduled_days <= sch, `interval grew: ${f.scheduled_days} > ${sch}`);
      assert.equal(f.state, 2);
    }
  }
});
test('repeated Recap shrinks S and interval; later Good stays proportionate', () => {
  at(2026, 10, 6, 10, 0);
  let card = { state: 2, stability: 82, difficulty: 6, scheduled_days: api.intervalDays(82) };
  card.last_review = new Date(2026, 10, 6 - card.scheduled_days, 10).toISOString();
  card.due = new Date(2026, 10, 6, 4).toISOString();
  const seen = [card.scheduled_days];
  for (let streak = 0; streak < 4; streak++) {
    card = reviewAtDueDay(card, 1.5, streak);
    seen.push(card.scheduled_days);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] <= seen[i - 1], `non-monotone: ${seen}`);
  }
  assert.ok(seen.at(-1) < seen[0] / 3, `no real shrink: ${seen}`);
  const good = reviewAtDueDay(card, 3);
  const limit = 4 * card.scheduled_days + 5;
  assert.ok(good.scheduled_days < limit, `Good jumped: ${good.scheduled_days}`);
});
test('Recap collapses to Hard outside Review state', () => {
  at(2026, 10, 6, 10, 0);
  for (const state of [0, 1, 3]) {
    const card = { state, stability: 2, difficulty: 6, scheduled_days: 1 };
    const a = api.scheduleCard(card, 1.5, 2);
    const b = api.scheduleCard(card, 2, 0);
    assert.deepEqual({ ...a, last_review: 0, due: 0 }, { ...b, last_review: 0, due: 0 });
  }
});
test('lapse: Again in Review -> Relearning, due now, lapses+1', () => {
  at(2026, 10, 6, 10, 0);
  const card = { state: 2, stability: 20, difficulty: 5, scheduled_days: 20, lapses: 1,
                 last_review: new Date(2026, 9, 17, 10).toISOString() };
  const f = api.scheduleCard(card, 1, 0);
  assert.equal(f.state, 3);
  assert.equal(f.scheduled_days, 0);
  assert.equal(f.lapses, 2);
  assert.equal(f.due, new Date(2026, 10, 6, 10).toISOString());
  assert.ok(f.stability < 20);
});
test('sub-day steps are exact timestamps', () => {
  at(2026, 10, 6, 10, 0);
  const f = api.scheduleCard({ state: 0 }, 1, 0);
  assert.equal(f.state, 1);
  assert.equal(new Date(f.due) - new FakeDate(), 10 * 60000);
  const h = api.scheduleCard({ state: 1, stability: 1, difficulty: 6 }, 2, 0);
  assert.equal(new Date(h.due) - new FakeDate(), 60 * 60000);
});
test('nextInterval == scheduleCard().scheduled_days for all states/grades', () => {
  at(2026, 10, 6, 10, 0);
  for (const state of [0, 1, 2, 3]) {
    for (const g of [1, 1.5, 2, 3, 4]) {
      const card = { state, stability: 12, difficulty: 6, scheduled_days: 12,
                     last_review: new Date(2026, 9, 25, 10).toISOString() };
      assert.equal(api.nextInterval(card, g, 1), api.scheduleCard(card, g, 1).scheduled_days);
    }
  }
});

// ── study-day rollover (04:00 local) ───────────────────────────────────────
test('>=1 day intervals snap to 04:00 local on every day of 2026 (DST-safe)', () => {
  for (let day = 0; day < 365; day++) {
    const now = new Date(2026, 0, 1 + day, 23, 0);
    for (const days of [1, 2, 30]) {
      const due = api.dueDate(now, days);
      const want = new Date(2026, 0, 1 + day + days, 4, 0);
      assert.equal(due.getTime(), want.getTime(), `${now.toISOString()} +${days}d`);
    }
  }
});
test('after 00:00 but before 04:00 still counts as the previous study day', () => {
  const due = api.dueDate(new Date(2026, 10, 7, 2, 0), 1);
  assert.equal(due.getTime(), new Date(2026, 10, 7, 4, 0).getTime());
});
test('sub-day due is not snapped', () => {
  const now = new Date(2026, 10, 6, 23, 0);
  assert.equal(api.dueDate(now, 10 / 1440) - now, 10 * 60000);
});
test('elapsed is counted in study days (23:00 -> 04:00 next day = 1)', () => {
  at(2026, 10, 6, 4, 0);
  const card = { state: 2, stability: 1, difficulty: 5, scheduled_days: 1,
                 last_review: new Date(2026, 10, 5, 23, 0).toISOString() };
  assert.equal(api.scheduleCard(card, 3, 0).elapsed_days, 1);
});
test('elapsed capped at 2x scheduled_days', () => {
  at(2026, 10, 6, 10, 0);
  const card = { state: 2, stability: 5, difficulty: 5, scheduled_days: 5,
                 last_review: new Date(2026, 5, 1, 10).toISOString() };
  assert.equal(api.scheduleCard(card, 3, 0).elapsed_days, 10);
});

// ── recall record (ok_days, fail_days, trail): the horizon evidence, no scheduling ──
const reviewCard = (extra = {}) => ({
  state: 2, stability: 20, difficulty: 5, scheduled_days: 10,
  last_review: new Date(2026, 10, 1, 10, 0).toISOString(), ...extra,
});
test('recallRecord: Good and Easy raise ok_days and add a trail entry in study days', () => {
  const now = new Date(2026, 10, 11, 10, 0);                       // gap 10
  const good = api.recallRecord(reviewCard({ ok_days: 4, trail: '1:G' }), 3, now);
  assert.deepEqual({ ...good }, { ok_days: 10, fail_days: '', cap_days: '', trail: '1:G 10:G' });
  const easy = api.recallRecord(reviewCard({ ok_days: 30 }), 4, now);
  assert.deepEqual({ ...easy }, { ok_days: 30, fail_days: '', cap_days: '', trail: '10:E' });
});
test('recallRecord: Hard, Recap and Again set fail_days to the gap; ok_days is kept', () => {
  const now = new Date(2026, 10, 11, 10, 0);
  for (const [rating, code, cap] of [[2, 'H', 8.5], [1.5, 'R', 7.5], [1, 'A', '']]) {
    const rec = api.recallRecord(reviewCard({ ok_days: 6, fail_days: 40 }), rating, now);
    assert.deepEqual({ ...rec },
      { ok_days: 6, fail_days: 10, cap_days: cap, trail: '10:' + code });
  }
});
test('recallRecord: a failure is beaten by Good/Easy at that gap or later', () => {
  const now = new Date(2026, 10, 11, 10, 0);                       // gap 10
  const kept = api.recallRecord(reviewCard({ fail_days: 11 }), 3, now);
  assert.equal(kept.fail_days, 11);
  const equal = api.recallRecord(reviewCard({ fail_days: 10 }), 3, now);
  assert.equal(equal.fail_days, '');
  const later = api.recallRecord(reviewCard({ fail_days: 7 }), 4, now);
  assert.equal(later.fail_days, '');
});
test('recallRecord: the trail keeps the newest 8 entries, oldest first', () => {
  const trail = '1:G 2:G 3:G 4:G 5:G 6:G 7:G 8:G';
  const rec = api.recallRecord(reviewCard({ trail }), 2, new Date(2026, 10, 11, 10, 0));
  assert.equal(rec.trail, '2:G 3:G 4:G 5:G 6:G 7:G 8:G 10:H');
  assert.equal(api.TRAIL_LEN, 8);
});
test('recallRecord: only Review-state reviews with a gap of 1+ study days count', () => {
  const now = new Date(2026, 10, 11, 10, 0);
  for (const state of [0, 1, 3]) {
    assert.deepEqual({ ...api.recallRecord(reviewCard({ state }), 3, now) }, {}, 'state ' + state);
  }
  const sameDay = new Date(2026, 10, 1, 20, 0);
  assert.deepEqual({ ...api.recallRecord(reviewCard(), 3, sameDay) }, {});
  assert.deepEqual({ ...api.recallRecord(reviewCard({ last_review: '' }), 3, now) }, {});
  assert.deepEqual({ ...api.recallRecord(reviewCard({ last_review: 'x' }), 3, now) }, {});
  assert.deepEqual({ ...api.recallRecord(reviewCard(), 2.5, now) }, {}, 'unknown rating');
});
test('recallRecord: gap is counted in study days (23:00 -> 04:00 next day = 1)', () => {
  const card = reviewCard({ last_review: new Date(2026, 10, 5, 23, 0).toISOString() });
  const rec = api.recallRecord(card, 3, new Date(2026, 10, 6, 4, 0));
  assert.equal(rec.trail, '1:G');
  const early = api.recallRecord(card, 3, new Date(2026, 10, 6, 3, 59));
  assert.deepEqual({ ...early }, {}, 'before the rollover it is still the same study day');
});
test('parseTrail ignores what is not "gap:code"; scheduleCard does not touch the record', () => {
  const parsed = [...api.parseTrail('3:G junk 12:H 7:X :G 5:')].map((t) => t.gap + t.code);
  assert.deepEqual(parsed, ['3G', '12H']);
  assert.equal(api.parseTrail(undefined).length, 0);
  at(2026, 10, 11, 10, 0);
  const next = api.scheduleCard(reviewCard({ trail: '1:G', ok_days: 1 }), 2, 0);
  for (const key of ['trail', 'ok_days', 'fail_days']) {
    assert.equal(key in next, false, key);
  }
});

// ── horizon guard: after Hard or Recap the next interval stays short of the failed gap ──
function reviewRecorded(card, rating) {
  const due = new FakeDate(card.due);
  if (card.scheduled_days >= 1) {
    due.setHours(10, 0, 0, 0);
  }
  at(due.getTime());
  const fsrs = api.scheduleCard(card, rating, 0);
  const record = api.recallRecord(card, rating, new FakeDate(fsrs.last_review));
  return { ...card, ...fsrs, ...record };
}
// Every review on its due day; returns the interval after each rating and the last card.
function runPlan(ratings, guard) {
  setGuard(guard);
  at(2026, 0, 5, 10, 0);
  let card = { state: 0 };
  const intervals = [];
  ratings.forEach((rating, i) => {
    card = i === 0 ? { ...card, ...api.scheduleCard(card, rating, 0) }
                   : reviewRecorded(card, rating);
    intervals.push(card.scheduled_days);
  });
  setGuard(true);
  return { intervals, card };
}
const LADDER = [3, 3, 3, 3, 3, 3];                 // gaps 1, 4, 12, 32, 77 d, then due at 77
const after = (ratings, guard, n = 5) => runPlan([...LADDER, ...ratings], guard)
  .intervals.slice(LADDER.length, LADDER.length + n);

test('guard trajectories after a Good ladder 1, 4, 12, 32, 77: Hard at 77 d', () => {
  assert.deepEqual(after([2, 3, 3, 3, 3], false), [134, 239, 365, 365, 365]);
  assert.deepEqual(after([2, 3, 3, 3, 3], true), [65, 85, 157, 278, 365]);
});
test('guard trajectories: Recap at 77 d', () => {
  assert.deepEqual(after([1.5, 3, 3, 3, 3], false), [77, 144, 256, 365, 365]);
  assert.deepEqual(after([1.5, 3, 3, 3, 3], true), [58, 75, 98, 179, 314]);
});
test('guard trajectories: three Hard in a row shorten, a pass at the failed gap lifts', () => {
  assert.deepEqual(after([2, 2, 2, 3, 3], false), [134, 197, 260, 358, 365]);
  assert.deepEqual(after([2, 2, 2, 3, 3], true), [65, 55, 47, 61, 90]);
});
test('guard does not change Again: relearning steps and graduation are the same', () => {
  const off = after([1, 3, 3, 3, 3, 3, 3], false, 7);
  const on = after([1, 3, 3, 3, 3, 3, 3], true, 7);
  assert.ok(on[0] < 1, 'Again from Review is due at once');
  assert.deepEqual(on, off);
  assert.deepEqual(on.slice(1), [2, 4, 7, 13, 21, 35]);
});
test('guard keeps stability consistent with the interval it shortens', () => {
  const { card } = runPlan([...LADDER, 2], true);
  assert.equal(card.scheduled_days, 65);
  assert.equal(api.intervalDays(card.stability), 65);
  assert.equal(card.cap_days, 65.45);
  assert.equal(card.fail_days, 77);
  const off = runPlan([...LADDER, 2], false).card;
  assert.ok(card.stability < off.stability, 'the guard only lowers stability');
});
test('stabilityFor is the inverse of intervalDays', () => {
  for (const days of [1, 2, 7, 65, 200, 365]) {
    assert.equal(api.intervalDays(api.stabilityFor(days)), days);
  }
});
test('guard: the cap survives uncounted reviews and applies at relearning graduation', () => {
  const last = new Date(2026, 10, 6, 8, 0).toISOString();
  at(2026, 10, 6, 10, 0);
  const base = { stability: 400, difficulty: 5, scheduled_days: 60, last_review: last,
                 fail_days: 40, cap_days: 20 };
  const sameDay = { ...base, state: 2 };                         // gap 0: not counted
  assert.deepEqual({ ...api.recallRecord(sameDay, 3, new FakeDate()) }, {});
  assert.ok(api.scheduleCard(sameDay, 3, 0).scheduled_days <= 20);
  const relearn = { ...base, state: 3, stability: 6, cap_days: 1 };
  setGuard(false);
  assert.ok(api.scheduleCard(relearn, 3, 0).scheduled_days > 1);
  setGuard(true);
  assert.equal(api.scheduleCard(relearn, 3, 0).scheduled_days, 1);
});
test('guard: no cap, no failure on record, or guard off: FSRS interval unchanged', () => {
  at(2026, 10, 11, 10, 0);
  const card = { state: 2, stability: 60, difficulty: 6, scheduled_days: 38,
                 last_review: new Date(2026, 9, 2, 10).toISOString() };   // gap 40
  const plain = api.scheduleCard(card, 3, 0);
  assert.equal(api.scheduleCard({ ...card, fail_days: 90 }, 3, 0).scheduled_days,
    plain.scheduled_days, 'a failure alone sets no cap');
  setGuard(false);
  const capped = { ...card, fail_days: 90, cap_days: 5 };
  assert.equal(api.scheduleCard(capped, 3, 0).scheduled_days, plain.scheduled_days);
  setGuard(true);
  assert.ok(api.scheduleCard(capped, 3, 0).scheduled_days <= 7, 'on: 5 * 1.3 = 6.5 -> 7');
});
test('recallRecord cap: Hard .85, Recap .75 of the gap, x1.3 per pass, lifted at the gap', () => {
  const now = new Date(2026, 10, 11, 10, 0);                     // gap 10
  const rec = (extra, rating) => api.recallRecord(reviewCard(extra), rating, now);
  assert.equal(rec({}, 2).cap_days, 8.5);
  assert.equal(rec({}, 1.5).cap_days, 7.5);
  assert.equal(rec({ cap_days: 9 }, 1).cap_days, '', 'Again clears the cap');
  assert.equal(rec({ fail_days: 30, cap_days: 25.5 }, 3).cap_days, 33.15, 'a pass below the gap');
  assert.equal(rec({ fail_days: 30, cap_days: 25.5 }, 3).fail_days, 30);
  assert.equal(rec({ fail_days: 10, cap_days: 8.5 }, 4).cap_days, '', 'a pass at the gap lifts');
  assert.equal(rec({ cap_days: 8.5 }, 3).cap_days, '', 'a cap without a failure is dropped');
  const tiny = rec({ fail_days: 30, cap_days: 2.25 }, 3).cap_days;
  assert.equal(tiny, Math.round(2.25 * 1.3 * 100) / 100);
  assert.notEqual(tiny, 2.25 * 1.3, 'the cap is kept to 2 decimals');
});

// ── horizonPull: a card scheduled past its cap is moved to the cap ──
const pulled = (extra = {}) => ({
  state: 2, stability: 266, difficulty: 6, scheduled_days: 134, fail_days: 77, cap_days: 65.45,
  last_review: new Date(2026, 9, 20, 10, 0).toISOString(),     // 20 Oct
  due: new Date(2027, 2, 3, 4, 0).toISOString(),               // 134 d later
  ...extra,
});
test('horizonPull: due moves to the cap, scheduled_days follows, stability matches it', () => {
  const now = new Date(2026, 10, 19, 10, 0);
  const pull = api.horizonPull(pulled(), now);
  assert.equal(pull.scheduled_days, 65);
  assert.equal(pull.due, new Date(2026, 11, 24, 4, 0).toISOString(), '65 study days after 20 Oct');
  assert.equal(api.intervalDays(pull.stability), 65);
  assert.ok(pull.stability < 266);
  const small = api.horizonPull(pulled({ stability: 5 }), now);
  assert.equal(small.stability, 5, 'stability is never raised');
});
test('horizonPull: nothing to do without a failure and cap, in other states, or when due', () => {
  const now = new Date(2026, 10, 19, 10, 0);
  assert.equal(api.horizonPull(pulled({ cap_days: '' }), now), null);
  assert.equal(api.horizonPull(pulled({ fail_days: '' }), now), null);
  assert.equal(api.horizonPull(pulled({ state: 3 }), now), null);
  assert.equal(api.horizonPull(pulled({ stability: 0 }), now), null);
  assert.equal(api.horizonPull(pulled({ last_review: 'x' }), now), null);
  assert.equal(api.horizonPull(pulled({ due: '' }), now), null);
  const later = new Date(2027, 2, 3, 12, 0);
  assert.equal(api.horizonPull(pulled(), later), null, 'already due: nothing to pull forward');
});
test('horizonPull: only beyond the cap; a cap day in the past makes it due now', () => {
  const now = new Date(2026, 10, 19, 10, 0);
  const atCap = pulled({ due: new Date(2026, 11, 24, 4, 0).toISOString() });
  assert.equal(api.horizonPull(atCap, now), null, 'due on the cap day already');
  const inside = pulled({ due: new Date(2026, 11, 1, 4, 0).toISOString() });
  assert.equal(api.horizonPull(inside, now), null, 'due before the cap day');
  const late = api.horizonPull(pulled({ cap_days: 5 }), now);     // cap day 25 Oct, in the past
  assert.equal(late.scheduled_days, 5);
  assert.equal(late.due, new Date(2026, 9, 25, 4, 0).toISOString());
  const tiny = api.horizonPull(pulled({ cap_days: 0.4 }), now);
  assert.equal(tiny.scheduled_days, 1, 'at least a day');
});

test('horizonPull gives the state the guard would have produced at that review', () => {
  for (const rating of [2, 1.5]) {
    const on = runPlan([...LADDER, rating], true).card;
    const off = runPlan([...LADDER, rating], false).card;        // scheduled without the guard
    assert.ok(off.scheduled_days > on.scheduled_days, 'the unguarded card lies past the cap');
    const pull = api.horizonPull(off, new FakeDate(new Date(off.last_review).getTime() + 3600e3));
    assert.equal(pull.scheduled_days, on.scheduled_days);
    assert.equal(pull.due, on.due);
    assert.equal(pull.stability, on.stability);
  }
});


// ── recallStatus: where a card stands, for the Recall screen ──
const standing = (extra = {}) => ({
  state: 2, stability: 60, scheduled_days: 38,
  last_review: new Date(2026, 9, 10, 10, 0).toISOString(),     // 10 Oct
  due: new Date(2026, 10, 27, 4, 0).toISOString(),             // 27 Nov
  ...extra,
});
test('recallStatus: new, learning and Review cards without data', () => {
  const now = new Date(2026, 10, 19, 10, 0);                   // gap 40
  assert.equal(api.recallStatus({ state: 0 }, now).status, 'new');
  assert.equal(api.recallStatus({}, now).status, 'new');
  assert.equal(api.recallStatus({ state: 1 }, now).status, 'learning');
  assert.equal(api.recallStatus({ state: 3 }, now).status, 'learning');
  assert.equal(api.recallStatus(standing({ last_review: '' }), now).status, 'safe');
  assert.equal(api.recallStatus(standing({ stability: 0 }), now).risk, 0);
});
test('recallStatus: past > due > watch > safe, decided in that order', () => {
  const now = new Date(2026, 10, 19, 10, 0);                   // gap 40
  const st = (extra) => api.recallStatus(standing(extra), now);
  assert.equal(st({}).status, 'safe');
  assert.equal(st({ fail_days: 77 }).status, 'watch', 'a failure not reached yet');
  assert.equal(st({ fail_days: 40 }).status, 'past', 'the gap has reached the failed gap');
  assert.equal(st({ fail_days: 30 }).status, 'past');
  assert.equal(st({ due: new Date(2026, 10, 19, 4, 0).toISOString() }).status, 'due');
  assert.equal(st({ due: new Date(2026, 10, 19, 4, 0).toISOString(), fail_days: 77 }).status,
    'due', 'due beats watch');
  assert.equal(st({ due: new Date(2026, 10, 19, 4, 0).toISOString(), fail_days: 30 }).status,
    'past', 'past beats due');
  assert.equal(st({ due: new Date(2026, 10, 19, 12, 0).toISOString() }).status, 'safe',
    'due later today is not due yet');
  assert.equal(api.RECALL_ORDER.join(), 'past,due,watch,safe,learning,new');
});
test('recallStatus: risk is how far past the failed gap, else 1 - recall now', () => {
  const now = new Date(2026, 10, 19, 10, 0);
  const past = api.recallStatus(standing({ fail_days: 20 }), now);
  assert.equal(past.risk, 2, '40 d against a failed gap of 20 d');
  assert.equal(past.gap, 40);
  const safe = api.recallStatus(standing(), now);
  assert.equal(safe.risk, 1 - api.forgettingCurve(40, 60));
  assert.equal(safe.recall, api.forgettingCurve(40, 60));
  const weaker = api.recallStatus(standing({ stability: 20 }), now);
  assert.ok(weaker.risk > safe.risk, 'lower stability, higher risk');
});


// ── aheadRatio: Review ahead takes cards near their failed gap that are not due yet ──
test('aheadRatio: gap / failed gap from 0.75 up, for cards that are not due yet', () => {
  const now = new Date(2026, 10, 19, 10, 0);                   // gap 40, due 27 Nov: not yet
  const ratio = (extra) => api.aheadRatio(standing(extra), now);
  assert.equal(api.AHEAD_FRACTION, 0.75);
  assert.equal(ratio({ fail_days: 50 }), 0.8);
  assert.equal(ratio({ fail_days: 40 }), 1, 'at the failed gap');
  assert.equal(ratio({ fail_days: 30 }), 40 / 30, 'past it, but not due yet');
  assert.equal(ratio({ fail_days: 53 }), 40 / 53, '0.7547 >= 0.75');
  assert.equal(ratio({ fail_days: 54 }), null, '0.7407 < 0.75');
  assert.equal(ratio({ fail_days: 160 }), null, 'far from it');
  const edge = new Date(2026, 10, 9, 10, 0);                   // gap 30 of a failed gap of 40
  assert.equal(api.aheadRatio(standing({ fail_days: 40 }), edge), 0.75, 'the limit itself counts');
});
test('aheadRatio: not for due cards, other states, no failure or bad dates', () => {
  const now = new Date(2026, 10, 19, 10, 0);
  const ratio = (extra) => api.aheadRatio(standing({ fail_days: 50, ...extra }), now);
  assert.equal(ratio({ due: new Date(2026, 10, 19, 4, 0).toISOString() }), null, 'due now');
  assert.equal(ratio({ due: new Date(2026, 10, 1, 4, 0).toISOString() }), null, 'overdue');
  assert.equal(ratio({ due: new Date(2026, 10, 19, 12, 0).toISOString() }), 0.8, 'later today');
  assert.equal(ratio({ state: 3 }), null);
  assert.equal(ratio({ state: 0 }), null);
  assert.equal(ratio({ fail_days: '' }), null);
  assert.equal(ratio({ fail_days: 0 }), null);
  assert.equal(ratio({ last_review: '' }), null);
  assert.equal(ratio({ due: '' }), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
