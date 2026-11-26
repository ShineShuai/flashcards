// Run: node test/ui/home-wait.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Home watches the clock: countdown to sub-day cards, silent refresh when a card is due.
import assert from 'node:assert/strict';
import { boot, card, NOW, sleep, stubAudio, until } from './harness.mjs';

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

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const inMin = (n) => iso(NOW.getTime() + n * MIN);
const TEN = /^Next: 1 card in (10:00|9:5\d)\. Updates by itself\.$/;

const tap = (w) => w.document.dispatchEvent(new w.Event('pointerdown'));
const hide = (w, hidden) => Object.defineProperty(w.document, 'hidden', { configurable: true, value: hidden });
const home = async (options) => {
  const env = boot(options);
  await until(() => env.shown('s-home'));
  await sleep(5);
  return env;
};
const bootstraps = (env) => env.ev.filter((e) => e === 'bootstrap').length;

await test('countdown on Home only while sub-day cards wait; it ticks', async () => {
  const env = await home({ cards: [], upcoming: { waiting: [inMin(10)], nextDue: inMin(10) } });
  assert.equal(env.shown('home-wait'), true);
  assert.match(env.txt('home-wait'), TEN);
  assert.equal(env.$('startBtn').disabled, true);
  assert.equal(env.txt('startBtn').trim(), '✓  Nothing due');
  env.clock.advance(61 * 1000);
  await until(() => /in 8:5\d\./.test(env.txt('home-wait')), 3000);

  const rollover = await home({ cards: [], upcoming: { waiting: [], nextDue: inMin(24 * 60) } });
  assert.equal(rollover.shown('home-wait'), false, 'a card due tomorrow is no countdown');
  assert.notEqual(rollover.w.eval('waitTimer'), null, 'but Home still watches for it');

  const older = await home({ cards: [] });   // a server without the new fields
  assert.equal(older.shown('home-wait'), false);
  assert.equal(older.w.eval('waitTimer'), null, 'nothing to watch');
});

await test('a sub-day card comes due: count, button, beep and title update by themselves', async () => {
  const cards = [];
  let up = { waiting: [inMin(10)], nextDue: inMin(10) };
  const env = await home({ cards, upcoming: () => up });
  const log = stubAudio(env.w);
  const base = env.w.document.title;
  tap(env.w);                                  // the gesture that unlocks the audio
  assert.equal(log.created, 1);
  hide(env.w, true);
  assert.equal(bootstraps(env), 1);

  cards.push(card('1'));                       // what the server will now report as due
  up = { waiting: [], nextDue: null };
  env.clock.advance(10 * MIN + 1000);
  await until(() => env.txt('stat-due') === '1', 3500);
  assert.equal(env.shown('s-home'), true, 'no spinner, no screen change');
  assert.equal(bootstraps(env), 2);
  assert.equal(env.txt('startBtn').trim(), '▶  Start Review (1)');
  assert.equal(env.$('startBtn').disabled, false);
  assert.equal(env.shown('home-wait'), false);
  assert.equal(env.w.eval('waitTimer'), null, 'nothing left to watch');
  assert.equal(log.osc.map((o) => o.frequency.value).join(), '660,880', 'two-tone beep');
  assert.equal(env.w.document.title, '● Card due · ' + base);

  hide(env.w, false);
  env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
  assert.equal(env.w.document.title, base);
  env.w.startSession();                        // the refreshed cards are used, no second read
  assert.equal(env.shown('s-session'), true);
  assert.equal(env.txt('card-title'), 'T1');
  assert.equal(env.ev.includes('getDueCards'), false);
});

await test('study-day rollover: the counts refresh silently, no beep, title untouched', async () => {
  const cards = [];
  let up = { waiting: [], nextDue: inMin(24 * 60) };
  const env = await home({ cards, upcoming: () => up });
  const log = stubAudio(env.w);
  const base = env.w.document.title;
  tap(env.w);
  hide(env.w, true);
  cards.push(card('1'), card('2'));
  up = { waiting: [], nextDue: null };
  env.clock.advance(24 * 60 * MIN + 1000);
  await until(() => env.txt('stat-due') === '2', 3500);
  assert.equal(log.osc.length, 0);
  assert.equal(env.w.document.title, base);
  assert.equal(env.w.eval('waitTimer'), null);
});

await test('the server clock is behind: one read per retry period, not a loop', async () => {
  const stale = iso(NOW.getTime() - 1000);
  const env = await home({ cards: [], upcoming: { waiting: [stale], nextDue: stale } });
  await sleep(2500);
  assert.equal(bootstraps(env), 1, 'retry waits for the period');
  env.clock.advance(6000);
  await until(() => bootstraps(env) === 2, 3000);
  await sleep(1500);
  assert.equal(bootstraps(env), 2, 'and waits again');
});

await test('leaving Home stops the watch; a late refresh does not pull the person back', async () => {
  const env = await home({ cards: [card('1')], upcoming: { waiting: [inMin(10)], nextDue: inMin(10) } });
  assert.notEqual(env.w.eval('waitTimer'), null);
  env.w.eval('fetchHome({ silent: true })');   // a refresh is in flight...
  env.w.startSession();                        // ...when the person starts reviewing
  assert.equal(env.w.eval('waitTimer'), null);
  await sleep(30);
  assert.equal(env.shown('s-session'), true, 'the answer is dropped');
  assert.equal(env.w.eval('homeFetching'), false);
});

await test('done screen and Home agree: both count down, or neither does', async () => {
  let env;
  const dues = () => env.saved.filter((x) => x.fsrs.scheduled_days < 1).map((x) => x.fsrs.due).sort();
  env = boot({ cards: [card('1'), card('2')], upcoming: () => ({ waiting: dues() }) });
  await env.start();
  env.w.flipCard();
  env.w.rate(1);                               // Again: 10 min
  await sleep(5);
  env.w.flipCard();
  env.w.rate(3);                               // Good on a new card: 1 h
  await sleep(5);
  assert.match(env.txt('cs-sub'), /^Next: 2 cards in (10:00|9:5\d)\. Resumes by itself\.$/);
  env.w.showHome();
  await until(() => env.shown('s-home'));
  assert.match(env.txt('home-wait'), /^Next: 2 cards in (10:00|9:5\d)\. Updates by itself\.$/);

  env = boot({ cards: [card('1')], upcoming: () => ({ waiting: dues() }) });
  await env.start();
  env.w.flipCard();
  env.w.rate(4);                               // Easy: graduates, nothing waits
  await sleep(5);
  assert.equal(env.txt('cs-title'), 'All done!');
  env.w.showHome();
  await until(() => env.shown('s-home'));
  assert.equal(env.shown('home-wait'), false);
});

await test('back on Home after 60 s: reads again, no beep', async () => {
  const cards = [];
  let up = {};
  const env = await home({ cards, upcoming: () => up });
  const log = stubAudio(env.w);
  tap(env.w);
  const reads = bootstraps(env);
  up = { waiting: [inMin(5)], nextDue: inMin(5) };
  cards.push(card('1'));
  env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
  await sleep(30);
  assert.equal(bootstraps(env), reads, 'the last read is fresh');
  env.clock.advance(61 * 1000);
  env.w.dispatchEvent(new env.w.Event('focus'));
  await until(() => env.shown('home-wait'));
  assert.equal(bootstraps(env), reads + 1);
  assert.match(env.txt('home-wait'), /^Next: 1 card in 3:5\d\. Updates by itself\.$/);
  assert.equal(env.txt('stat-due'), '1');
  assert.equal(log.osc.length, 0, 'the person is looking: no beep');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
