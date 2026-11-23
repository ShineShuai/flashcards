// Run: node test/ui/recall.test.mjs   (needs: npm install --no-save jsdom)
// Recall strip (gap, recall now, trail, best/failed, probation), the rating toast, the
// recall fields in the save, the horizon guard's interval, and undo.
import assert from 'node:assert/strict';
import { boot, card, until } from './harness.mjs';

// n calendar days back at the same local time of day, so the app's study-day gap is n at
// any hour. (n * 24 h is n days only without a DST change in between: an hour off, which
// moves the card across the 04:00 rollover and the gap by one.)
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};
const reviewCard = (extra = {}) => card('r1', 'x;y;z;w;v', {
  state: 2, stability: 60, difficulty: 6, scheduled_days: 38, reps: 6, lapses: 0,
  last_review: daysAgo(40), due: new Date(Date.now() - 1000).toISOString(),
  trail: '1:G 4:G 12:G 32:G 77:H', ok_days: 32, fail_days: 77, ...extra,
});
const strips = (w) => [...w.document.querySelectorAll('.recall-strip')];
const chips = (el) => [...el.querySelectorAll('.rs-chip')].map((c) => c.textContent);

// ── the strip: both faces, every part
{
  const env = boot({ cards: [reviewCard()] });
  await env.start();
  const { w } = env;
  const [front, back] = strips(w);
  assert.equal(strips(w).length, 2);
  assert.equal(front.textContent, back.textContent, 'same record on both faces');
  const now = Math.round(100 * w.eval('forgettingCurve(40, 60)'));
  assert.equal(front.querySelector('.rs-now').textContent,
    `gap 40 d · recall now ${now}% · planned 38 d`);
  assert.deepEqual(chips(front), ['1 ✓', '4 ✓', '12 ✓', '32 ✓', '77 H']);
  assert.equal(front.querySelector('.rs-chip.weak').title, 'gap 77 d: Hard');
  assert.equal(front.querySelector('.rs-best').textContent, 'best ✓ 32 d');
  assert.equal(front.querySelector('.rs-fail').textContent, 'failed ✗ 77 d');
  w.close();
  console.log('ok   strip: gap, recall now, trail, best, failed on both faces');
}

// ── old cards, new cards, short steps
{
  const legacy = card('l1', 'a;b', {
    state: 2, stability: 10, difficulty: 5, scheduled_days: 9, last_review: daysAgo(9),
  });
  const fresh = card('n1');
  const env = boot({ cards: [legacy, fresh] });
  await env.start();
  const { w } = env;
  const [front] = strips(w);
  assert.equal(front.querySelector('.rs-now').textContent.startsWith('gap 9 d'), true);
  assert.equal(chips(front).length, 0);
  assert.equal(front.querySelector('.rs-best'), null);
  assert.equal(front.querySelector('.rs-fail'), null);
  w.flipCard();
  w.rate(3);
  await until(() => env.saved.length === 1);
  const fsrs = env.saved[0].fsrs;
  assert.equal(fsrs.trail, '9:G');
  assert.equal(fsrs.ok_days, 9);
  assert.equal(fsrs.fail_days, '');
  // the new card: nothing to show, and nothing recorded
  assert.equal(strips(w)[0].textContent, '');
  w.flipCard();
  w.rate(3);
  await until(() => env.saved.length === 2);
  for (const key of ['trail', 'ok_days', 'fail_days']) {
    assert.equal(key in env.saved[1].fsrs, false, key);
  }
  w.close();
  console.log('ok   legacy card starts a trail; new card shows and records nothing');
}

