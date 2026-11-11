// Run: node test/ui/weights.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// The weights screen: review-log export, Check against held-out reviews, apply,
// restore and reset, with the review log of the py-fsrs golden vectors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, card, sleep, until } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, '..', 'fsrs-golden.json'), 'utf8'));
const DEFAULT = golden.sets[0].parameters;
const OTHER = DEFAULT.map((v, i) => (i < 4 ? 0.1 : v));      // tiny initial stabilities
const plain = (x) => JSON.parse(JSON.stringify(x));
const COLUMNS = ['review_time', 'card_id', 'rating', 'state_before', 'elapsed_days',
  'scheduled_days', 'stability', 'difficulty', 'hints', 'keywords', 'duration_ms'];
const sheetRows = (rows) => rows.map(([t, c, g, st, el, s, d]) =>
  [new Date(t).toISOString(), c, g, st, el, 1, s, d, 0, 0, 0]);
const LOG = { columns: COLUMNS, rows: sheetRows(golden.replay.rows) };
// the same log three times over (other card ids): enough scored reviews for the 20% default
const BIG = {
  columns: COLUMNS,
  rows: [0, 1, 2].flatMap((k) => LOG.rows.map((r) => [r[0], `${r[1]}#${k}`, ...r.slice(2)])),
};
// a fit trained on the first 30%: 70% of the scored reviews are held out
const scoredTimes = golden.replay.rows.filter((r) => r[3] === 2 && r[4] >= 1)
  .map((r) => r[0]).sort((a, b) => a - b);
const N_ROWS = golden.replay.rows.length;
const N_SCORED = golden.replay.n_scored;
const N_HELD = golden.replay.results.default.held_out.n;   // the app's 20% default
const TRAIN_UNTIL = new Date(scoredTimes[Math.floor(scoredTimes.length * 0.3)]).toISOString();

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

// Which of two weight vectors predicts a log better, as the app's replay measures it
// (its replay equals py-fsrs on the golden vectors; here only the screen is tested).
const probe = boot({ cards: [card('1')] });
await until(() => probe.shown('s-home'));
function rank(log, cut) {
  const rows = probe.w.parseReviewLog(plain(log));
  const loss = (w) => probe.w.replayLoss(rows, w, cut(rows)).logloss;
  return loss(DEFAULT) < loss(OTHER) ? { better: DEFAULT, worse: OTHER }
    : { better: OTHER, worse: DEFAULT };
}
const SPLIT = rank(LOG, () => Date.parse(TRAIN_UNTIL));
const SPLIT_BIG = rank(BIG, (rows) => probe.w.holdoutCut(rows));

// The app with `current` weights in force, the weights screen open and its log loaded.
async function open(options = {}) {
  const { current = DEFAULT, personal = false, rejected = [], history = [] } = options;
  const config = { w: current, retention: 0.94, max_interval: 365,
    overridden: personal ? ['w'] : [], rejected };
  const env = boot({
    cards: [card('1')], config, reviewLog: options.log || LOG, weightsHistory: history,
    saveSettings: (patch) => ({ ok: true, config: { ...config, w: patch.w || DEFAULT,
      overridden: patch.w ? ['w'] : [] } }),
    ...options.boot,
  });
  await until(() => env.shown('s-home'));
  env.$('weightsBtn').click();
  await until(() => env.shown('s-weights'));
  await until(() => /reviews logged|Could not read/.test(env.txt('w-log-info')));
  return env;
}
const check = async (env, value) => {
  env.$('w-input').value = typeof value === 'string' ? value : JSON.stringify(value);
  env.$('w-check').click();
  await sleep(5);
};
const weightsOf = (env) => plain(env.w.eval('W.slice()'));

await test('the gear button opens the screen; it describes the log and the status', async () => {
  const env = await open();
  assert.ok(env.txt('w-log-info').startsWith(
    `${N_ROWS} reviews logged, ${N_SCORED} can be scored`), env.txt('w-log-info'));
  assert.match(env.txt('w-log-info'), /newest 20%, after 20\d\d-\d\d-\d\d, are held out/);
  assert.equal(env.txt('w-status'), 'Using the default weights.');
  assert.equal(env.shown('w-reset'), false);
  assert.equal(env.$('w-apply').disabled, true);
  assert.equal(env.$('w-export').disabled, false);
});

await test('weights from an older version are reported, not silently dropped', async () => {
  const env = await open({ rejected: [{ key: 'w', reason: 'expected 21 values' }] });
  assert.match(env.txt('w-status'), /ignored \(expected 21 values\)/);
});

