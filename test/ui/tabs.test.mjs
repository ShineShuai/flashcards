// Run: node test/ui/tabs.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// One card, several tabs: lines "<!--tab-->", "<!--tab TYPE-->", "<!--tab TYPE: Label-->"
// in back_content. Splitting, the tab bar, lazy mounting, keys, swipe, isolation of each
// tab's CSS, live tabs, and that a card without a marker is exactly what it was.
import assert from 'node:assert/strict';
import { boot, card, sleep } from './harness.mjs';

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

const IMG = '<img src="https://drive.google.com/thumbnail?id=AAA&sz=w1000">';
const SVG = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const DIV = '<div class="d">Hello</div>';

// Shows the back of one card; returns the env and the #back-content element.
async function back(content, type = 'html', options = {}) {
  const env = boot({ cards: [card('1', 'a;b;c', { back_content: content, back_type: type })],
                     realMarkdown: true, ...options });
  await env.start();
  env.w.flipCard();
  await sleep(5);
  return { env, el: env.$('back-content') };
}
const tabsOf = (el) => [...el.querySelectorAll('.fc-tab')];
const panels = (el) => [...el.querySelectorAll('.fc-tabpanel')];
const selected = (el) => tabsOf(el).findIndex((b) => b.getAttribute('aria-selected') === 'true');
const visible = (el) => panels(el).map((p) => !p.hidden);
const THREE = [DIV, '<!--tab-->', SVG, '<!--tab-->', IMG].join('\n');

// ── splitTabs ───────────────────────────────────────────────────────────────
const split = async (content, type = 'html') => {
  const { env } = await back('x', 'text');
  return Array.from(env.w.splitTabs(content, type), (t) => ({ ...t }));
};

await test('splitTabs: no marker is one tab with the content untouched', async () => {
  const text = '\n  keep  \n<p>x</p>\n';
  assert.deepEqual(await split(text),
    [{ type: 'html', label: '', content: text, start: 0, end: text.length }]);
});

await test('splitTabs: start/end locate each tab in the cell; a null type stays null', async () => {
  const cell = 'A\r\n<!--tab md-->\r\nB\n<!--tab-->\n\n<!--tab: L-->\n€ C\n';
  const t = await split(cell, null);
  assert.deepEqual(t.map((x) => [x.type, x.label, x.content]),
    [[null, '', 'A'], ['md', '', 'B'], [null, 'L', '€ C\n']]);
  for (const x of t) {
    assert.equal(cell.slice(x.start, x.end), x.content);
  }
});

await test('splitTabs: markers, type override, label; first text is tab 1', async () => {
  const t = await split('A\n<!--tab-->\nB\n<!--tab md-->\nC\n<!--tab svg: Plan B-->\nD\n<!--tab: Only label-->\nE');
  assert.deepEqual(t.map((x) => [x.type, x.label, x.content]), [
    ['html', '', 'A'], ['html', '', 'B'], ['md', '', 'C'], ['svg', 'Plan B', 'D'],
    ['html', 'Only label', 'E'],
  ]);
});

await test('splitTabs: a marker on the first line sets tab 1; blank tabs are dropped', async () => {
  const t = await split('<!--tab md: One-->\nA\n<!--tab-->\n\n  \n<!--tab-->\nB\n');
  assert.deepEqual(t.map((x) => [x.type, x.label, x.content]),
    [['md', 'One', 'A'], ['html', '', 'B\n']]);
});

await test('splitTabs: only a line of its own is a marker; near-misses are content', async () => {
  const c = 'x <!--tab--> y\n<!--table-->\n<!--tabs-->\n<!--tab svgx-->\n<!--tab md-->  trailing';
  const t = await split(c);
  assert.equal(t.length, 1);
  assert.equal(t[0].content, c);
});

await test('splitTabs: CRLF, spaces and case in a marker; label is cut at 40', async () => {
  const label = 'L'.repeat(60);
  const t = await split(`A\r\n  <!--  TAB  SVG : ${label} -->  \r\nB`);
  assert.deepEqual(t.map((x) => [x.type, x.label.length, x.content]),
    [['html', 0, 'A'], ['svg', 40, 'B']]);
});

// ── no marker: as before ────────────────────────────────────────────────────
await test('a card without a marker has no tab bar; badge and markup are unchanged', async () => {
  const { env, el } = await back(DIV + '\n' + IMG);
  assert.equal(el.querySelector('.fc-tabs'), null);
  assert.deepEqual([...el.children].map((n) => n.nodeName), ['DIV', 'IMG']);
  assert.equal(env.txt('back-type-badge'), 'html');
});

await test('one marker and one tab: its type override applies, still no tab bar', async () => {
  const { el } = await back('<!--tab md-->\n# Title', 'text');
  assert.equal(el.querySelector('.fc-tabs'), null);
  assert.equal(el.querySelector('h1').textContent, 'Title');
});

