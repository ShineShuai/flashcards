// Run: node test/ui/recall-screen.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Recall screen: every card, most urgent first, filters, bar, paging, errors.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

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

// The app counts days from ROLLOVER_HOUR (studyDay): before 04:00 it is still yesterday's
// study day. A fixture `daysAgo` study days back is dated from the current study day, so
// daysBetween(at(n), now) is n at any time of day (a plain "today minus n" at 10:00 was n - 1
// between 00:00 and 04:00, and the tests failed then).
const ROLLOVER_HOUR = 4;
const at = (daysAgo, hour = 10) => {
  const d = new Date(Date.now() - ROLLOVER_HOUR * 3600000);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
// A Review card seen `ago` days back, due `dueIn` days from now (negative: overdue).
const review = (title, ago, dueIn, extra = {}) => ({
  id: title, title, state: 2, stability: 60, scheduled_days: 38, reps: 5, lapses: 0,
  last_review: at(ago), due: at(-dueIn, 4), ok_days: 0, fail_days: 0, cap_days: 0, trail: '',
  ...extra,
});
const ROWS = [
  review('safe-a-recent', 5, 30),
  review('safe-b-older', 20, 30),
  review('watch', 10, 30, { fail_days: 77, cap_days: 65.45, ok_days: 32,
    trail: '1:G 4:G 12:G 32:G 77:H' }),
  review('due', 40, -2),
  review('past', 40, 30, { fail_days: 30, ok_days: 10, trail: '10:G 30:H' }),
  { id: 'learn', title: 'learn', state: 1, stability: 1, scheduled_days: 0, last_review: at(0),
    due: at(0), ok_days: 0, fail_days: 0, cap_days: 0, trail: '' },
  { id: 'new', title: 'new', state: 0 },
];
async function open(options = {}) {
  const env = boot({ cards: [card('1')], recallRows: ROWS, ...options });
  await until(() => env.shown('s-home'));
  env.$('recallBtn').click();
  await until(() => env.shown('s-recall'));
  await sleep(20);
  return env;
}
const titles = (env) => [...env.w.document.querySelectorAll('#rc-list .rc-title')]
  .map((el) => el.textContent);
const filters = (env) => [...env.w.document.querySelectorAll('#rc-filters button')];

await test('fixtures: at(n) is n study days back at any time of day (same rollover as the app)', async () => {
  const env = await open({ recallRows: [] });
  assert.equal(env.w.eval('ROLLOVER_HOUR'), ROLLOVER_HOUR);
  const realNow = Date.now;
  try {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(2026, 10, 23, hour, 30);                 // local 23 Nov, hh:30
      Date.now = () => now.getTime();
      for (const n of [0, 1, 40]) {
        assert.equal(env.w.daysBetween(new Date(at(n)), now), n, `${hour}:30, ${n} days`);
      }
    }
  } finally {
    Date.now = realNow;
  }
  env.w.close();
});

await test('every card, most urgent first, with the counts per status', async () => {
  const env = await open();
  assert.deepEqual(titles(env),
    ['past', 'due', 'watch', 'safe-b-older', 'safe-a-recent', 'learn', 'new']);
  assert.equal(env.txt('rc-summary'),
    '7 cards · Past horizon 1 · Due 1 · Watch 1 · Safe 2 · Learning 1 · New 1');
  assert.deepEqual(filters(env).map((b) => b.textContent),
    ['All 7', 'Past horizon 1', 'Due 1', 'Watch 1', 'Safe 2', 'Learning 1', 'New 1']);
  assert.equal(filters(env)[0].getAttribute('aria-pressed'), 'true');
  const chips = [...env.w.document.querySelectorAll('#rc-list .rc-chip')];
  assert.equal(chips[0].textContent, 'Past horizon');
  assert.ok(chips[0].classList.contains('past'));
  env.w.close();
});

await test('a row shows the recall strip and a bar: recalled, horizon somewhere, beyond', async () => {
  const env = await open();
  const row = env.w.document.querySelector('#rc-list .rc-row');          // past
  const strip = row.querySelector('.recall-strip').textContent;
  assert.match(strip, /gap 4\d d · recall now \d+%/);
  assert.match(strip, /failed ✗ 30 d/);
  assert.match(strip, /best ✓ 10 d/);
  const gap = env.w.daysBetween(new Date(ROWS[4].last_review), new Date());
  const top = Math.max(gap, 10, 30, 38, 1) * 1.1;
  const pct = (x) => (100 * x / top).toFixed(1) + '%';
  const seg = (kind) => row.querySelector('.rc-seg.' + kind);
  assert.equal(seg('ok').style.width, pct(10));
  assert.equal(seg('unk').style.left, pct(10));
  assert.equal(seg('unk').style.width, (100 * 20 / top).toFixed(1) + '%');
  assert.equal(seg('bad').style.left, pct(30));
  assert.equal(row.querySelector('.rc-mark.now').style.left, pct(gap));
  assert.equal(row.querySelector('.rc-mark.plan').style.left, pct(38));
  assert.equal(row.querySelector('.rc-track').getAttribute('aria-label'),
    `gap ${gap} d, planned 38 d, best 10 d, failed 30 d`);
  const rowOf = (title) => [...env.w.document.querySelectorAll('#rc-list .rc-row')]
    .find((r) => r.querySelector('.rc-title').textContent === title);
  assert.equal(rowOf('new').querySelector('.rc-track'), null, 'no bar before the first review');
  assert.equal(rowOf('learn').querySelector('.rc-track'), null, 'no bar in short steps');
  env.w.close();
});