await test('export: a CSV of the whole log, header first, as review_log.csv', async () => {
  const env = await open();
  const lines = env.w.toCsv(LOG).trimEnd().split('\n');
  assert.equal(lines[0], COLUMNS.join(','));
  assert.equal(lines.length, 1 + LOG.rows.length);
  assert.equal(lines[1].split(',')[1], LOG.rows[0][1]);
  assert.equal(env.w.toCsv({ columns: ['a'], rows: [['x,y'], ['q"r'], ['l\nm']] }),
    'a\n"x,y"\n"q""r"\n"l\nm"\n');
  const made = [];
  const clicked = [];
  env.w.URL.createObjectURL = (blob) => (made.push(blob), 'blob:log');
  env.w.HTMLAnchorElement.prototype.click = function click() {
    clicked.push({ href: this.href, download: this.download });
  };
  env.$('w-export').click();
  assert.equal(made.length, 1);
  assert.equal(made[0].type, 'text/csv');
  assert.deepEqual(clicked, [{ href: 'blob:log', download: 'review_log.csv' }]);
});

await test('Check: a better candidate with train_until is applicable; numbers shown', async () => {
  const env = await open({ current: SPLIT.worse, personal: true });
  await check(env, { w: SPLIT.better, train_until: TRAIN_UNTIL, source: 'fsrs 6.3.2' });
  const text = env.txt('w-result');
  assert.match(text, /^\d+ held-out reviews\. Log loss: current 0\.\d{4}, candidate 0\.\d{4} \(−/);
  assert.match(text, /Predicted recall \d+\.\d%, actual \d+\.\d%\./);
  assert.match(text, /Better than the current weights\.$/);
  assert.equal(text.includes('train_until'), false, 'no optimism warning with train_until');
  assert.equal(env.$('w-apply').disabled, false);
  const n = Number(text.match(/^(\d+)/)[1]);
  assert.ok(n >= 200 && n < N_SCORED, String(n));
});

await test('Check: a worse candidate can not be applied', async () => {
  const env = await open({ current: SPLIT.better });
  await check(env, { w: SPLIT.worse, train_until: TRAIN_UNTIL });
  assert.match(env.txt('w-result'), /\(\+\d/);
  assert.match(env.txt('w-result'), /Not better than the current weights\.$/);
  assert.equal(env.$('w-apply').disabled, true);
});

await test('Check: without train_until the gain is flagged as optimistic', async () => {
  const env = await open({ current: SPLIT_BIG.worse, personal: true, log: BIG });
  await check(env, SPLIT_BIG.better);                // a bare array of weights
  assert.match(env.txt('w-result'), /No "train_until"/);
  assert.match(env.txt('w-result'), /--holdout/);
});

await test('Check: too few held-out reviews: at least 200 are needed', async () => {
  const env = await open({ current: SPLIT.worse, personal: true });
  await check(env, { w: SPLIT.better });             // the 20% default hold-out is small
  assert.match(env.txt('w-result'),
    new RegExp(`^Only ${N_HELD} reviews to check against after .*at least 200`));
  assert.equal(env.$('w-apply').disabled, true);
});

await test('Check: bad input is explained; a passed check is withdrawn by a bad one', async () => {
  const env = await open({ current: SPLIT.worse, personal: true });
  const bad = [['{oops', /not valid JSON/], [[1, 2, 3], /Expected 21 numbers/],
    [{ w: DEFAULT.map(String) }, /Expected 21 numbers/],
    [{ w: [...DEFAULT.slice(1), null] }, /Expected 21/],
    [{ w: DEFAULT, train_until: 'tomorrow-ish' }, /not a date/], ['null', /Expected 21/]];
  for (const [input, message] of bad) {
    await check(env, input);
    assert.match(env.txt('w-result'), message, JSON.stringify(input));
    assert.equal(env.$('w-apply').disabled, true);
  }
  await check(env, { w: SPLIT.better, train_until: TRAIN_UNTIL });
  assert.equal(env.$('w-apply').disabled, false);
  await check(env, '{oops');                         // a new, bad Check withdraws the old one
  assert.equal(env.$('w-apply').disabled, true);
});

await test('Apply: saves w with the check as meta; the app uses it at once', async () => {
  const env = await open({ current: SPLIT.worse, personal: true, boot: {
    saveSettings: (patch) =>
      ({ ok: true, config: { w: patch.w, overridden: ['w'], rejected: [] } }),
  } });
  await check(env, { w: SPLIT.better, train_until: TRAIN_UNTIL, source: 'fsrs 6.3.2' });
  env.$('w-apply').click();
  await sleep(10);
  const [call] = env.srv.settingsCalls;
  assert.deepEqual(plain(call.patch), { w: SPLIT.better });
  assert.equal(call.meta.source, 'fsrs 6.3.2');
  assert.equal(call.meta.note, 'held-out check');
  assert.ok(call.meta.n_reviews >= 200);
  assert.ok(call.meta.loss_after < call.meta.loss_before);
  assert.match(env.txt('w-result'), /^Saved\./);
  assert.equal(env.txt('w-status'), 'Using your personal weights.');
  assert.deepEqual(weightsOf(env), SPLIT.better);
  assert.equal(env.$('w-apply').disabled, true);
});

await test('Apply: a rejection or a failure leaves the weights alone and says so', async () => {
  const rejecting = await open({ current: SPLIT.worse, personal: true, boot: {
    saveSettings: () => ({ ok: false, errors: { w: 'w[7] outside 0.001–0.75' } }) } });
  await check(rejecting, { w: SPLIT.better, train_until: TRAIN_UNTIL });
  rejecting.$('w-apply').click();
  await sleep(10);
  assert.match(rejecting.txt('w-result'), /^Rejected: .*w\[7\]/);
  assert.deepEqual(weightsOf(rejecting), SPLIT.worse);
  const failing = await open({ current: SPLIT.worse, personal: true,
    boot: { saveSettings: () => new Error('quota') } });
  await check(failing, { w: SPLIT.better, train_until: TRAIN_UNTIL });
  failing.$('w-apply').click();
  await sleep(10);
  assert.equal(failing.txt('w-result'), 'Could not save: quota');
  assert.deepEqual(weightsOf(failing), SPLIT.worse);
});

await test('History: newest first, Restore where weights exist; Restore saves them', async () => {
  const history = [
    { time: '2026-11-10T08:00:00.000Z', n_reviews: null, w: null, loss_before: null,
      loss_after: null, source: 'app', note: 'back to defaults' },
    { time: '2026-11-09T07:30:00.000Z', n_reviews: 412, w: OTHER, loss_before: 0.31,
      loss_after: 0.29, source: 'optimizer', note: 'held-out check' },
  ];
  const env = await open({ current: DEFAULT, history, boot: {
    saveSettings: (patch) =>
      ({ ok: true, config: { w: patch.w, overridden: ['w'], rejected: [] } }),
  } });
  await sleep(5);
  const rows = Array.from(env.w.document.querySelectorAll('#w-history .w-row'));
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /^2026-11-10 08:00 · app · defaults$/);
  assert.equal(rows[0].querySelector('button'), null);
  assert.match(rows[1].textContent,
    /2026-11-09 07:30 · optimizer · 412 reviews · log loss 0\.31 → 0\.29/);
  rows[1].querySelector('button').click();
  await sleep(10);
  const [call] = env.srv.settingsCalls;
  assert.deepEqual(plain(call.patch), { w: OTHER });
  assert.equal(call.meta.source, 'rollback');
  assert.match(call.meta.note, /^restored 2026-11-09T07:30/);
  assert.deepEqual(weightsOf(env), OTHER);
});

await test('History text from the sheet is shown as text, never as markup', async () => {
  const env = await open({ history: [{ time: '2026-11-09T07:30:00.000Z', n_reviews: 1, w: null,
    loss_before: null, loss_after: null, source: '<img src=x onerror=1>', note: '' }] });
  await sleep(5);
  assert.equal(env.w.document.querySelector('#w-history img'), null);
  assert.match(env.txt('w-history'), /<img src=x onerror=1>/);
});

await test('Back to defaults: visible only with personal weights; saves w = null', async () => {
  const env = await open({ current: OTHER, personal: true });
  assert.equal(env.shown('w-reset'), true);
  env.$('w-reset').click();
  await sleep(10);
  assert.deepEqual(plain(env.srv.settingsCalls[0].patch), { w: null });
  assert.equal(env.srv.settingsCalls[0].meta.note, 'back to defaults');
  assert.equal(env.txt('w-status'), 'Using the default weights.');
  assert.deepEqual(weightsOf(env), DEFAULT);
  assert.equal(env.shown('w-reset'), false);
});

await test('an unreadable or empty log is explained and nothing breaks', async () => {
  const bad = boot({ cards: [card('1')], reviewLog: new Error('no sheet') });
  await until(() => bad.shown('s-home'));
  bad.$('weightsBtn').click();
  await until(() => /Could not read/.test(bad.txt('w-log-info')));
  await check(bad, { w: DEFAULT });
  assert.match(bad.txt('w-result'), /not loaded yet/);
  const empty = boot({ cards: [card('1')] });
  await until(() => empty.shown('s-home'));
  empty.$('weightsBtn').click();
  await until(() => /0 reviews logged/.test(empty.txt('w-log-info')));
  assert.equal(empty.$('w-export').disabled, true);
  await check(empty, { w: DEFAULT });
  assert.match(empty.txt('w-result'), /^Only 0 reviews to check against after the end of the log/);
});

await test('Home is one tap away; the screen reloads its data on every visit', async () => {
  const env = await open();
  await check(env, { w: DEFAULT });
  env.w.showHome();
  await until(() => env.shown('s-home'));
  env.$('weightsBtn').click();
  await until(() => /reviews logged/.test(env.txt('w-log-info')));
  assert.equal(env.txt('w-result'), '');
  assert.equal(env.$('w-apply').disabled, true);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
