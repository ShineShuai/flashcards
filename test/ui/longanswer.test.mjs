// Run: node test/ui/longanswer.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Long answers without author tabs: split at the content's own headings or <section>s into
// pages (or, in "All" mode, an outline bar), the full-screen answer, and the rules that decide
// when any of it applies. jsdom has no layout: a fake one (data-h on a block = its height)
// stands in. Real layout is in test/long-answer.mjs (Chromium).
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

// data-h on an element is its height; a block's top is the sum of the heights before it.
function fakeLayout(w, area = 500, width = 400) {
  const E = w.Element.prototype;
  const h = (el) => Number(el.getAttribute && el.getAttribute('data-h')) || 0;
  const define = (name, get) => Object.defineProperty(E, name, { configurable: true, get });
  define('clientHeight', function () { return this.id === 'back-content' ? area : 0; });
  define('clientWidth', function () { return this.id === 'back-content' ? width : 0; });
  define('scrollHeight', function () {
    if (this.id !== 'back-content') {
      return 0;
    }
    const roots = [this, ...Array.from(this.querySelectorAll('.fc-styled'), (n) => n.shadowRoot)];
    return roots.reduce((sum, r) => sum + Array.from(r.querySelectorAll('[data-h]')).reduce((a, n) => a + h(n), 0), 0);
  });
  // margins and paddings from data-mt / data-mb and the style attribute, not jsdom's default sheet
  const real = w.getComputedStyle.bind(w);
  const keys = { marginTop: 'data-mt', marginBottom: 'data-mb' };
  w.getComputedStyle = (node, ...rest) => new Proxy(real(node, ...rest), {
    get(target, key) {
      if (key in keys) {
        return (node.getAttribute(keys[key]) || '0') + 'px';
      }
      if (['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].includes(key)) {
        return node.style[key] || '0px';
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  E.getBoundingClientRect = function () {
    let top = 0;
    for (let n = this.previousElementSibling; n; n = n.previousElementSibling) {
      top += h(n);
    }
    return { top, bottom: top + h(this), left: 0, right: width, width, height: h(this) };
  };
}
const sec = (title, height, tag = 'h3') => `<${tag} data-h="30">${title}</${tag}><p data-h="${height - 30}">text of ${title}</p>`;
// five sections of 100 px (the preamble too): 500 px in all
const FIVE = ['<h2 data-h="40">Title</h2><p data-h="60">intro</p>', sec('One', 100), sec('Two', 100), sec('Three', 100), sec('Four', 100)].join('');
const WRAP = (inner) => `<div id="outer" style="background:#111;padding-top:20px;padding-bottom:20px">${inner}</div>`;

async function open(html, { type = 'html', area = 500, storage = {}, title = 'Card' } = {}) {
  const env = boot({ cards: [card('1', 'a;b', { title, back_content: 'x', back_type: 'text' })], realMarkdown: true, storage });
  await env.start();
  fakeLayout(env.w, area);
  const render = (content, t = type) => env.w.renderBack({ title, back_type: t, back_content: content });
  render(html);
  const stage = env.$('back-content');
  return { env, w: env.w, stage, render,
    tabs: () => Array.from(stage.querySelectorAll('.fc-tab'), (b) => b.textContent),
    extras: () => Array.from(stage.querySelectorAll('.fc-extra'), (b) => b.textContent),
    panelText: (i) => stage.querySelectorAll('.fc-tabpanel')[i].textContent };
}
const S = (w) => w.eval('backState');                       // the answer's state (a script-level const)
const el = (w, html) => { const d = w.document.createElement('div'); d.innerHTML = html; return d; };

// ── pure ────────────────────────────────────────────────────────────────────
await test('packPages: in order, as many to a page as fit, a long section alone', async () => {
  const { w } = await open('<p>x</p>');
  const pack = (h, c) => Array.from(w.packPages(h, c), (p) => Array.from(p));
  assert.deepEqual(pack([131, 320, 124, 194, 198], 414), [[0], [1], [2, 3], [4]]);
  assert.deepEqual(pack([100, 100, 100], 200), [[0, 1], [2]], 'exactly full is a fit');
  assert.deepEqual(pack([500, 10], 100), [[0], [1]], 'taller than a page: alone');
  assert.deepEqual(pack([5, 5], 0), [[0], [1]]);
  assert.deepEqual(pack([], 100), []);
});

await test('packPages with margins: a page also holds its first block\'s top margin and its last block\'s own bottom margin', async () => {
  const { w } = await open('<p>x</p>');
  const pack = (h, c, lead, tail) => Array.from(w.packPages(h, c, lead, tail), (p) => Array.from(p));
  assert.deepEqual(pack([100, 100, 100], 200, [20, 20, 20], [0, 0, 0]), [[0], [1], [2]], '100 + 100 + the top margin 20 > 200');
  assert.deepEqual(pack([100, 100, 100], 220, [20, 20, 20], [0, 0, 0]), [[0, 1], [2]]);
  assert.deepEqual(pack([100, 100, 100], 200, [0, 0, 0], [-10, -10, 0]), [[0, 1], [2]], 'the gap to the next section is not in the page');
  assert.deepEqual(pack([100, 100], 150, [30, 30], [-20, 0]), [[0], [1]]);
  assert.deepEqual(pack([100, 100], 160, null, null), [[0], [1]], 'no margins given: as before');
});

await test('autoSections: most frequent heading level (shallower on a tie), preamble is a section', async () => {
  const { w } = await open('<p>x</p>');
  const sectionsOf = (html, root) => { const r = el(w, html); const s = w.autoSections(r); return s && { starts: Array.from(s.starts), labels: Array.from(s.labels) }; };
  assert.deepEqual(sectionsOf('<h2>T</h2><p>a</p><h3>A</h3><p>b</p><h3>B</h3><p>c</p><h3>C</h3>'),
    { starts: [0, 2, 4, 6], labels: ['T', 'A', 'B', 'C'] });
  assert.deepEqual(sectionsOf('<p>lead</p><h2>A</h2><p>x</p><h2>B</h2><p>y</p>'),
    { starts: [0, 1, 3], labels: ['Intro', 'A', 'B'] });
  assert.deepEqual(sectionsOf('<h3>x</h3><h2>A</h2><h2>B</h2><h3>y</h3>').starts, [0, 1, 2], 'a tie: h2 wins');
  assert.deepEqual(sectionsOf('<h1>A</h1><p>x</p><h1>B</h1><h2>a</h2><h2>b</h2><h2>c</h2>'),
    { starts: [0, 3, 4, 5], labels: ['A', 'a', 'b', 'c'] }, 'h2 is the most frequent');
  assert.equal(sectionsOf('<h2>only</h2><p>a</p>'), null, 'one heading is no structure');
  assert.equal(sectionsOf('<p>a</p><p>b</p><p>c</p>'), null);
  assert.equal(sectionsOf('<h4>a</h4><h4>b</h4><h4>c</h4>'), null, 'only h1-h3 count');
});

await test('autoSections: <section>/<article> blocks win when there are two or more and no fewer than headings', async () => {
  const { w } = await open('<p>x</p>');
  const s = w.autoSections(el(w, '<section><h2>A</h2></section><section><h2>B</h2></section><section><p>no heading</p></section>'));
  assert.deepEqual([Array.from(s.starts), Array.from(s.labels)], [[0, 1, 2], ['A', 'B', '3']]);
  const mixed = w.autoSections(el(w, '<p>lead</p><article><h2>A</h2></article><article><h2>B</h2></article>'));
  assert.deepEqual([Array.from(mixed.starts), Array.from(mixed.labels)], [[0, 1, 2], ['Intro', 'A', 'B']]);
  const more = w.autoSections(el(w, '<section>a</section><section>b</section><h3>1</h3><h3>2</h3><h3>3</h3>'));
  assert.deepEqual(Array.from(more.starts), [0, 2, 3, 4], 'three headings beat two sections');
});

await test('labels: heading text, whitespace squeezed, cut at 28 with an ellipsis; Intro; numbers', async () => {
  const { w } = await open('<p>x</p>');
  const labels = (html) => Array.from(w.autoSections(el(w, html)).labels);
  const long = 'A very long heading that goes on and on';
  assert.deepEqual(labels(`<p>p</p><h3>  A\n  B  </h3><h3>${long}</h3><h3>C</h3>`),
    ['Intro', 'A B', long.slice(0, 27) + '…', 'C']);
  assert.equal(labels('<h3>x</h3><h3>y</h3>')[0], 'x');
});

await test('autoRoot: through wrappers that hold nothing else; stops at two blocks, text, or a list', async () => {
  const { w, stage } = await open('<p>x</p>');
  const root = (html) => { stage.innerHTML = html; return w.autoRoot(stage); };
  const r = root('<div id="a"><section id="b"><h3>x</h3><h3>y</h3></section></div>');
  assert.deepEqual([Array.from(r.chain, (n) => n.id), r.root.id, r.styled], [['a', 'b'], 'b', false]);
  assert.equal(root('<div id="a">  <div id="b"><p>1</p><p>2</p></div>  </div>').root.id, 'b', 'whitespace is not content');
  assert.equal(root('<div id="a">text<div id="b"><p>1</p></div></div>').root.id, 'a', 'text beside it: stop');
  assert.equal(root('<div id="a"><p>1</p></div><div id="c"></div>').chain.length, 0, 'two blocks');
  assert.equal(root('<ul id="u"><li>1</li></ul>').chain.length, 0, 'a list is not a wrapper');
  assert.equal(root('<div><style>p{}</style><div><p>1</p></div></div>'), null, 'a <style> inside a wrapper would be lost');
});

await test('planned only when it is above 1.3 areas, has three sections, and is more than one page', async () => {
  assert.equal(S((await open(FIVE, { area: 480 })).w).plan, null, '500 px is not above 1.3 * 480');
  assert.equal(S((await open(FIVE, { area: 385 })).w).plan, null, '500 px is not above 1.3 * 385 = 500.5');
  assert.ok(S((await open(FIVE, { area: 380 })).w).plan, 'above 1.3 * 380 = 494');
  assert.equal(S((await open(sec('One', 300) + sec('Two', 300), { area: 200 })).w).plan, null, 'two sections');
  assert.equal(S((await open(FIVE, { area: 1000 })).w).plan, null, 'one page would do');
});

// ── pages ───────────────────────────────────────────────────────────────────
await test('a long answer becomes pages named by their first heading, with an All button', async () => {
  const t = await open(FIVE, { area: 300 });                         // capacity 300-46+6 = 260: 2 sections a page
  assert.deepEqual(t.tabs(), ['Title', 'Two', 'Four']);
  assert.deepEqual(t.extras(), ['All']);
  assert.equal(t.env.txt('back-type-badge'), 'html · 3 pages');
  assert.match(t.panelText(0), /Title.*intro.*One.*text of One/);
  const second = t.stage.querySelectorAll('.fc-tabpanel')[1];
  assert.equal(second.hasChildNodes(), false, 'lazy: not mounted before it is shown');
  t.stage.querySelectorAll('.fc-tab')[1].click();
  assert.match(t.panelText(1), /^Two.*text of Two.*Three.*text of Three$/);
  t.stage.querySelectorAll('.fc-tab')[2].click();
  assert.match(t.panelText(2), /^Four.*text of Four$/);
  assert.equal(t.env.$('btn-expand').hidden, false, 'Expand is offered with pages');
});

await test('the pages are copies: the wrapper and its style come with each page; the cell is not touched', async () => {
  const t = await open(WRAP(FIVE), { area: 300 });
  assert.equal(t.tabs().length, 3);
  t.stage.querySelectorAll('.fc-tab')[1].click();
  const wrapper = t.stage.querySelectorAll('.fc-tabpanel')[1].querySelector('#outer');
  assert.equal(wrapper.getAttribute('style'), 'background:#111;padding-top:20px;padding-bottom:20px');
  assert.equal(wrapper.children.length, 4, 'two sections of two blocks');
  assert.equal(S(t.w).content, WRAP(FIVE), 'the source is exactly the cell');
  const { secs, info } = S(t.w).plan;
  assert.equal(secs.blocks.length, 10, 'the original nodes are kept for the copies');
  assert.ok(secs.blocks.every((b) => b.parentNode === info.root), 'and never moved into a page');
});

await test('the wrapper\'s padding is taken off the page: a page holds what fits inside it', async () => {
  // capacity = 300 - 46 - 40 (padding) + 6 = 220: two sections of 100 fit, three do not
  const t = await open(WRAP(FIVE), { area: 300 });
  assert.deepEqual(Array.from(S(t.w).plan.pages, (p) => Array.from(p)), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(Array.from(S(t.w).plan.heights).slice(0, 4), [100, 100, 100, 100], 'measured from the first block to the next section\'s');
});

await test('a styled card keeps its <style> on every page (a shadow root each)', async () => {
  const html = `<style>h3{color:red}</style>${WRAP(FIVE)}`;
  const t = await open(html, { area: 330 });          // minus the wrapper's 40 and the card's own 24
  assert.equal(t.tabs().length, 3);
  t.stage.querySelectorAll('.fc-tab')[2].click();
  const host = t.stage.querySelectorAll('.fc-tabpanel')[2].querySelector('.fc-styled');
  const css = Array.from(host.shadowRoot.querySelectorAll('style'), (n) => n.textContent).join('\n');
  assert.match(css, /h3\{color:red\}/, 'the card\'s own rule');
  assert.match(css, /\.fc-root \{ box-sizing/, 'and the base style of a styled card');
  assert.equal(host.shadowRoot.querySelector('.fc-root > #outer').children.length, 2);
});

await test('md: the headings of the rendered markdown are the sections', async () => {
  const { w } = await open('<p>x</p>');
  const md = '# Title\n\nintro\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n';
  const sections = w.autoSections(el(w, w.renderHtml(md, 'md')));
  assert.deepEqual([Array.from(sections.starts), Array.from(sections.labels)], [[0, 2, 4, 6], ['Title', 'A', 'B', 'C']]);
});

await test('author tabs win: nothing is split, no All button', async () => {
  const t = await open(`${FIVE}\n<!--tab-->\n${FIVE}`, { area: 300 });
  assert.equal(t.tabs().length, 2, 'the author\'s two tabs');
  assert.deepEqual(t.extras(), []);
  assert.equal(S(t.w).authored, true);
  assert.equal(t.env.txt('back-type-badge'), 'html · 2 tabs');
});

await test('other types and no structure: no pages; the fade and Expand still work', async () => {
  for (const [type, html] of [['text', FIVE], ['svg', '<svg></svg>'], ['html', sec('x', 900)]]) {
    const t = await open(html, { type, area: 300 });
    assert.equal(t.stage.querySelector('.fc-tabs'), null, type);
    assert.equal(S(t.w).plan, null, type);
  }
  const t = await open(sec('x', 900), { area: 300 });
  t.w.updateScrollHint();
  assert.equal(t.env.$('btn-expand').hidden, false, 'it scrolls: Expand');
  const short = await open(sec('x', 100), { area: 300 });
  short.w.updateScrollHint();
  assert.equal(short.env.$('btn-expand').hidden, true, 'it fits: nothing to expand');
});

// ── All / Pages ─────────────────────────────────────────────────────────────
await test('All: the whole answer with a bar of section links; Pages goes back; per device', async () => {
  const t = await open(FIVE, { area: 300 });
  t.stage.querySelector('.fc-extra').click();
  assert.equal(t.env.w.localStorage.getItem('flash.pages'), 'all');
  assert.deepEqual(t.tabs(), ['Title', 'One', 'Two', 'Three', 'Four']);
  assert.deepEqual(t.extras(), ['Pages']);
  assert.equal(t.stage.querySelector('.fc-tabs'), null, 'no tabs: the answer is one piece');
  assert.equal(t.env.txt('back-type-badge'), 'html · 5 sections');
  assert.equal(t.stage.querySelectorAll('h3').length, 4, 'the original nodes');
  assert.equal(t.stage.querySelector('[aria-label=Sections]').getAttribute('role'), 'group');
  t.stage.querySelector('.fc-extra').click();
  assert.equal(t.env.w.localStorage.getItem('flash.pages'), 'pages');
  assert.equal(t.tabs().length, 3);
});

await test('All is remembered: the next card of this device starts in it', async () => {
  const t = await open(FIVE, { area: 300, storage: { 'flash.pages': 'all' } });
  assert.deepEqual(t.extras(), ['Pages']);
  t.render(FIVE);
  assert.deepEqual(t.extras(), ['Pages']);
  assert.equal(t.stage.querySelectorAll('.fc-barrow').length, 1, 'one bar, not one per card');
});

await test('outline: a link scrolls its section to the top under the bar; the current one is marked', async () => {
  const t = await open(FIVE, { area: 300, storage: { 'flash.pages': 'all' } });
  const chips = Array.from(t.stage.querySelectorAll('.fc-tab'));
  const marked = () => chips.findIndex((c) => c.getAttribute('aria-current') === 'true');
  assert.equal(marked(), 0);
  Object.defineProperty(t.stage, 'scrollTop', { value: 0, writable: true, configurable: true });
  chips[3].click();
  assert.equal(t.stage.scrollTop, 298, 'section 3 starts 300 px down, 2 px of air above it (the bar has no height here)');
  chips[0].click();
  assert.equal(t.stage.scrollTop, 0);
  assert.equal(marked(), 0, 'the first link, and the first section is in view');
});

// ── the full-screen answer ──────────────────────────────────────────────────
await test('Expand: the whole answer on the whole screen (not in pages), titled; Escape closes it only', async () => {
  const t = await open(FIVE, { area: 300, title: 'Quiescent' });
  const { env, w } = t;
  assert.equal(env.$('reader').classList.contains('hidden'), true);
  env.$('btn-expand').click();
  assert.equal(env.$('reader').classList.contains('hidden'), false);
  assert.equal(env.$('reader-title').textContent, 'Quiescent');
  assert.equal(env.$('reader-body').querySelectorAll('h3').length, 4, 'all of it');
  assert.equal(env.$('reader-body').querySelector('.fc-tabs'), null, 'no pages in the reader');
  assert.equal(env.w.document.body.classList.contains('reader-open'), true);
  assert.ok(Array.from(env.w.document.querySelectorAll('.top-bar, .screen')).every((n) => n.hasAttribute('inert')));
  assert.equal(env.w.document.activeElement, env.$('reader'));
  env.key('Escape');
  assert.equal(env.$('reader').classList.contains('hidden'), true);
  assert.equal(w.isFlipped(), false, 'the card was not flipped by it');
  assert.equal(env.$('reader-body').childNodes.length, 0);
  assert.equal(env.w.document.body.classList.contains('reader-open'), false);
  assert.ok(Array.from(env.w.document.querySelectorAll('.top-bar, .screen')).every((n) => !n.hasAttribute('inert')), 'the page is usable again');
});

await test('E opens it from the answer, not from the hints side', async () => {
  const t = await open(FIVE, { area: 300 });
  assert.equal(t.env.key('e').defaultPrevented, false, 'on the hints side: not the answer');
  assert.equal(t.env.$('reader').classList.contains('hidden'), true);
  t.w.flipCard();
  assert.equal(t.env.key('e').defaultPrevented, true);
  assert.equal(t.env.$('reader').classList.contains('hidden'), false);
  assert.equal(t.w.openReader(), false, 'already open');
});

await test('modal: no rating, flip or page key reaches the card behind the full-screen answer', async () => {
  const t = await open(FIVE, { area: 300 });
  t.env.w.openReader();
  for (const k of ['1', '2', '3', '4', '5', 'Enter', ' ', 'Backspace', 'ArrowRight', 'u', 'z', 'h', 's', 'k', 'e']) {
    t.env.key(k);
  }
  assert.equal(t.env.srv.saved.length, 0);
  assert.equal(t.stage.querySelector('.fc-tab[aria-selected=true]').textContent, 'Title', 'the page did not move');
  assert.equal(t.env.$('reader').classList.contains('hidden'), false);
  assert.equal(t.env.key('Escape').defaultPrevented, true);
  assert.equal(t.env.key('ArrowRight').defaultPrevented, false, 'closed: the keys are the card\'s again');
});

await test('the reader shows the author\'s tabs, ← / → move them, and a picture opens the viewer over it', async () => {
  const img = '<img id="p" src="https://e.test/p.png">';
  const t = await open(`<p>one</p>\n<!--tab: Two-->\n${img}`, { area: 300 });
  t.env.w.openReader();
  const body = t.env.$('reader-body');
  assert.deepEqual(Array.from(body.querySelectorAll('.fc-tab'), (b) => b.textContent), ['1', 'Two']);
  assert.equal(t.env.key('ArrowRight').defaultPrevented, true);
  const pic = body.querySelector('#p');
  pic.getBoundingClientRect = () => ({ width: 300, height: 200 });
  Object.defineProperty(pic, 'complete', { value: true });
  Object.defineProperty(pic, 'naturalWidth', { value: 300 });
  Object.defineProperty(pic, 'naturalHeight', { value: 200 });
  assert.equal(t.env.key('v').defaultPrevented, true);
  assert.equal(t.env.$('viewer').classList.contains('hidden'), false);
  t.env.key('Escape');
  assert.equal(t.env.$('viewer').classList.contains('hidden'), true, 'the viewer closes first');
  assert.equal(t.env.$('reader').classList.contains('hidden'), false, 'the reader is still there');
  t.env.key('Escape');
  assert.equal(t.env.$('reader').classList.contains('hidden'), true);
});

await test('another card closes the full-screen answer; focus goes back to where it was', async () => {
  const t = await open(FIVE, { area: 300 });
  const hints = t.env.$('btn-hint');
  hints.focus();
  t.env.w.openReader();
  t.render('<p>next</p>');
  assert.equal(t.env.$('reader').classList.contains('hidden'), true);
  assert.equal(t.env.w.document.activeElement, hints);
});

// ── when it is planned ──────────────────────────────────────────────────────
await test('pictures first: planned when they have loaded or failed, not before; another card cancels it', async () => {
  const t = await open('<p>x</p>', { area: 300 });
  let complete = false;
  Object.defineProperty(t.w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return complete; } });
  t.render(`<img id="i" src="https://e.test/i.png">${FIVE}`);
  assert.equal(t.stage.querySelector('.fc-tabs'), null, 'waiting for the picture');
  complete = true;
  t.stage.querySelector('#i').dispatchEvent(new t.w.Event('load'));
  assert.equal(t.tabs().length > 0, true, 'planned after the load');
  complete = false;
  t.render(`<img id="j" src="https://e.test/j.png">${FIVE}`);
  const old = t.stage.querySelector('#j');
  t.render('<p>other card</p>', 'text');                          // before the picture came
  complete = true;
  old.dispatchEvent(new t.w.Event('load'));                       // the first card's picture, late
  await sleep(10);
  assert.equal(t.stage.querySelector('.fc-tabs'), null, 'a late picture of the old card does nothing');
  assert.equal(S(t.w).area, null, 'it did not plan for the new card');
});

await test('a picture that never answers does not hold the pages back for ever', async () => {
  const t = await open('<p>x</p>', { area: 300 });
  Object.defineProperty(t.w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return false; } });
  t.render(`<img src="https://e.test/never.png">${FIVE}`);
  assert.equal(t.stage.querySelector('.fc-tabs'), null);
  await sleep(1650);
  assert.ok(t.stage.querySelector('.fc-tabs'), 'after AUTO_IMAGE_WAIT_MS');
});

await test('an answer that is being read (scrolled, flipped) is not rearranged under the reader', async () => {
  const t = await open('<p>x</p>', { area: 300 });
  Object.defineProperty(t.w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return false; } });
  t.render(`<img src="https://e.test/slow.png">${FIVE}`);
  t.w.flipCard();
  Object.defineProperty(t.stage, 'scrollTop', { value: 120, configurable: true });
  t.stage.querySelector('img').dispatchEvent(new t.w.Event('load'));
  assert.equal(t.stage.querySelector('.fc-tabs'), null);
});

await test('a new size plans again; the address bar moving does not', async () => {
  const t = await open(FIVE, { area: 300 });
  assert.equal(t.tabs().length, 3);
  const was = S(t.w).token;
  fakeLayout(t.w, 270);                                           // 10 % lower: the address bar and a bit
  t.w.dispatchEvent(new t.w.Event('resize'));
  await sleep(300);
  assert.equal(S(t.w).token, was, 'not rendered again');
  fakeLayout(t.w, 200);                                           // another size: capacity 160, one section a page
  t.w.dispatchEvent(new t.w.Event('resize'));
  await sleep(300);
  assert.equal(S(t.w).token, was + 1);
  assert.equal(t.tabs().length, 5);
});

await test('resize with the viewer or the full-screen answer open waits', async () => {
  const t = await open(FIVE, { area: 300 });
  t.w.openReader();
  const was = S(t.w).token;
  fakeLayout(t.w, 200);
  t.w.dispatchEvent(new t.w.Event('resize'));
  await sleep(300);
  assert.equal(S(t.w).token, was);
  assert.equal(t.env.$('reader').classList.contains('hidden'), false);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
