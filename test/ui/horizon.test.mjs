// Run: node test/ui/horizon.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Weights screen, "Horizon guard: cards already scheduled": check, pull forward, undo.
import assert from 'node:assert/strict';
import { boot, card, NOW, sleep, until } from './harness.mjs';

const plain = (x) => JSON.parse(JSON.stringify(x));
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
}

// A Review card last seen `daysAgo` days ago, scheduled `days` days, failed at 77 d with cap 65.45.
const lastSeen = (daysAgo) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(10, 0, 0, 0);
  return d;
};
function sched(id, daysAgo = 20, days = 134, extra = {}) {
  const last = lastSeen(daysAgo);
  const due = new Date(last);
  due.setDate(due.getDate() + days);
  due.setHours(4, 0, 0, 0);
  return { id, title: 'Title ' + id, state: 2, stability: 266, scheduled_days: days,
    last_review: last.toISOString(), due: due.toISOString(), ok_days: 32, fail_days: 77,
    cap_days: 65.45, ...extra };
}
async function open(options = {}) {
  const env = boot({ cards: [card('1')], ...options });
  await until(() => env.shown('s-home'));
  env.$('weightsBtn').click();
  await until(() => env.shown('s-weights'));
  return env;
}
const check = async (env) => {
  env.$('hz-check').click();
  await sleep(30);
};
const rows = (env) => [...env.w.document.querySelectorAll('#hz-list .hz-row')];

await test('check lists cards scheduled past the cap, soonest first; nothing is written', async () => {
  const env = await open({ horizonCards: [
    sched('a', 20, 134), sched('b', 40, 200), sched('c', 20, 50),            // c: within its cap
    sched('d', 20, 134, { cap_days: '' }),                                    // no cap
  ] });
  await check(env);
  assert.match(env.txt('hz-result'), /^2 cards are scheduled past the cap/);
  const found = rows(env);
  assert.equal(found.length, 2);
  const pull = (c) => env.w.horizonPull(c, new Date(NOW));
  const a = pull(sched('a', 20, 134));
  const b = pull(sched('b', 40, 200));
  assert.ok(b.due < a.due, 'b (cap day earlier) comes first');
  assert.equal(found[0].querySelector('.hz-title').textContent, 'Title b');
  assert.equal(found[0].querySelector('.hz-meta').textContent,
    `failed ✗ 77 d · 200 d → 65 d · due ${env.w.fmtDay(sched('b', 40, 200).due)} → ${env.w.fmtDay(b.due)}`);
  assert.equal(env.$('hz-apply').hidden, false);
  assert.equal(env.$('hz-undo').hidden, true);
  assert.equal(env.srv.horizonCalls.length, 0, 'a check never writes');
  env.w.close();
});

await test('pull forward sends the changes with the read version; undo sends the old values', async () => {
  const cards = [sched('a', 20, 134), sched('b', 40, 200), sched('c', 30, 300)];
  const reply = { ok: true, applied: ['a', 'b'], stale: 1, missing: 0, invalid: 0 };
  const env = await open({ horizonCards: cards, applyHorizon: () => reply });
  await check(env);
  env.$('hz-apply').click();
  await sleep(30);
  const [sent] = plain(env.srv.horizonCalls);
  assert.equal(sent.length, 3);
  const a = sent.find((c) => c.id === 'a');
  const pull = env.w.horizonPull(cards[0], new Date(NOW));
  assert.deepEqual(a, { id: 'a', last_review: cards[0].last_review, due: pull.due,
    scheduled_days: 65, stability: pull.stability });
  assert.equal(env.txt('hz-result'), 'Pulled forward 2 cards. Skipped: 1 reviewed since.');
  assert.equal(rows(env).length, 0, 'the list is cleared');
  assert.equal(env.$('hz-apply').hidden, true);
  assert.equal(env.$('hz-undo').hidden, false);

  env.$('hz-undo').click();
  await sleep(30);
  const back = plain(env.srv.horizonCalls[1]);
  assert.deepEqual(back.map((c) => c.id).sort(), ['a', 'b'], 'only the cards that were changed');
  assert.deepEqual(back.find((c) => c.id === 'a'), { id: 'a', last_review: cards[0].last_review,
    due: cards[0].due, scheduled_days: 134, stability: 266 });
  assert.equal(env.txt('hz-result'), 'Restored 2 cards. Skipped: 1 reviewed since.');
  assert.equal(env.$('hz-undo').hidden, true);
  env.w.close();
});

await test('no candidates, guard off, server errors and a rejected apply', async () => {
  const none = await open({ horizonCards: [sched('c', 20, 50)] });
  await check(none);
  assert.match(none.txt('hz-result'), /^No card is scheduled past its cap\./);
  assert.equal(none.$('hz-apply').hidden, true);
  none.w.close();

  const off = await open({ config: () => ({ horizon_guard: false }), horizonCards: [sched('a')] });
  await check(off);
  assert.equal(off.txt('hz-result'), 'Turn the horizon guard on first.');
  assert.equal(rows(off).length, 0);
  off.w.close();

  const bad = await open({ horizonCards: new Error('offline') });
  await check(bad);
  assert.equal(bad.txt('hz-result'), 'Could not check: offline');
  assert.equal(bad.$('hz-check').disabled, false, 'the button works again');
  bad.w.close();

  const refused = await open({ horizonCards: [sched('a')],
    applyHorizon: () => ({ ok: false, error: 'too long' }) });
  await check(refused);
  refused.$('hz-apply').click();
  await sleep(30);
  assert.equal(refused.txt('hz-result'), 'Rejected: too long');
  assert.equal(rows(refused).length, 1, 'the list stays for a retry');
  assert.equal(refused.$('hz-apply').hidden, false);
  refused.w.close();
});

await test('a long list shows the first 30 and counts the rest', async () => {
  const many = Array.from({ length: 33 }, (_, i) => sched('m' + i, 20 + i, 134 + i));
  const env = await open({ horizonCards: many });
  await check(env);
  assert.equal(rows(env).length, 30);
  assert.equal(env.w.document.querySelector('#hz-list > .hz-meta').textContent, '… and 3 more');
  assert.match(env.txt('hz-result'), /^33 cards are scheduled past the cap/);
  env.w.close();
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
