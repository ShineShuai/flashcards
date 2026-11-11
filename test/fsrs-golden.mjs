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

function load(patch = (s) => s) {
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
    'MAX_INTERVAL parseReviewLog holdoutCut replayLoss isScored';
  const api = vm.runInContext(
    `${patch(block)}\n${replay}\n({${names.split(' ').join(',')}})`, ctx);
  const at = (...args) => {
    clock.t = new FakeDate(...args).getTime();
  };
  return { api, at, FakeDate };
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

const { api, at, FakeDate } = load();

// ── py-fsrs parity ──────────────────────────────────────────────────────────
test('weights equal py-fsrs 6.3.2 defaults', () => {
  assert.equal(golden.sets[0].name, 'default');
  assert.deepEqual([...api.W], golden.sets[0].parameters);
  assert.equal(api.W.length, 21);
});

for (const set of golden.sets) {
  // a fresh app per weight set; weights are replaced in place
  const withWeights = (patch) => {
    const loaded = load(patch);
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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