// ── rating: record in the save, toast, undo restores the old record
{
  const env = boot({ cards: [reviewCard(), card('n2')] });
  await env.start();
  const { w, saved, $ } = env;
  w.flipCard();
  w.rate(2);
  await until(() => saved.length === 1);
  const fsrs = saved[0].fsrs;
  assert.equal(fsrs.trail, '1:G 4:G 12:G 32:G 77:H 40:H');
  assert.equal(fsrs.ok_days, 32);
  assert.equal(fsrs.fail_days, 40);
  assert.equal(fsrs.cap_days, 34, 'Hard at 40 d: cap 0.85 * 40');
  assert.equal(fsrs.scheduled_days, 34, 'the guard keeps the next interval at the cap');
  const was = w.withGuard(false, () => w.scheduleCard(reviewCard(), 2, 0)).scheduled_days;
  assert.ok(was > 38, 'without the guard a Hard would grow the interval');
  const toast = $('rate-toast');
  assert.ok(toast.classList.contains('on'));
  assert.equal(toast.textContent,
    `Hard at 40 d → next ${w.formatInterval(34)} (was ${w.formatInterval(was)})`);

  w.undoRating();
  await until(() => saved.length === 2);
  assert.equal(toast.classList.contains('on'), false, 'undo hides the toast');
  const undo = saved[1];
  assert.equal(undo.meta.undo, true);
  assert.equal(undo.fsrs.trail, '1:G 4:G 12:G 32:G 77:H');
  assert.equal(undo.fsrs.ok_days, 32);
  assert.equal(undo.fsrs.fail_days, 77);
  assert.equal(undo.fsrs.cap_days, '', 'the cap before the rating (none) comes back');
  assert.equal(strips(w)[0].querySelector('.rs-fail').textContent, 'failed ✗ 77 d');

  // after the undo the card is as before: a Good at 40 d does not beat the failure at 77 d
  w.flipCard();
  w.rate(3);
  await until(() => saved.length === 3);
  assert.equal(saved[2].fsrs.fail_days, 77);
  w.close();
  console.log('ok   rating saves the record, shows the outcome; undo restores the old record');
}

// ── a Good at or beyond the failed gap clears it
{
  const env = boot({ cards: [reviewCard({ fail_days: 30, trail: '1:G 30:H' })] });
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  await until(() => env.saved.length === 1);
  assert.equal(env.saved[0].fsrs.fail_days, '');
  assert.equal(env.saved[0].fsrs.trail, '1:G 30:H 40:E');
  assert.equal(env.$('rate-toast').textContent.startsWith('Easy at 40 d → next '), true);
  env.w.close();
  console.log('ok   Easy beyond the failed gap clears fail_days');
}

// ── probation chip: shown while a cap is active and the guard is on
{
  const env = boot({ cards: [reviewCard({ cap_days: 65.45 }), reviewCard({ cap_days: '' })] });
  await env.start();
  const { w } = env;
  const [front] = strips(w);
  const chip = front.querySelector('.rs-cap');
  assert.equal(chip.textContent, 'probation: recall at ≥ 77 d to lift');
  w.eval('HORIZON_GUARD = false');
  w.renderRecallStrip(w.eval('deck[idx]'));
  assert.equal(strips(w)[0].querySelector('.rs-cap'), null, 'guard off: no probation chip');
  w.eval('HORIZON_GUARD = true');
  w.flipCard();
  w.rate(3);
  await until(() => env.saved.length === 1);
  assert.equal(strips(w)[0].querySelector('.rs-cap'), null, 'no cap, no probation chip');
  w.close();
  console.log('ok   probation chip follows the cap and the switch');
}

// ── the guard is on by default; off, a Hard grows the interval and no "was" shows
{
  const env = boot({ cards: [reviewCard()], config: () => ({ horizon_guard: false }) });
  await env.start();
  const { w, saved } = env;
  assert.equal(w.eval('HORIZON_GUARD'), false);
  w.flipCard();
  w.rate(2);
  await until(() => saved.length === 1);
  assert.ok(saved[0].fsrs.scheduled_days > 38);
  assert.equal(env.$('rate-toast').textContent.includes('was'), false);
  assert.equal(saved[0].fsrs.cap_days, 34, 'the record is kept while the guard is off');
  w.close();
  const on = boot({ cards: [reviewCard()] });
  await on.start();
  assert.equal(on.w.eval('HORIZON_GUARD'), true, 'default: on');
  on.w.close();
  console.log('ok   guard off: FSRS interval, record kept; default is on');
}