// ── the tab bar ─────────────────────────────────────────────────────────────
await test('html + svg + img tabs: bar with 3 tabs, first shown, others not mounted yet', async () => {
  const { env, el } = await back(THREE);
  assert.deepEqual(tabsOf(el).map((b) => b.textContent), ['1', '2', '3']);
  assert.equal(el.querySelector('[role=tablist]').getAttribute('aria-label'), 'Card tabs');
  assert.equal(selected(el), 0);
  assert.deepEqual(visible(el), [true, false, false]);
  const [p0, p1, p2] = panels(el);
  assert.ok(p0.querySelector('div.d'));
  assert.equal(p1.hasChildNodes(), false, 'tab 2 is not mounted before it is shown');
  assert.equal(p2.hasChildNodes(), false);
  assert.equal(env.txt('back-type-badge'), 'html · 3 tabs');
});

await test('aria: tab and panel point at each other; only the selected tab is in the tab order', async () => {
  const { el } = await back(THREE);
  tabsOf(el).forEach((b, i) => {
    const p = panels(el)[i];
    assert.equal(b.getAttribute('role'), 'tab');
    assert.equal(b.getAttribute('aria-controls'), p.id);
    assert.equal(p.getAttribute('aria-labelledby'), b.id);
    assert.equal(p.getAttribute('role'), 'tabpanel');
    assert.equal(b.tabIndex, i === 0 ? 0 : -1);
  });
});

await test('a click shows that tab, mounts it once, hides the others', async () => {
  const { el } = await back(THREE);
  tabsOf(el)[1].click();
  assert.equal(selected(el), 1);
  assert.deepEqual(visible(el), [false, true, false]);
  const svg = panels(el)[1].querySelector('svg');
  assert.ok(svg && svg.querySelector('circle'));
  tabsOf(el)[2].click();
  tabsOf(el)[1].click();
  assert.equal(panels(el)[1].querySelector('svg'), svg, 'not mounted again');
  assert.ok(panels(el)[2].querySelector('img'));
});

await test('labels and per-tab types: md renders as markdown, label is text, not markup', async () => {
  const { el } = await back('# One\n<!--tab md: <b>Notes</b>-->\n# Two\n<!--tab text-->\n<i>raw</i>', 'md');
  const names = tabsOf(el).map((b) => b.textContent);
  assert.deepEqual(names, ['1', '<b>Notes</b>', '3']);
  assert.equal(tabsOf(el)[1].querySelector('b'), null);
  tabsOf(el)[1].click();
  assert.equal(panels(el)[1].querySelector('h1').textContent, 'Two');
  tabsOf(el)[2].click();
  assert.equal(panels(el)[2].textContent, '<i>raw</i>');
});

await test('each tab is sanitized on its own', async () => {
  const { el } = await back('<p>a</p>\n<!--tab-->\n<img src=x onerror="alert(1)"><script>alert(2)</script>');
  tabsOf(el)[1].click();
  assert.equal(el.querySelector('script'), null);
  assert.equal(el.querySelector('img').getAttribute('onerror'), null);
});

await test('a tab with its own <style> gets a shadow root: its CSS does not reach other tabs', async () => {
  const { el } = await back(
    '<style>div{color:red}</style><div>one</div>\n<!--tab-->\n<div>two</div>');
  assert.ok(panels(el)[0].querySelector('.fc-styled').shadowRoot.querySelector('style'));
  tabsOf(el)[1].click();
  assert.equal(panels(el)[1].querySelector('.fc-styled'), null);
  assert.equal(panels(el)[1].querySelector('style'), null);
  assert.equal(el.querySelectorAll('style').length, 0, 'no <style> in the light DOM');
});

await test('a broken image in a later tab is noted under it', async () => {
  const { el } = await back('<p>a</p>\n<!--tab-->\n' + IMG);
  tabsOf(el)[1].click();
  const img = panels(el)[1].querySelector('img');
  img.dispatchEvent(new el.ownerDocument.defaultView.Event('error'));
  assert.match(panels(el)[1].querySelector('.back-note').textContent, /^Image did not load/);
});

// ── keys ────────────────────────────────────────────────────────────────────
await test('left / right move between tabs while the answer is shown, and stop at the ends', async () => {
  const { env, el } = await back(THREE);
  const arrow = (k) => env.key(k);
  assert.equal(arrow('ArrowRight').defaultPrevented, true);
  assert.equal(selected(el), 1);
  arrow('ArrowRight');
  arrow('ArrowRight');
  assert.equal(selected(el), 2, 'clamped at the last tab');
  arrow('ArrowLeft');
  arrow('ArrowLeft');
  assert.equal(arrow('ArrowLeft').defaultPrevented, true);
  assert.equal(selected(el), 0, 'clamped at the first tab');
});

await test('arrows do nothing on the front, or on a card without tabs', async () => {
  const { env, el } = await back(THREE);
  env.w.unflipCard();
  await sleep(5);
  assert.equal(env.key('ArrowRight').defaultPrevented, false);
  assert.equal(selected(el), 0);
  const plain = await back(DIV);
  assert.equal(plain.env.key('ArrowRight').defaultPrevented, false);
});

