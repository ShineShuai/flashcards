// Run: node test/ui/ux.test.mjs   (needs: npm install --no-save jsdom)
// Keyboard, undo, theme, docs modal, aria.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

// ── keyboard in the session
{
  const env = boot({ cards: [card('1'), card('2'), card('3')] });
  await env.start();
  const { w, $, key, txt, saved } = env;
  key('h');
  assert.equal(w.eval('shownCount'), 1, 'h reveals a hint');
  key('s');
  assert.equal(w.eval('spellOpen'), true, 's toggles spell');
  key('s');
  assert.equal(w.eval('spellOpen'), false);
  key('s');
  const input = w.document.querySelector('.spell-slot');
  const shown = w.eval('shownCount');
  key('h', {}, input);
  assert.equal(w.eval('shownCount'), shown, 'ignored while typing');
  key('s');
  const onButton = key(' ', {}, $('btn-hint'));
  assert.equal(w.eval('isFlipped()'), false, 'space on a focused button is not a flip');
  assert.equal(onButton.defaultPrevented, false);
  const space = key(' ');
  assert.equal(w.eval('isFlipped()'), true, 'space flips');
  assert.equal(space.defaultPrevented, true);
  key('Escape');
  assert.equal(w.eval('isFlipped()'), false, 'esc unflips');
  key('Enter');
  assert.equal(w.eval('isFlipped()'), true, 'enter flips');
  key('5');
  await until(() => saved.length === 1);
  assert.equal(txt('card-title'), 'T2');
  assert.equal(saved.at(-1).meta.rating, 4, '5 = Easy');
  key(' ');
  key('Enter');                                    // accepts the suggestion (no hints: Easy)
  await until(() => saved.length === 2);
  assert.equal(saved.at(-1).meta.rating, 4);
  assert.equal(txt('card-title'), 'T3');
  const map = [['1', 1], ['2', 1.5], ['3', 2], ['4', 3], ['5', 4]];
  assert.deepEqual([...w.eval('[...RATING_KEYS.entries()]')].map(([k, v]) => [k, v]), map);
  key('z', { ctrlKey: true });
  await sleep(10);
  assert.equal(txt('card-title'), 'T2', 'ctrl+z undoes');
  key('k');
  assert.equal(txt('card-title'), 'T3', 'k skips');
  console.log('ok   keys h s space enter esc 1-5 k ctrl+z; not in inputs; buttons keep theirs');
}
// ── keyboard on home / done screens, click blur
{
  const env = boot({ cards: [card('1')] });
  await until(() => env.shown('s-home'));
  const { w, $, key } = env;
  key('Enter');
  await sleep(5);
  assert.ok(env.shown('s-session'), 'enter starts from home');
  key(' ');
  key('5');
  await sleep(10);
  assert.ok(env.shown('s-complete'));
  assert.ok(env.shown('btn-undo-done'), 'undo offered on the done screen');
  key('Enter');
  await until(() => env.shown('s-home'));
  const button = $('startBtn');
  button.focus();
  button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.notEqual(w.document.activeElement, button, 'a mouse click blurs the button');
  console.log('ok   home / done keys; mouse click blurs the button');
}
// ── undo
{
  const env = boot({ cards: [card('1'), card('2'), card('3')] });
  await env.start();
  const { w, $, txt, saved } = env;
  assert.equal($('btn-undo').disabled, true);
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal(txt('prog-text'), '1 / 3');
  assert.equal($('btn-undo').disabled, false);
  w.undoRating();
  await until(() => saved.length === 2);
  assert.equal(txt('card-title'), 'T1');
  assert.equal(txt('prog-text'), '0 / 3');
  assert.equal($('btn-undo').disabled, true);
  assert.equal(saved[1].meta.undo, true);
  assert.equal(saved[1].meta.undone_time, saved[0].fsrs.last_review);
  assert.equal(saved[1].fsrs.state, '');
  assert.equal(saved[1].fsrs.due, '');
  assert.equal(w.eval('deck[0].state'), '');
  assert.equal(w.eval('sessionStats.total'), 0);
  // re-queued card: the copy is removed again
  w.flipCard();
  w.rate(1);
  await sleep(5);
  assert.equal(w.eval('deck.map(c => c.id).join()'), '1,2,3,1');
  w.undoRating();
  await sleep(5);
  assert.equal(w.eval('deck.map(c => c.id).join()'), '1,2,3');
  assert.equal(txt('prog-text'), '0 / 3');
  assert.equal(w.eval('sessionStats.again'), 0);
  // undo while the next card is showing its back
  w.flipCard();
  w.rate(4);
  await sleep(5);
  w.flipCard();
  w.undoRating();
  await sleep(10);
  assert.equal(txt('card-title'), 'T1');
  assert.equal(w.eval('isFlipped()'), false);
  console.log('ok   undo: plain, re-queued copy, counters, after the save, from the back face');
}
{
  const env = boot({ cards: [card('1')] });
  await env.start();
  const { w, $, txt, saved } = env;
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.ok(env.shown('s-complete'));
  $('btn-undo-done').click();
  await until(() => saved.length === 2);
  assert.ok(env.shown('s-session'));
  assert.equal(txt('card-title'), 'T1');
  assert.equal(env.shown('btn-undo-done'), false);
  console.log('ok   undo from the done screen');
}
// ── theme: saved > system > light
{
  const attr = (e) => e.w.document.documentElement.getAttribute('data-theme');
  assert.equal(attr(boot({ cards: [], dark: true })), 'dark');
  assert.equal(attr(boot({ cards: [], dark: true, storage: { 'fc-theme': 'light' } })), 'light');
  assert.equal(attr(boot({ cards: [] })), 'light');
  console.log('ok   theme: saved > system > light');
}
// ── docs modal
{
  const env = boot({ cards: [card('1')] });
  await until(() => env.shown('s-home'));
  const { w, $, key } = env;
  assert.equal($('docs-link').tagName, 'BUTTON');
  $('docs-link').click();
  assert.ok(env.shown('docs-modal'));
  assert.ok($('docs-loading'));
  assert.equal(w.document.activeElement, $('docs-close'));
  await until(() => $('docs-content').querySelector('iframe'));
  const iframe = $('docs-content').querySelector('iframe');
  iframe.dispatchEvent(new w.Event('load'));
  assert.equal($('docs-loading'), null);
  key('Escape');
  assert.equal(env.shown('docs-modal'), false);
  assert.equal(w.document.activeElement, $('docs-link'));
  const failing = boot({ cards: [card('1')], docsFail: true });
  await until(() => failing.shown('s-home'));
  failing.$('docs-link').click();
  await until(() => /Could not load/.test(failing.txt('docs-loading')));
  console.log('ok   docs modal: loader, esc closes, focus returns, error text');
}
// ── aria
{
  const env = boot({ cards: [card('1'), card('2')] });
  await env.start();
  const { w, $ } = env;
  assert.equal($('prog-bar').getAttribute('role'), 'progressbar');
  w.flipCard();
  w.rate(4);
  await sleep(5);
  assert.equal($('prog-bar').getAttribute('aria-valuenow'), '50');
  for (const id of ['themeBtn', 'docsBtn', 'btn-undo', 'docs-close']) {
    assert.ok($(id).getAttribute('aria-label'), id);
  }
  for (const id of ['hint-status', 'rating-hint', 'spell-result']) {
    assert.equal($(id).getAttribute('aria-live'), 'polite', id);
  }
  console.log('ok   aria: progressbar value, labels, live regions');
}