await test('filters narrow the list; All brings everything back', async () => {
  const env = await open();
  filters(env)[2].click();                                                // Due
  assert.deepEqual(titles(env), ['due']);
  assert.equal(filters(env)[2].getAttribute('aria-pressed'), 'true');
  assert.equal(filters(env)[0].getAttribute('aria-pressed'), 'false');
  filters(env)[4].click();                                                // Safe
  assert.deepEqual(titles(env), ['safe-b-older', 'safe-a-recent']);
  filters(env)[0].click();
  assert.equal(titles(env).length, 7);
  env.w.close();
});

await test('equal risk: titles decide', async () => {
  const same = ['b', 'c', 'a'].map((t) => review(t, 5, 30));
  const env = await open({ recallRows: same });
  assert.deepEqual(titles(env), ['a', 'b', 'c']);
  env.w.close();
});

await test('50 rows at a time; Show more adds the rest', async () => {
  const many = Array.from({ length: 55 }, (_, i) => review('c' + String(i).padStart(2, '0'), 3, 30));
  const env = await open({ recallRows: many });
  assert.equal(titles(env).length, 50);
  assert.equal(env.$('rc-more').hidden, false);
  env.$('rc-more').click();
  assert.equal(titles(env).length, 55);
  assert.equal(env.$('rc-more').hidden, true);
  filters(env)[0].click();
  assert.equal(titles(env).length, 50, 'a filter change starts at the first page again');
  env.w.close();
});

await test('titles are text; an empty deck; errors and Reload; Home', async () => {
  const env = await open({ recallRows: [review('<b>bold</b>', 3, 30)] });
  assert.equal(titles(env)[0], '<b>bold</b>');
  assert.equal(env.w.document.querySelector('#rc-list .rc-title b'), null);
  env.w.close();

  const empty = await open({ recallRows: [] });
  assert.equal(empty.txt('rc-summary'), '0 cards');
  assert.equal(titles(empty).length, 0);
  empty.w.close();

  const bad = await open({ recallRows: new Error('offline') });
  assert.equal(bad.txt('rc-summary'), 'Could not load: offline');
  assert.equal(bad.$('rc-reload').disabled, false);
  const calls = bad.srv.recallCalls;
  bad.$('rc-reload').click();
  await sleep(30);
  assert.equal(bad.srv.recallCalls, calls + 1, 'Reload asks the server again');
  bad.w.document.querySelector('#s-recall .btn[onclick="showHome()"]').click();
  await until(() => bad.shown('s-home'));
  bad.w.close();
});


// ── Review ahead
const full = (row) => ({ ...row, keywords: 'a;b;c', back_content: 'B' + row.id,
  back_type: 'text' });
await test('Review ahead: the button counts cards near their failed gap, not due', async () => {
  const env = await open();
  assert.equal(env.$('rc-ahead').hidden, false);
  assert.equal(env.$('rc-ahead').textContent, 'Review ahead (1)');
  assert.equal(env.txt('rc-ahead-note'),
    '1 card is not due yet but within 25% of the gap where you failed. The closest come first.');
  env.w.close();

  const none = await open({ recallRows: ROWS.filter((r) => r.id !== 'past') });
  assert.equal(none.$('rc-ahead').hidden, true, 'nobody near a failed gap: no button');
  assert.equal(none.$('rc-ahead-note').hidden, true);
  none.w.close();
});

await test('Review ahead: asks for the closest 50 with their version, then starts', async () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    review('a' + String(i).padStart(2, '0'), 30 + i, 30, { fail_days: 40 }));
  const env = await open({ recallRows: many, aheadCards: (refs) =>
    refs.map((r) => full(many.find((m) => m.id === r.id))) });
  assert.equal(env.$('rc-ahead').textContent, 'Review ahead (50)');
  assert.match(env.txt('rc-ahead-note'), /^60 cards are not due yet/);
  env.$('rc-ahead').click();
  await until(() => env.shown('s-session'));
  const refs = plain(env.srv.aheadCalls[0]);
  assert.equal(refs.length, 50);
  assert.deepEqual(refs.slice(0, 3).map((r) => r.id), ['a59', 'a58', 'a57'], 'furthest first');
  assert.deepEqual(refs[0], { id: 'a59', last_review: many[59].last_review });
  assert.equal(env.w.eval('deck.length'), 50);
  assert.equal(env.w.eval('deck[0].id'), 'a59');
  assert.equal(env.w.eval('sessionTotal'), 50);
  env.w.close();
});

await test('Review ahead: the card shows its record in the session', async () => {
  const env = await open({ aheadCards: () => [full(ROWS[4])] });
  env.$('rc-ahead').click();
  await until(() => env.shown('s-session'));
  const strip = env.w.document.querySelector('.recall-strip').textContent;
  assert.match(strip, /gap 4\d d · recall now \d+% · planned 38 d/);
  assert.match(strip, /failed ✗ 30 d/);
  env.w.close();
});

await test('Review ahead: cards reviewed since, and errors, keep you on the screen', async () => {
  const since = await open({ aheadCards: () => [] });
  since.$('rc-ahead').click();
  await sleep(40);
  assert.equal(since.txt('rc-summary'),
    'Those cards were reviewed since. Reload to see where they stand.');
  assert.equal(since.shown('s-recall'), true);
  assert.equal(since.$('rc-ahead').disabled, false);
  since.w.close();

  const bad = await open({ aheadCards: () => new Error('offline') });
  bad.$('rc-ahead').click();
  await sleep(40);
  assert.equal(bad.txt('rc-summary'), 'Could not load the cards: offline');
  assert.equal(bad.shown('s-recall'), true);
  assert.equal(bad.$('rc-ahead').disabled, false);
  bad.w.close();
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
