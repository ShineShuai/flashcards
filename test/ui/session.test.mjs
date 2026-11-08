// Run: node test/ui/session.test.mjs   (needs: npm install --no-save jsdom)
// Session flow: re-queue, progress, 04:00 due times, Recap preview, shuffle.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

// ── re-queue, progress, rollover
{
  const env = boot({ cards: [card('1'), card('2'), card('3', 'c1;c2;c3;c4;c5')] });
  await env.start();
  const { w, txt, shown, saved } = env;
  assert.equal(txt('prog-text'), '0 / 3');
  assert.equal(txt('card-title'), 'T1');

  // c1: Again -> Learning 10 min -> returns after min(5, 2) other cards
  w.flipCard();
  assert.equal(txt('int-1'), '10m');
  w.rate(1);
  await sleep(5);
  assert.equal(txt('card-title'), 'T2');
  assert.equal(txt('prog-text'), '0 / 3', 'a re-queued card is not done');

  // c2: Easy -> Review (>= 1 day) -> done
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T3');
  assert.equal(txt('prog-text'), '1 / 3');

  // c3: Good on a new card -> Learning 1 h -> end of the queue
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.equal(txt('card-title'), 'T1', 'the Again card returns before the 1 h card');
  assert.equal(w.eval('deck.map(c => c.id).join(",")'), 'c1,c2,c3,c1,c3'.replace(/c/g, ''));

  // c1 second pass: Good in Learning graduates (>= 1 day)
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.equal(txt('prog-text'), '2 / 3');
  assert.equal(txt('card-title'), 'T3');

  // c3 second pass: graduates -> session complete
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.ok(shown('s-complete'));
  await until(() => saved.length === 5);
  const by = (id) => saved.filter((x) => x.id === id).map((x) => x.fsrs.state);
  assert.deepEqual(by('1'), [1, 2]);
  assert.deepEqual(by('2'), [2]);
  assert.deepEqual(by('3'), [1, 2]);
  const graduated = saved.filter((x) => x.fsrs.scheduled_days >= 1);
  assert.equal(graduated.length, 3);
  for (const g of graduated) {
    const due = new Date(g.fsrs.due);
    assert.equal(due.getHours(), 4, 'due snaps to 04:00 local');
    assert.equal(due.getMinutes(), 0);
  }
  assert.equal(txt('cs-total'), '5');
  console.log('ok   re-queue (+5 cards / end), progress, 04:00 due, saves');
}

// ── Recap preview follows the hints; repeated weak keyword raises the streak
{
  const now = Date.now();
  const review = card('r1', 'x;y;z;w;v', {
    state: 2, stability: 40, difficulty: 6, scheduled_days: 38, reps: 5, lapses: 0,
    miss_streak: 1, weak_keywords: 'X;y',
    last_review: new Date(now - 38 * 86400000).toISOString(),
    due: new Date(now - 1000).toISOString(),
  });
  const env = boot({ cards: [review] });
  await env.start();
  const { w, txt, saved } = env;
  w.flipCard();
  const before = txt('int-1.5');
  w.flipCard();
  for (let i = 0; i < 5; i++) {
    w.revealHint();
  }
  w.flipCard();
  const after = txt('int-1.5');
  assert.notEqual(before, after, `preview must reflect the hints (${before} vs ${after})`);
  w.rate(1.5);
  await until(() => saved.length === 1);
  const last = saved[0].fsrs;
  assert.equal(last.miss_streak, 2, 'case-insensitive overlap with the previous weak set');
  assert.equal(last.weak_keywords.split(';').length, 5);
  assert.ok(last.stability <= 40 + 1e-6, 'Recap never grows stability');
  assert.ok(last.scheduled_days <= 38, 'Recap never grows the interval');
  console.log(`ok   Recap preview ${before} -> ${after}; write streak=${last.miss_streak}`);
}

// ── shuffle is uniform (Fisher-Yates)
{
  const env = boot({ cards: [card('1')] });
  await env.start();
  const counts = {};
  for (let i = 0; i < 60000; i++) {
    const k = env.w.eval("shuffle(['a','b','c']).join('')");
    counts[k] = (counts[k] || 0) + 1;
  }
  const values = Object.values(counts);
  assert.equal(values.length, 6);
  assert.ok(Math.max(...values) / Math.min(...values) < 1.12, JSON.stringify(counts));
  console.log('ok   shuffle uniform');
}
