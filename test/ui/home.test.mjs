// Run: node test/ui/home.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Home: forecast bars, reviewed today and streak. Session: the card-details panel.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

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
const plain = (x) => JSON.parse(JSON.stringify(x));
const home = async (options = {}) => {
  const env = boot({ cards: [card('1')], ...options });
  await until(() => env.shown('s-home'));
  await sleep(5);
  return env;
};
const bars = (env) => Array.from(env.w.document.querySelectorAll('#fc-bars .fc-col'));
const FORECAST = [5, 0, 3, 1, 0, 0, 2, ...Array(23).fill(0)];
FORECAST[29] = 4;

// ── forecast ────────────────────────────────────────────────────────────────
await test('forecast: seven bars, counts, today marked, heights relative to the max', async () => {
  const env = await home({ forecast: FORECAST });
  assert.equal(env.shown('forecast'), true);
  const cols = bars(env);
  assert.equal(cols.length, 7);
  assert.ok(cols[0].classList.contains('today'));
  assert.deepEqual(cols.map((c) => c.querySelector('.fc-num').textContent),
    ['5', '', '3', '1', '', '', '2'], 'zero days show no number');
  assert.deepEqual(cols.map((c) => c.classList.contains('has')),
    [true, false, true, true, false, false, true]);
  assert.equal(cols[0].querySelector('.fc-bar').style.height, '75%');
  assert.equal(cols[2].querySelector('.fc-bar').style.height, '45%');
  assert.equal(cols[1].querySelector('.fc-bar').style.height, '0%');
  assert.equal(cols[0].title, 'Today: 5 due');
  assert.equal(cols[1].title, 'Tomorrow: 0 due');
  assert.match(cols[2].title, /: 3 due$/);
  const label = env.$('fc-bars').getAttribute('aria-label');
  assert.equal(label,
    'Reviews due per day, next 7 days: today 5, +1 0, +2 3, +3 1, +4 0, +5 0, +6 2');
  assert.equal(env.$('fc-7').getAttribute('aria-pressed'), 'true');
});

await test('forecast: day labels follow the study day (before 04:00: yesterday)', async () => {
  const env = await home({ forecast: FORECAST });
  const lbls = Array.from(env.w.document.querySelectorAll('#fc-lbls span'),
    (s) => s.textContent);
  assert.equal(lbls[0], 'Today');
  const day = (k) => new Date((env.w.studyDay(new env.w.Date()) + k) * 86400000)
    .toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  assert.deepEqual(lbls.slice(1), [1, 2, 3, 4, 5, 6].map(day));
});

await test('forecast: 30 days, sparse labels; the choice is remembered', async () => {
  const env = await home({ forecast: FORECAST });
  env.$('fc-30').click();
  assert.equal(bars(env).length, 30);
  assert.equal(env.$('fc-30').getAttribute('aria-pressed'), 'true');
  assert.equal(env.$('fc-7').getAttribute('aria-pressed'), 'false');
  const lbls = Array.from(env.w.document.querySelectorAll('#fc-lbls span'));
  assert.deepEqual(lbls.map((s, k) => (s.textContent ? k : null)).filter((k) => k !== null),
    [0, 7, 14, 21, 28]);
  assert.equal(bars(env)[29].querySelector('.fc-num').textContent, '', 'no numbers at 30 days');
  assert.equal(bars(env)[29].classList.contains('has'), true);
  assert.equal(env.w.localStorage.getItem('fc-forecast-days'), '30');
  const again = await home({ forecast: FORECAST, storage: { 'fc-forecast-days': '30' } });
  assert.equal(bars(again).length, 30);
  env.$('fc-7').click();
  assert.equal(bars(env).length, 7);
});

await test('forecast: hidden without data or with an empty list; all zeros are fine', async () => {
  assert.equal((await home()).shown('forecast'), false);
  assert.equal((await home({ forecast: [] })).shown('forecast'), false);
  const zeros = await home({ forecast: Array(30).fill(0) });
  assert.equal(zeros.shown('forecast'), true);
  assert.equal(bars(zeros)[0].querySelector('.fc-bar').style.height, '0%');
});

