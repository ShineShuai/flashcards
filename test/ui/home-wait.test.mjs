// Run: node test/ui/home-wait.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Home counts down like the done screen, and only when it would: to the waiting cards the
// finished session holds in `deck`. When one is due it refreshes the counts by itself.
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

const MIN = 60000;
const TWO = /^Next: 2 cards in (10:00|9:5\d)\. Updates by itself\.$/;
const bootstraps = (env) => env.ev.filter((e) => e === 'bootstrap').length;
const tap = (w) => w.document.dispatchEvent(new w.Event('pointerdown'));
const hide = (w, hidden) =>
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: hidden });

// An AudioContext that records its oscillators.
function stubAudio(w) {
  const log = { created: 0, osc: [] };
  w.AudioContext = class {
    constructor() {
      log.created++;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {}
    createGain() {
      const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return { gain: param, connect() {} };
    }
    createOscillator() {
      const osc = { frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      log.osc.push(osc);
      return osc;
    }
  };
  return log;
}

// Two cards: c1 Again (10 min), c2 Good on a new card (1 h): the session ends on the done
// screen with two waiting cards. `cards` is what the server will report as due: emptied here.
async function doneWithTwoWaiting(options = {}) {
  const cards = [card('1'), card('2')];
  const env = boot({ cards, ...options });
  await env.start();
  cards.length = 0;
  env.w.flipCard();
  env.w.rate(1);
  await sleep(5);
  env.w.flipCard();
  env.w.rate(3);
  await sleep(5);
  assert.ok(env.shown('s-complete'));
  assert.match(env.txt('cs-sub'), /^Next: 2 cards in (10:00|9:5\d)\. Resumes by itself\.$/);
  return { env, cards };
}
async function goHome(env) {
  env.w.showHome();
  await until(() => env.shown('s-home'));
  await sleep(5);
}

await test('Home shows the done-screen countdown, and only then', async () => {
  const { env } = await doneWithTwoWaiting();
  await goHome(env);
  assert.equal(env.shown('home-wait'), true);
  assert.match(env.txt('home-wait'), TWO);
  assert.equal(env.$('startBtn').disabled, true);
  assert.equal(env.txt('startBtn').trim(), '✓  Nothing due');
  env.clock.advance(61 * 1000);
  await until(() => /in 8:5\d\./.test(env.txt('home-wait')), 3000);
  await goHome(env);                                   // Home again: the deck still holds them
  assert.equal(env.shown('home-wait'), true);

  const all = boot({ cards: [card('1')] });            // nothing waits: "All done!"
  await all.start();
  all.w.flipCard();
  all.w.rate(4);
  await sleep(5);
  assert.equal(all.txt('cs-title'), 'All done!');
  await goHome(all);
  assert.equal(all.shown('home-wait'), false);
  assert.equal(all.w.eval('waitTimer'), null);

  const cold = boot({ cards: [card('1')] });           // a fresh page: no session, no countdown
  await until(() => cold.shown('s-home'));
  assert.equal(cold.shown('home-wait'), false);
  assert.equal(cold.w.eval('waitTimer'), null);
});

await test('card due: Due, button, beep and title update by themselves', async () => {
  const { env, cards } = await doneWithTwoWaiting();
  const log = stubAudio(env.w);
  const base = env.w.document.title;
  tap(env.w);                                          // the gesture that unlocks the audio
  assert.equal(log.created, 1);
  await goHome(env);
  assert.equal(env.txt('stat-due'), '0');
  hide(env.w, true);
  const reads = bootstraps(env);

  cards.push(card('1'));                               // the server now reports c1 as due
  env.clock.advance(10 * MIN + 1000);
  await until(() => env.txt('stat-due') === '1', 3500);
  assert.equal(env.shown('s-home'), true, 'no spinner, no screen change');
  assert.equal(bootstraps(env), reads + 1);
  assert.equal(env.txt('startBtn').trim(), '▶  Start Review (1)');
  assert.equal(env.$('startBtn').disabled, false);
  assert.match(env.txt('home-wait'), /^Next: 1 card in (49:5\d|50:00)\. Updates by itself\.$/,
    'the 1 h card keeps counting');
  assert.equal(log.osc.map((o) => o.frequency.value).join(), '660,880', 'two-tone beep');
  assert.equal(env.w.document.title, '● Card due · ' + base);

  hide(env.w, false);
  env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
  assert.equal(env.w.document.title, base);
  env.w.startSession();                                // the refreshed cards, no second read
  assert.equal(env.shown('s-session'), true);
  assert.equal(env.txt('card-title'), 'T1');
  assert.equal(env.ev.includes('getDueCards'), false);
  assert.equal(env.w.eval('waitTimer'), null, 'leaving Home stops the watch');
});

await test('server clock behind: asks again, then heals', async () => {
  const { env, cards } = await doneWithTwoWaiting();
  const log = stubAudio(env.w);
  tap(env.w);
  await goHome(env);
  const reads = bootstraps(env);

  env.clock.advance(10 * MIN + 1000);                  // c1 is due here; the server says no
  await until(() => bootstraps(env) === reads + 1, 3500);
  await sleep(50);
  assert.equal(env.txt('stat-due'), '0');
  assert.equal(log.osc.length, 0, 'no beep for a count that did not grow');
  assert.match(env.txt('home-wait'), /^Next: 2 cards in 0:00\./, 'the card is still waited for');
  await sleep(2500);
  assert.equal(bootstraps(env), reads + 1, 'the second try waits (10 s), no loop');

  cards.push(card('1'));                               // now the server agrees
  env.clock.advance(11 * 1000);
  await until(() => env.txt('stat-due') === '1', 3500);
  assert.equal(bootstraps(env), reads + 2);
  assert.equal(log.osc.length, 2, 'beep once the count grew');
  assert.match(env.txt('home-wait'), /^Next: 1 card in /);
});

await test('it gives up on a card after the allowed number of reads', async () => {
  const { env } = await doneWithTwoWaiting();
  await goHome(env);
  const reads = bootstraps(env);
  env.clock.advance(10 * MIN + 1000);
  for (let n = 1; n <= 5; n++) {
    await until(() => bootstraps(env) === reads + n, 3500);
    await sleep(20);
    env.clock.advance(61 * 1000);                      // past any retry wait
  }
  assert.match(env.txt('home-wait'), /^Next: 1 card in /, 'only the 1 h card is left');
  const before = bootstraps(env);
  await sleep(1500);
  assert.equal(bootstraps(env), before);
});

await test('late refresh does not pull back; leaving Home stops the watch', async () => {
  const { env } = await doneWithTwoWaiting();
  await goHome(env);
  assert.notEqual(env.w.eval('waitTimer'), null);
  env.w.show('s-weights');
  assert.equal(env.w.eval('waitTimer'), null);

  const fresh = boot({ cards: [card('1')] });
  await until(() => fresh.shown('s-home'));
  fresh.w.eval('fetchHome(true)');                     // a refresh is in flight...
  fresh.w.startSession();                              // ...when the person starts reviewing
  await sleep(30);
  assert.equal(fresh.shown('s-session'), true, 'the answer is dropped');
  assert.equal(fresh.w.eval('homeFetching'), false);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