await test('ratings and Escape still work on a tabbed card', async () => {
  const { env } = await back(THREE);
  env.key('ArrowRight');
  env.key('Escape');
  await sleep(5);
  assert.equal(env.w.isFlipped(), false);
});

await test('on a focused tab: arrows, Home and End move the focus with the selection, once', async () => {
  const { env, el } = await back(THREE);
  const doc = env.w.document;
  tabsOf(el)[0].focus();
  const e = env.key('ArrowRight', {}, tabsOf(el)[0]);
  assert.equal(e.defaultPrevented, true);
  assert.equal(selected(el), 1, 'one step, not two (the global handler stands aside)');
  assert.equal(doc.activeElement, tabsOf(el)[1]);
  env.key('End', {}, tabsOf(el)[1]);
  assert.equal(selected(el), 2);
  env.key('Home', {}, tabsOf(el)[2]);
  assert.equal(selected(el), 0);
  env.key('ArrowLeft', { ctrlKey: true }, tabsOf(el)[0]);
  assert.equal(selected(el), 0, 'a modifier is left alone');
});

// ── swipe ───────────────────────────────────────────────────────────────────
function swipe(env, target, from, to, touches = 1) {
  const W = env.w;
  const t = (x, y) => ({ clientX: x, clientY: y });
  const start = Object.assign(new W.Event('touchstart', { bubbles: true }),
    { touches: Array.from({ length: touches }, () => t(...from)) });
  const end = Object.assign(new W.Event('touchend', { bubbles: true }),
    { touches: [], changedTouches: [t(...to)] });
  target.dispatchEvent(start);
  target.dispatchEvent(end);
}

await test('a horizontal swipe changes the tab; a vertical or short one, or a pinch, does not', async () => {
  const { env, el } = await back(THREE);
  const body = el.querySelector('.fc-tabbody');
  swipe(env, panels(el)[0], [200, 100], [100, 110]);        // left: next
  assert.equal(selected(el), 1);
  swipe(env, panels(el)[1], [100, 100], [200, 105]);        // right: previous
  assert.equal(selected(el), 0);
  swipe(env, body, [200, 100], [100, 260]);                  // mostly vertical
  swipe(env, body, [200, 100], [170, 100]);                  // too short
  swipe(env, body, [200, 100], [100, 100], 2);               // two fingers
  assert.equal(selected(el), 0);
});

await test('a swipe that starts in something that scrolls sideways is left to it', async () => {
  const { env, el } = await back('<div id="w" style="overflow-x:auto">x</div>\n<!--tab-->\n<p>b</p>');
  const wide = el.querySelector('#w');
  Object.defineProperty(wide, 'scrollWidth', { value: 900 });
  Object.defineProperty(wide, 'clientWidth', { value: 300 });
  swipe(env, wide, [200, 100], [60, 100]);
  assert.equal(selected(el), 0);
  swipe(env, panels(el)[0], [200, 100], [60, 100]);
  assert.equal(selected(el), 1);
});

// ── live tabs ───────────────────────────────────────────────────────────────
await test('a live tab is mounted when shown and unmounted when left; its frame is watched', async () => {
  const { env, el } = await back('<p>a</p>\n<!--tab live-->\n<canvas></canvas><script>1</script>\n<!--tab-->\n<p>c</p>');
  assert.equal(el.querySelector('iframe'), null, 'no frame before the tab is shown');
  tabsOf(el)[1].click();
  assert.equal(el.querySelectorAll('iframe.live-frame').length, 1);
  assert.equal(el.querySelector('iframe').getAttribute('sandbox').includes('allow-same-origin'), false);
  tabsOf(el)[2].click();
  assert.equal(el.querySelector('iframe'), null, 'left: unmounted, so its scripts and sound stop');
  tabsOf(el)[1].click();
  assert.equal(el.querySelectorAll('iframe.live-frame').length, 1, 'shown again: mounted anew');
  env.w.eval('liveWaitMs = 20');
  tabsOf(el)[0].click();
  tabsOf(el)[1].click();
  await sleep(60);
  assert.equal(el.querySelectorAll('.back-note').length, 1, 'one notice, not one per watch');
  assert.match(el.querySelector('.back-note').textContent, /did not start/);
});

await test('a live first tab is watched exactly once', async () => {
  const env = boot({ cards: [card('1', 'a;b', { back_type: 'live',
    back_content: '<script>1</script>\n<!--tab md-->\nnext' })], realMarkdown: true });
  env.w.eval('liveWaitMs = 20');                 // before the card is first rendered
  await env.start();
  env.w.flipCard();
  await sleep(60);
  assert.equal(env.$('back-content').querySelectorAll('.back-note').length, 1);
});

// ── next card ───────────────────────────────────────────────────────────────
await test('the next card replaces the tabs: no stale bar, badge back to the type', async () => {
  const { env, el } = await back(THREE);
  env.w.renderBack({ back_type: 'text', back_content: 'plain' });
  assert.equal(el.querySelector('.fc-tabs'), null);
  assert.equal(el.textContent, 'plain');
  assert.equal(env.txt('back-type-badge'), 'text');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