await test('the server is told the client UTC offset for both calls', async () => {
  const env = await home({ forecast: FORECAST, activity: { today: 1, days: {} } });
  const offset = -new Date().getTimezoneOffset();
  assert.deepEqual(plain(env.srv.bootstrapArgs[0]), [offset]);
  assert.deepEqual(plain(env.srv.activityArgs[0]), [offset]);
});

// ── reviewed today, streak ──────────────────────────────────────────────────
await test('streak: unit cases', async () => {
  const env = await home();
  const s = (days, today) => env.w.currentStreak(days, today);
  assert.equal(s({ 98: 1, 99: 2, 100: 3 }, 100), 3);
  assert.equal(s({ 98: 1, 99: 2 }, 100), 2, 'today empty: alive until the day ends');
  assert.equal(s({ 97: 1, 99: 2, 100: 3 }, 100), 2, 'a gap ends it');
  assert.equal(s({ 90: 5 }, 100), 0);
  assert.equal(s({}, 100), 0);
  assert.equal(s({ 100: 1 }, 100), 1);
  assert.equal(s({ 99: 0, 100: 4 }, 100), 1, 'zero is no review');
  const long = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i, 1]));
  assert.equal(s(long, 399), 400);
});

await test('activity: reviewed today and the streak on Home', async () => {
  const text = async (activity) => (await home({ activity })).txt('home-activity');
  assert.equal(await text({ today: 100, days: { 98: 4, 99: 7, 100: 3 } }),
    'Reviewed today: 3 · 🔥 3-day streak');
  assert.equal(await text({ today: 100, days: { 98: 1, 99: 2 } }),
    'Reviewed today: 0 · 🔥 2-day streak (review today to keep it)');
  assert.equal(await text({ today: 100, days: { 90: 5 } }), 'Reviewed today: 0');
  assert.equal(await text({ today: 100, days: { 100: 1 } }), 'Reviewed today: 1 · 🔥 1-day streak');
});

await test('activity: hidden when the call fails or never answers; Home still works', async () => {
  const failing = await home({ activity: new Error('quota') });
  assert.equal(failing.shown('home-activity'), false);
  assert.equal(failing.$('startBtn').disabled, false);
  const silent = await home();
  assert.equal(silent.shown('home-activity'), false);
});

await test('Home asks again after a review session: activity refreshes', async () => {
  const env = await home({ activity: { today: 100, days: { 100: 1 } } });
  env.w.showHome();
  await until(() => env.shown('s-home'));
  await sleep(5);
  assert.equal(env.srv.activityArgs.length, 2);
});

// ── card details ────────────────────────────────────────────────────────────
const DAY = 86400000;
const SEEN = card('rev', 'foo;bar;baz', {
  state: 2, stability: 12.5, difficulty: 6.2, reps: 5, lapses: 1, scheduled_days: 10,
  last_review: new Date(Date.now() - 3 * DAY).toISOString(),
  due: new Date(Date.now() - DAY).toISOString(), weak_keywords: 'foo;bar', miss_streak: 2,
});
const rows = (env) => Object.fromEntries(Array.from(
  env.w.document.querySelectorAll('#inspector-body .insp-row'),
  (r) => [r.children[0].textContent, r.children[1].textContent]));
const table = (env) => Array.from(env.w.document.querySelectorAll('#inspector-body tr'),
  (tr) => Array.from(tr.children, (c) => c.textContent));

