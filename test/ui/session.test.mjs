// Run: node test/ui/session.test.mjs   (needs: npm install --no-save jsdom)
// Session flow: re-queue, progress, 04:00 due times, Recap preview, shuffle.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

// ── re-queue, progress, rollover
const past = () => new Date(Date.now() - 1000).toISOString();
{
  const env = boot({ cards: [card('1'), card('2'), card('3', 'c1;c2;c3;c4;c5'), card('4')] });
  await env.start();
  const { w, txt, shown, saved } = env;
  assert.equal(txt('prog-text'), '0 / 4');
  assert.equal(txt('card-title'), 'T1');

  // c1: Again -> Learning 10 min -> queued behind min(5, 3) other cards
  w.flipCard();
  assert.equal(txt('int-1'), '10m');
  w.rate(1);
  await sleep(5);
  assert.equal(txt('card-title'), 'T2');
  assert.equal(txt('prog-text'), '0 / 4', 'a re-queued card is not done');

  // c2: Easy -> Review (>= 1 day) -> done
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T3');
  assert.equal(txt('prog-text'), '1 / 4');

  // c3: Good on a new card -> Learning 1 h -> end of the queue
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.equal(txt('card-title'), 'T4');
  assert.equal(w.eval('deck.map(c => c.id).join(",")'), '1,2,3,4,1,3');

  // 10 min and 1 h later (the due times are moved into the past)
  w.eval(`deck[4].due = ${JSON.stringify(past())}; deck[5].due = ${JSON.stringify(past())}`);
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T1', 'the Again card returns before the 1 h card');

  // c1 second pass: Good in Learning graduates (>= 1 day)
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.equal(txt('prog-text'), '3 / 4');
  assert.equal(txt('card-title'), 'T3');

  // c3 second pass: graduates -> session complete
  w.flipCard();
  w.rate(3);
  await sleep(5);
  assert.ok(shown('s-complete'));
  assert.equal(txt('cs-title'), 'All done!');
  await until(() => saved.length === 6);
  const by = (id) => saved.filter((x) => x.id === id).map((x) => x.fsrs.state);
  assert.deepEqual(by('1'), [1, 2]);
  assert.deepEqual(by('2'), [2]);
  assert.deepEqual(by('3'), [1, 2]);
  assert.deepEqual(by('4'), [2]);
  const graduated = saved.filter((x) => x.fsrs.scheduled_days >= 1);
  assert.equal(graduated.length, 4);
  for (const g of graduated) {
    const due = new Date(g.fsrs.due);
    assert.equal(due.getHours(), 4, 'due snaps to 04:00 local');
    assert.equal(due.getMinutes(), 0);
  }
  assert.equal(txt('cs-total'), '6');
  console.log('ok   re-queue (+5 cards / end), progress, 04:00 due, saves');
}

// ── a sub-day card is not offered before its due time
{
  const env = boot({ cards: [card('1'), card('2'), card('3')] });
  await env.start();
  const { w, $, txt, shown, saved } = env;
  w.flipCard();
  w.rate(1);                                   // c1 Again: 10 min
  await sleep(5);
  w.flipCard();
  w.rate(3);                                   // c2 Good on a new card: 1 h
  await sleep(5);
  assert.equal(txt('card-title'), 'T3');
  assert.equal($('btn-skip').disabled, true, 'only waiting cards behind: nothing to skip to');
  w.skipCard();
  assert.equal(txt('card-title'), 'T3', 'skip does not pull a waiting card in');
  w.flipCard();
  w.rate(4);                                   // c3 Easy: only c1 (10 min) and c2 (1 h) left
  await sleep(5);
  assert.ok(shown('s-complete'), 'no waiting card is shown early');
  assert.equal(txt('cs-title'), 'Done for now');
  assert.equal(txt('cs-sub'), 'Next: 2 cards in 10m.');
  assert.equal(txt('cs-total'), '3');

  // undo reopens the last card; the waiting cards stay queued
  w.undoRating();
  await sleep(5);
  assert.ok(shown('s-session'));
  assert.equal(txt('card-title'), 'T3');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.ok(shown('s-complete'));
  await until(() => saved.length === 5);   // 3 ratings, the undo, the new rating
  console.log('ok   waiting cards: not shown early, skip ignores them, done-for-now, undo');
}
{
  // due while the session goes on: shown at the next card, in queue order
  const env = boot({ cards: [card('1'), card('2'), card('3'), card('4')] });
  await env.start();
  const { w, txt } = env;
  w.flipCard();
  w.rate(1);                                   // c1 Again: deck 1,2,3,4,1
  await sleep(5);
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T3');
  w.eval(`deck[4].due = ${JSON.stringify(past())}`);   // 10 min passed
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T4', 'the +5 queue position still holds');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T1', 'due now: shown after the cards ahead of it');
  console.log('ok   a due waiting card comes back in queue order');
}
{
  // Again from Review is due immediately: +5 cards, no wait
  const now = Date.now();
  const review = card('r1', 'x;y;z', {
    state: 2, stability: 20, difficulty: 6, scheduled_days: 20, reps: 5, lapses: 0,
    last_review: new Date(now - 20 * 86400000).toISOString(),
    due: new Date(now - 1000).toISOString(),
  });
  const env = boot({ cards: [review, card('2')] });
  await env.start();
  const { w, txt } = env;
  w.flipCard();
  w.rate(1);
  await sleep(5);
  assert.equal(txt('card-title'), 'T2');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'Tr1', 'a lapse (due now) returns after the other card');
  console.log('ok   lapse from Review returns without waiting');
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
