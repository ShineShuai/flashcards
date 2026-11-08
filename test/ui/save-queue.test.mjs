// Run: node test/ui/save-queue.test.mjs   (needs: npm install --no-save jsdom)
// Save queue: strict order, retry with backoff, persistence, home gating, cache.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

const rateAll = async (w, n, rating = 4) => {
  for (let i = 0; i < n; i++) {
    w.flipCard();
    w.rate(rating);
    await sleep(2);
  }
};

// ── strict order, meta for the review log
{
  const env = boot({ cards: [card('1'), card('2'), card('3')], server: { delay: 15 } });
  await env.start();
  env.w.revealHint();
  await rateAll(env.w, 3);
  await until(() => env.saved.length === 3);
  assert.deepEqual(env.saved.map((x) => x.id), ['1', '2', '3']);
  const m = env.saved[0].meta;
  assert.deepEqual([m.rating, m.state_before, m.hints, m.keywords], [4, 0, 1, 3]);
  assert.ok(Number.isFinite(m.duration_ms) && m.duration_ms >= 0 && m.duration_ms < 5000);
  assert.deepEqual(env.saved.map((x) => x.meta.hints), [1, 0, 0]);
  assert.equal(env.w.eval('saveQueue.length'), 0);
  console.log('ok   saves in order; meta (rating, state_before, hints, keywords, duration)');
}
// ── retry with backoff keeps the order; status pill; storage cleared
{
  const env = boot({ cards: [card('1'), card('2')], server: { failFirst: 3 } });
  await until(() => env.ev.includes('bootstrap'));
  env.w.eval('saveRetryBaseMs = 5');
  await env.start();
  await rateAll(env.w, 2);
  await until(() => env.ev.includes('fail:1'));
  assert.match(env.txt('save-status'), /unsaved, retrying/);
  assert.ok(env.$('save-status').classList.contains('error'));
  assert.ok(env.w.localStorage.getItem('fc-pending-saves').includes('"id":"1"'));
  await until(() => env.saved.length === 2, 3000);
  const seen = env.ev.filter((e) => /^(fail|save)/.test(e));
  assert.deepEqual(seen, ['fail:1', 'fail:1', 'fail:1', 'save:1', 'save:2']);
  assert.equal(env.$('save-status').style.display, 'none');
  assert.equal(env.w.localStorage.getItem('fc-pending-saves'), '[]');
  console.log('ok   failures retried in order, pill shown, storage cleared when done');
}
// ── unsaved ratings of a previous page load are replayed before the home read
{
  const pending = JSON.stringify([
    { id: 'p1', fsrs: { reps: 1, last_review: 'x1' }, meta: { rating: 3 } },
    { id: 'p2', fsrs: { reps: 1, last_review: 'x2' }, meta: { rating: 4 } },
  ]);
  const env = boot({ cards: [card('1')], storage: { 'fc-pending-saves': pending },
                     server: { delay: 10 } });
  await until(() => env.ev.includes('bootstrap'));
  assert.deepEqual(env.ev.filter((e) => e !== 'getDueCards'), ['save:p1', 'save:p2', 'bootstrap']);
  console.log('ok   persisted queue replayed on load, then bootstrap');
}
// ── home waits for saves; bootstrap cards reused; stale cache refetched
{
  const env = boot({ cards: [card('1')], server: { delay: 60 } });
  await env.start();
  const { w, ev } = env;
  const dueCalls = () => ev.filter((e) => e === 'getDueCards').length;
  assert.equal(dueCalls(), 0, 'start reuses the bootstrap cards');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  const before = ev.filter((e) => e === 'bootstrap').length;
  w.showHome();
  await sleep(20);
  const reads = () => ev.filter((e) => e === 'bootstrap').length;
  assert.equal(reads(), before, 'no read before the save landed');
  await until(() => ev.filter((e) => e === 'bootstrap').length === before + 1);
  assert.ok(ev.lastIndexOf('bootstrap') > ev.indexOf('save:1'));
  w.eval('homeAt = Date.now() - 10 * 60 * 1000');
  w.startSession();
  await until(() => ev.filter((e) => e === 'getDueCards').length === 1);
  console.log('ok   home waits for saves; cache reused; stale cache refetched');
}
// ── server ok:false (card deleted) is dropped, not retried forever
{
  const env = boot({ cards: [card('1')],
                     server: { reply: { ok: false, error: 'Card not found' } } });
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  await until(() => env.w.eval('saveQueue.length') === 0);
  assert.equal(env.ev.filter((e) => e === 'save:1').length, 1);
  console.log('ok   ok:false dropped after one attempt');
}
// ── beforeunload warns only while saving
{
  const env = boot({ cards: [card('1')], server: { delay: 80 } });
  await env.start();
  const { w } = env;
  w.flipCard();
  w.rate(4);
  await sleep(5);
  const busy = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(busy);
  assert.equal(busy.defaultPrevented, true);
  await until(() => w.eval('saveQueue.length') === 0);
  const idle = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false);
  console.log('ok   beforeunload guarded only while saving');
}
