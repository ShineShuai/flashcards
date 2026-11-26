// Run: node test/ui/done-wait.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// The done screen counts down to every learning-phase card, also those reviewed on another
// device (the server's list); a card of this session resumes at once, a foreign one is read.
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
const inMin = (n) => new Date(NOW.getTime() + n * MIN).toISOString();
const foreign = (due) => ({ id: 'F', due });
const away = () => ({ ...card('F'), state: 1 });   // card F, reviewed on another device
const tap = (w) => w.document.dispatchEvent(new w.Event('pointerdown'));
const hide = (w, hidden) =>
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: hidden });

// Starts a session on `cards` and rates the cards in turn; returns once the session ended.
async function play(options, ratings) {
  const env = boot(options);
  await env.start();
  for (const rating of ratings) {
    env.w.flipCard();
    env.w.rate(rating);
    await sleep(5);
  }
  return env;
}

await test('the server list joins the countdown, also after "All done!"', async () => {
  const env = boot({
    cards: [card('1')],
    learning: (d) => ({ due: [], waiting: [...d.waiting, foreign(inMin(9))] }),
  });
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  assert.equal(env.txt('cs-title'), 'All done!', 'until the read answers');
  await until(() => env.txt('cs-title') === 'Done for now');
  assert.match(env.txt('cs-sub'), /^Next: 1 card in (9:00|8:5\d)\. Resumes by itself\.$/);
  assert.notEqual(env.w.eval('waitTimer'), null);
});

await test('a card of this session is counted once, the soonest one leads', async () => {
  const env = await play({
    cards: [card('1'), card('2')],
    learning: (d) => ({ due: [], waiting: [...d.waiting, foreign(inMin(4))] }),
  }, [1, 4]);                                   // c1 Again (10 min), c2 Easy
  await until(() => env.srv.learningCalls === 1);
  await sleep(10);
  assert.match(env.txt('cs-sub'), /^Next: 2 cards in (4:00|3:5\d)\. Resumes by itself\.$/);
});

await test('the soonest card is from another device: read, joined, beep, tab title', async () => {
  let up = { due: [], waiting: [foreign(inMin(9))] };
  const env = boot({ cards: [card('1')], learning: () => up });
  const log = stubAudio(env.w);
  const base = env.w.document.title;
  tap(env.w);
  hide(env.w, true);
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  await until(() => env.txt('cs-title') === 'Done for now');
  up = { due: [away()], waiting: [] };          // F is due now
  env.clock.advance(9 * MIN + 1000);
  await until(() => env.shown('s-session'), 3500);
  assert.equal(env.txt('card-title'), 'TF');
  assert.equal(env.srv.learningCalls, 2);
  assert.equal(env.txt('prog-text'), '1 / 2', 'the session grew by one card');
  assert.equal(log.osc.map((o) => o.frequency.value).join(), '660,880');
  assert.equal(env.w.document.title, '● Card due · ' + base);
  assert.equal(env.w.eval('waitTimer'), null);
});

await test('server clock behind: asks again after 5 s, not in a loop, then joins', async () => {
  let up = { due: [], waiting: [foreign(inMin(9))] };
  const env = await play({ cards: [card('1')], learning: () => up }, [4]);
  await until(() => env.txt('cs-title') === 'Done for now');
  env.clock.advance(9 * MIN + 1000);            // due here, the server says not yet
  await until(() => env.srv.learningCalls === 2, 3500);
  assert.match(env.txt('cs-sub'), /^Next: 1 card in 0:00\./);
  await sleep(2500);
  assert.equal(env.srv.learningCalls, 2, 'waits for the retry period');
  up = { due: [away()], waiting: [] };
  env.clock.advance(6000);
  await until(() => env.shown('s-session'), 3500);
  assert.equal(env.srv.learningCalls, 3);
  assert.equal(env.txt('card-title'), 'TF');
});

await test('a card of this session resumes at once, without a read', async () => {
  const env = await play({ cards: [card('1')] }, [1]);   // Again: 10 min
  await until(() => env.srv.learningCalls === 1);
  assert.match(env.txt('cs-sub'), /^Next: 1 card in (10:00|9:5\d)\. Resumes by itself\.$/);
  env.clock.advance(10 * MIN + 1000);
  await until(() => env.shown('s-session'), 3500);
  assert.equal(env.txt('card-title'), 'T1');
  assert.equal(env.srv.learningCalls, 1);
});

await test('a foreign card that is due when the session ends joins it at once, no beep', async () => {
  const env = boot({ cards: [card('1')], learning: () => ({ due: [away()], waiting: [] }) });
  const log = stubAudio(env.w);
  tap(env.w);
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  await until(() => env.shown('s-session') && env.txt('card-title') === 'TF');
  assert.equal(env.txt('prog-text'), '1 / 2');
  assert.equal(log.osc.length, 0);
});

await test('the read fails: the session list keeps counting down', async () => {
  const env = await play({ cards: [card('1')], learning: () => new Error('boom') }, [1]);
  await until(() => env.srv.learningCalls === 1);
  await sleep(30);
  assert.equal(env.w.eval('doneReading'), false);
  assert.match(env.txt('cs-sub'), /^Next: 1 card in (10:00|9:5\d)\. Resumes by itself\.$/);
  assert.notEqual(env.w.eval('waitTimer'), null);
});

await test('back on the done screen after 60 s: reads again', async () => {
  let up = { due: [], waiting: [] };
  const env = await play({ cards: [card('1')], learning: () => up }, [4]);
  await until(() => env.srv.learningCalls === 1);
  assert.equal(env.txt('cs-title'), 'All done!');
  up = { due: [], waiting: [foreign(inMin(5))] };   // the phone reviewed a card meanwhile
  env.w.dispatchEvent(new env.w.Event('focus'));
  await sleep(30);
  assert.equal(env.srv.learningCalls, 1, 'the last read is fresh');
  env.clock.advance(61 * 1000);
  env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
  await until(() => env.txt('cs-title') === 'Done for now');
  assert.match(env.txt('cs-sub'), /^Next: 1 card in 3:5\d\. Resumes by itself\.$/);
});

await test('an answer that arrives after the person left the done screen is dropped', async () => {
  const env = boot({ cards: [card('1')], learning: () => ({ due: [away()], waiting: [] }) });
  await env.start();
  env.w.flipCard();
  env.w.rate(4);
  env.w.undoRating();                           // back to the card before the read answers
  await sleep(30);
  assert.equal(env.shown('s-session'), true);
  assert.equal(env.txt('card-title'), 'T1', 'F did not join');
  assert.equal(env.w.eval('doneReading'), false);
});

await test('Home after the done screen shows the same count', async () => {
  let env;
  env = boot({
    cards: [card('1'), card('2')],
    upcoming: () => ({ waiting: env.srv.saved.map((x) => x.fsrs).filter((f) => f.state === 1)
      .map((f) => f.due) }),
  });
  await env.start();
  for (const rating of [1, 3]) {                // c1 Again (10 min), c2 Good on new (1 h)
    env.w.flipCard();
    env.w.rate(rating);
    await sleep(5);
  }
  await until(() => env.srv.learningCalls === 1);
  await sleep(10);
  assert.match(env.txt('cs-sub'), /^Next: 2 cards in (10:00|9:5\d)\. Resumes by itself\.$/);
  env.w.showHome();
  await until(() => env.shown('s-home'));
  assert.match(env.txt('home-wait'), /^Next: 2 cards in (10:00|9:5\d)\. Updates by itself\.$/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
