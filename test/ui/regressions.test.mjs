// Run: node test/ui/regressions.test.mjs   (needs: npm install --no-save jsdom)
// Bug fixes: flip-back spoiler, load failure, blocked storage, skip, spell inputs.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

const answers = () => [
  card('1', 'a;b', { back_content: 'ANSWER-1' }),
  card('2', 'c;d', { back_content: 'ANSWER-2' }),
];

// ── no answer spoiler during the flip-back; rating locked until flipped
{
  const env = boot({ cards: answers() });
  await env.start();
  const { w, $, txt, saved } = env;
  w.flipCard();
  assert.match(txt('back-content'), /ANSWER-1/);
  assert.equal($('face-back').hasAttribute('inert'), false);
  assert.equal($('face-front').hasAttribute('inert'), true);
  w.rate(4);
  assert.equal(txt('card-title'), 'T2');
  assert.doesNotMatch(txt('back-content'), /ANSWER-2/, 'next answer visible during flip-back');
  assert.match(txt('back-content'), /ANSWER-1/, 'old answer stays on the rotating face');
  w.rate(4);
  w.rate(1);
  await until(() => saved.length >= 1);
  await sleep(30);
  assert.equal(saved.length, 1, 'taps during the flip-back are ignored');
  assert.equal($('face-back').hasAttribute('inert'), true);
  assert.equal($('face-front').hasAttribute('inert'), false);
  await sleep(650);
  assert.match(txt('back-content'), /ANSWER-2/, 'back rendered after the animation');
  console.log('ok   no spoiler, double tap ignored, hidden face inert');
}
{
  const env = boot({ cards: answers() });
  await env.start();
  const { w, txt } = env;
  w.flipCard();
  w.rate(4);
  w.flipCard();                                   // flips again inside the animation
  assert.match(txt('back-content'), /ANSWER-2/);
  assert.equal(w.eval('pendingBack'), null);
  await sleep(650);
  assert.match(txt('back-content'), /ANSWER-2/);
  console.log('ok   flip before the deferred render shows the right answer');
}
// ── load failure goes back home (no endless spinner)
{
  const alerts = [];
  const env = boot({ cards: [card('1')], failDue: true });
  await env.start().catch(() => {});
  env.w.alert = (m) => alerts.push(m);
  env.w.eval('homeCards = null');
  env.w.startSession();
  await until(() => alerts.length === 1);
  assert.ok(env.shown('s-home'));
  assert.equal(env.shown('s-loading'), false);
  console.log('ok   getDueCards failure returns to home');
}
// ── blocked localStorage
{
  const env = boot({ cards: [card('1')], blockStorage: true });
  await until(() => env.shown('s-home'));
  const root = env.w.document.documentElement;
  const before = root.getAttribute('data-theme');
  env.w.toggleTheme();
  assert.notEqual(root.getAttribute('data-theme'), before);
  console.log('ok   storage blocked: app starts, theme toggles');
}
// ── skip is a no-op on the last pending card
{
  const env = boot({ cards: [card('1'), card('2')] });
  await env.start();
  const { w, $, txt } = env;
  assert.equal($('btn-skip').disabled, false);
  w.skipCard();
  assert.equal(txt('card-title'), 'T2');
  assert.equal(w.eval('deck.map(c => c.id).join()'), '2,1');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('card-title'), 'T1');
  assert.equal($('btn-skip').disabled, true, 'only one card pending');
  w.skipCard();
  assert.equal(txt('card-title'), 'T1');
  assert.equal(w.eval('deck.map(c => c.id).join()'), '2,1');
  console.log('ok   skip disabled / no-op on the last pending card');
}
// ── spell inputs: typed values kept, focus, attributes
{
  const env = boot({ cards: [card('1', 'alpha;bravo;charlie;delta')] });
  await env.start();
  const { w } = env;
  w.toggleSpell();
  let slots = [...w.document.querySelectorAll('.spell-slot')];
  assert.equal(slots.length, 4);
  assert.equal(w.document.activeElement, slots[0], 'first slot focused');
  assert.equal(slots[0].getAttribute('autocorrect'), 'off');
  assert.equal(slots[0].getAttribute('spellcheck'), 'false');
  slots[3].value = 'zzz';                         // typed only in the last slot
  w.revealHint();
  slots = [...w.document.querySelectorAll('.spell-slot')];
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((x) => x.value), ['zzz', '', ''], 'typed value survives the rebuild');
  assert.equal(w.document.activeElement, slots[1], 'focus on the first empty slot');
  console.log('ok   spell inputs: value kept and packed, focus, attributes');
}
{
  const env = boot({ cards: [card('1', 'alpha;bravo;charlie;delta')] });
  await env.start();
  const { w } = env;
  let leaked = 0;
  for (let t = 0; t < 300; t++) {
    w.eval('shownCount = 0; shuffledKw = shuffle(["alpha","bravo","charlie","delta"]);' +
           ' spellOpen = true; renderFront();');
    w.document.querySelector('.spell-slot').value = 'alpa';   // one edit from "alpha"
    w.revealHint();
    if (w.eval('shuffledKw[0]') === 'alpha') {
      leaked++;
    }
  }
  assert.equal(leaked, 0);
  console.log('ok   a hint never reveals a keyword that was already typed (300 trials)');
}