await test('details: the button toggles the panel, remembers it, and is announced', async () => {
  const env = await home();
  assert.equal(env.w.document.body.classList.contains('inspector-on'), false);
  assert.equal(env.$('inspectBtn').getAttribute('aria-pressed'), 'false');
  env.$('inspectBtn').click();
  assert.equal(env.w.document.body.classList.contains('inspector-on'), true);
  assert.equal(env.$('inspectBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(env.w.localStorage.getItem('fc-inspector'), '1');
  env.$('inspectBtn').click();
  assert.equal(env.w.localStorage.getItem('fc-inspector'), '');
  const on = await home({ storage: { 'fc-inspector': '1' } });
  assert.equal(on.w.document.body.classList.contains('inspector-on'), true);
  assert.equal(on.$('inspectBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(on.w.document.body.dataset.screen, 's-home');
});

await test('details: a Review card shows what the scheduler knows', async () => {
  const env = boot({ cards: [SEEN], storage: { 'fc-inspector': '1' } });
  await env.start();
  assert.equal(env.w.document.body.dataset.screen, 's-session');
  const r = rows(env);
  assert.equal(r.State, 'Review · 5 reviews, 1 lapses');
  assert.equal(r.Stability, '12.50 d');
  assert.equal(r.Difficulty, '6.20');
  const want = (100 * env.w.forgettingCurve(3, 12.5)).toFixed(1);
  assert.equal(r['Recall now'], `${want}% (3 d since review)`);
  assert.equal(r['Weak keywords'], 'foo;bar');
  assert.equal(r['Miss streak'], '2');
  assert.equal(r['Last interval'], env.w.formatInterval(10));
  assert.match(r.Settings, /^0\.94 retention, max 365 d, default weights$/);
});

await test('details: "now" equals the buttons; defaults are the built-in ones', async () => {
  const base = plain(boot({ cards: [] }).w.eval('W.slice()'));
  const personal = base.map((v, i) => (i === 8 ? v * 1.5 : i === 20 ? 0.3 : v));
  const env = boot({ cards: [SEEN], storage: { 'fc-inspector': '1' },
    config: { w: personal, retention: 0.94, max_interval: 365, overridden: ['w'],
      rejected: [] } });
  await env.start();
  const t = table(env);
  assert.deepEqual(t[0], ['If rated', 'now', 'defaults']);
  assert.deepEqual(t.slice(1).map((r) => r[0]), ['Again', 'Hard', 'Recap', 'Good', 'Easy']);
  const badge = (g) => env.txt('int-' + g);
  assert.deepEqual(t.slice(1).map((r) => r[1]), [1, 2, 1.5, 3, 4].map(badge));
  env.w.__card = SEEN;                       // DEFAULT_W is a const: reach it from inside the page
  const defaults = JSON.parse(env.w.eval(`JSON.stringify([1, 2, 1.5, 3, 4].map((g) =>
    withWeights(DEFAULT_W, () => formatInterval(nextInterval(window.__card, g, 0)))))`));
  assert.deepEqual(t.slice(1).map((r) => r[2]), defaults);
  assert.match(rows(env).Settings, /personal weights$/);
  assert.notDeepEqual(t.slice(1).map((r) => r[1]), t.slice(1).map((r) => r[2]),
    'personal weights change at least one interval');
  assert.deepEqual(plain(env.w.eval('W.slice()')), personal, 'W is restored after the preview');
});

await test('details: nothing is computed while closed; opening fills the panel', async () => {
  const env = boot({ cards: [SEEN] });
  await env.start();
  assert.equal(env.$('inspector-body').children.length, 0);
  env.$('inspectBtn').click();
  assert.equal(rows(env).Stability, '12.50 d');
});

await test('details: a new card and the next card update the panel', async () => {
  const env = boot({ cards: [card('n1'), SEEN], storage: { 'fc-inspector': '1' } });
  await env.start();
  const first = rows(env);
  assert.equal(first.State.startsWith('New'), true);
  assert.equal(first.Stability, '—');
  assert.equal(first['Recall now'], '—');
  assert.equal(first.Due, 'new');
  env.w.loadCard(1);
  assert.equal(rows(env).Stability, '12.50 d', 'follows the card on screen');
});

await test('details: the panel never shows card text as markup', async () => {
  const evil = card('x', 'k', { state: 2, stability: 5, difficulty: 5,
    weak_keywords: '<img src=x onerror=1>',
    last_review: new Date(Date.now() - DAY).toISOString() });
  const env = boot({ cards: [evil], storage: { 'fc-inspector': '1' } });
  await env.start();
  assert.equal(env.w.document.querySelector('#inspector img'), null);
  assert.equal(rows(env)['Weak keywords'], '<img src=x onerror=1>');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
