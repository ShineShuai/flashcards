// Run: node test/ui/viewer.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// The picture viewer's logic without a layout engine: zoom arithmetic, which pictures are
// offered, the keys (the viewer is modal), focus and inert, the fade under a scrolling answer.
// Gestures and real sizes are in test/viewer.mjs (Chromium).
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

const IMG = (id, extra = '') => `<img id="${id}" src="https://e.test/${id}.png" ${extra}>`;
const SVG = '<svg id="s" viewBox="0 0 400 200"><circle r="5"/></svg>';

// jsdom has no layout and loads no pictures: say how big each picture is and that it loaded.
function size(el, w, h, natural = [w, h]) {
  el.getBoundingClientRect = () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h });
  if (el.localName === 'img') {
    Object.defineProperty(el, 'complete', { value: true });
    Object.defineProperty(el, 'naturalWidth', { value: natural[0] });
    Object.defineProperty(el, 'naturalHeight', { value: natural[1] });
  }
}
async function back(content, sizes = {}) {
  const env = boot({ cards: [card('1', 'a;b', { back_content: content, back_type: 'html' })], realMarkdown: true });
  await env.start();
  env.w.flipCard();
  await sleep(5);
  const stage = env.$('back-content');
  for (const [id, dims] of Object.entries(sizes)) {
    size(stage.querySelector('#' + id), ...dims);
  }
  // the screen the viewer's stage has
  const vs = env.$('viewer-stage');
  Object.defineProperty(vs, 'clientWidth', { value: 400 });
  Object.defineProperty(vs, 'clientHeight', { value: 300 });
  return { env, stage, w: env.w, open: () => !env.$('viewer').classList.contains('hidden') };
}
const V = (w) => w.eval('viewer');                      // the viewer's state (a script-level const)
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));

// ── arithmetic ──────────────────────────────────────────────────────────────
await test('zoom arithmetic: fit, width, actual, limits', async () => {
  const { w } = await back('<p>x</p>');
  const v = (o) => ({ w: 800, h: 3200, raster: true, fit: 0.09375, zoom: 1, sw: 400, sh: 300, ...o });
  assert.equal(w.viewerFitScale(400, 300, 800, 600, Infinity), 0.5);
  assert.equal(w.viewerFitScale(400, 300, 800, 3200, Infinity), 0.09375);
  assert.equal(w.viewerFitScale(400, 300, 10, 5, 4), 4, 'a small bitmap: capped');
  assert.equal(w.viewerFitScale(400, 300, 10, 5, Infinity), 40, 'a vector: the screen is the limit');
  assert.equal(w.viewerFitScale(400, 300, 100, 50, 4), 4);
  assert.equal(w.viewerFitScale(0, 0, 800, 600, 4), 1, 'no layout yet');
  assert.equal(w.viewerFitScale(400, 300, 0, 0, 4), 1);
  assert.equal(w.viewerActualZoom(v()), 1 / 0.09375);
  assert.equal(w.viewerActualZoom(v({ raster: false })), 1);
  assert.equal(Math.round(w.viewerWidthZoom(v()) * 1000) / 1000, 5.333);
  assert.deepEqual(Array.from(w.viewerSize(v({ zoom: 2 }))), [150, 600]);
  assert.equal(w.viewerClampZoom(0.2, v()), 1, 'never below fit');
  assert.equal(w.viewerClampZoom(1e6, v()), w.viewerMaxZoom(v()));
  assert.ok(w.viewerMaxZoom(v()) >= 2 * w.viewerActualZoom(v()) - 1e-9, 'a bitmap goes to twice its pixels');
  assert.ok(w.viewerMaxZoom(v({ w: 20000, h: 20000, fit: 0.01 })) * 20000 * 0.01 <= 16000 + 1e-6, 'capped in pixels');
  assert.equal(w.viewerMaxZoom(v({ w: 1, h: 1, fit: 1e9 })), 1, 'never below 1');
});

// ── what is offered ─────────────────────────────────────────────────────────
await test('a click on a loaded picture opens the viewer with a copy; Escape closes', async () => {
  const { env, stage, w, open } = await back(IMG('a'), { a: [300, 200] });
  click(w, stage.querySelector('#a'));
  assert.equal(open(), true);
  const pic = env.$('viewer-canvas').querySelector('img');
  assert.equal(pic.getAttribute('src'), 'https://e.test/a.png');
  assert.notEqual(pic, stage.querySelector('#a'));
  assert.equal(env.$('viewer-count').textContent, '', 'one picture: no counter');
  assert.equal(env.$('viewer-prev').hidden, true);
  assert.equal(env.key('Escape').defaultPrevented, true);
  assert.equal(open(), false);
  assert.equal(env.$('viewer-canvas').childNodes.length, 0);
});

await test('not offered: an icon, a picture that did not load, one inside a link, a click on a link', async () => {
  const { stage, w, open } = await back(
    `${IMG('icon')}${IMG('broken')}<a href="#x">${IMG('linked')}</a>${IMG('ok')}`,
    { icon: [24, 24], linked: [300, 200], ok: [300, 200] });
  size(stage.querySelector('#broken'), 300, 200, [0, 0]);                  // naturalWidth 0
  for (const id of ['icon', 'broken', 'linked']) {
    click(w, stage.querySelector('#' + id));
    assert.equal(open(), false, id);
  }
  click(w, stage.querySelector('#ok'));
  assert.equal(open(), true);
});

await test('a small icon-sized image of a large picture is offered; a button inside the answer is not', async () => {
  const { stage, w, open } = await back(`${IMG('thumb')}<button id="b">${IMG('inbtn')}</button>`,
    { inbtn: [300, 200] });
  size(stage.querySelector('#thumb'), 40, 40, [800, 600]);
  click(w, stage.querySelector('#thumb'));
  assert.equal(open(), true, 'natural size says it is a picture');
  w.viewerClose();
  await sleep(520);
  click(w, stage.querySelector('#inbtn'));
  assert.equal(open(), false);
});

await test('an inline SVG opens as a copy with a viewBox; nested SVGs count once', async () => {
  const { env, stage, w, open } = await back('<svg id="outer" viewBox="0 0 400 200"><svg id="inner" width="10" height="10"></svg></svg>',
    { outer: [400, 200], inner: [100, 100] });
  click(w, stage.querySelector('#inner'));
  assert.equal(open(), true, 'a click inside opens the outermost');
  assert.equal(env.$('viewer-canvas').querySelector('svg').getAttribute('viewBox'), '0 0 400 200');
  assert.equal(V(w).items.length, 1);
  assert.equal(V(w).raster, false);
});

await test('an SVG without viewBox gets one from its width and height, else from its size', async () => {
  const a = await back('<svg id="s" width="120" height="60"></svg>', { s: [120, 60] });
  click(a.w, a.stage.querySelector('#s'));
  const svgA = a.env.$('viewer-canvas').querySelector('svg');
  assert.equal(svgA.getAttribute('viewBox'), '0 0 120 60');
  assert.equal(svgA.hasAttribute('width'), false);
  const b = await back('<svg id="s"></svg>', { s: [250, 90] });
  click(b.w, b.stage.querySelector('#s'));
  assert.equal(b.env.$('viewer-canvas').querySelector('svg').getAttribute('viewBox'), '0 0 250 90');
});

await test('pictures of the visible tab only; a picture in a styled card is found', async () => {
  const { env, stage, w } = await back(`${IMG('a')}\n<!--tab-->\n${IMG('b')}\n<!--tab-->\n<style>p{color:red}</style><p>x</p>${IMG('c')}`,
    { a: [300, 200] });
  assert.deepEqual(Array.from(w.viewerCollect(w.viewerScope()), (n) => n.id), ['a']);
  w.tabsStep(stage, 1);
  size(stage.querySelector('#b'), 300, 200);
  assert.deepEqual(Array.from(w.viewerCollect(w.viewerScope()), (n) => n.id), ['b']);
  w.tabsStep(stage, 1);
  const host = stage.querySelector('.fc-tabpanel:not([hidden]) .fc-styled');
  size(host.shadowRoot.querySelector('#c'), 300, 200);
  assert.deepEqual(Array.from(w.viewerCollect(w.viewerScope()), (n) => n.id), ['c']);
  click(w, host.shadowRoot.querySelector('#c'));
  assert.equal(env.$('viewer').classList.contains('hidden'), false, 'a click in a shadow root opens it');
});

// ── keys ────────────────────────────────────────────────────────────────────
await test('V opens the first picture; with none it is left alone; not on the front', async () => {
  const none = await back('<p>text</p>');
  assert.equal(none.env.key('v').defaultPrevented, false);
  const { env, w, open } = await back(`${IMG('a')}${IMG('b')}`, { a: [300, 200], b: [300, 200] });
  w.unflipCard();
  await sleep(5);
  assert.equal(env.key('v').defaultPrevented, false, 'front face');
  w.flipCard();
  await sleep(5);
  assert.equal(env.key('v').defaultPrevented, true);
  assert.equal(open(), true);
  assert.equal(env.$('viewer-count').textContent, '1 / 2');
});

await test('modal: no rating, flip back or tab change while it is open; all work again after', async () => {
  const { env, w, open } = await back(`${IMG('a')}\n<!--tab-->\n<p>two</p>`, { a: [300, 200] });
  w.viewerOpenFirst();
  for (const k of ['1', '2', '3', '4', '5', 'Enter', ' ', 'Backspace', 'ArrowRight', 'u', 'z', 'h', 's', 'k']) {
    env.key(k);
  }
  assert.equal(env.srv.saved.length, 0, 'nothing rated');
  assert.equal(w.isFlipped(), true);
  assert.equal(env.$('back-content').querySelector('.fc-tab[aria-selected=true]').textContent, '1');
  assert.equal(open(), true);
  env.key('Escape');
  assert.equal(open(), false);
  assert.equal(w.isFlipped(), true, 'Escape closed the viewer only');
  env.key('ArrowRight');
  assert.equal(env.$('back-content').querySelector('.fc-tab[aria-selected=true]').textContent, '2');
  env.key('Escape');
  assert.equal(w.isFlipped(), false);
});

await test('a modifier is left to the browser (Ctrl+0 is page zoom, not Fit)', async () => {
  const { env, w } = await back(IMG('a'), { a: [300, 200] });
  w.viewerOpenFirst();
  V(w).zoom = 2;
  for (const k of ['0', '+', '-', '1', 'w', 'Escape']) {
    assert.equal(env.key(k, { ctrlKey: true }).defaultPrevented, false, k);
    assert.equal(env.key(k, { metaKey: true }).defaultPrevented, false, k);
  }
  assert.equal(V(w).zoom, 2);
});

await test('keys in the viewer: arrows between pictures (clamped), + - 0 f w 1', async () => {
  const { env, w } = await back(`${IMG('a')}${IMG('b')}${IMG('c')}`, { a: [800, 3200], b: [800, 3200], c: [800, 3200] });
  w.viewerOpenFirst();
  const count = () => env.$('viewer-count').textContent;
  assert.equal(count(), '1 / 3');
  env.key('ArrowLeft');
  assert.equal(count(), '1 / 3');
  env.key('ArrowRight');
  env.key('ArrowRight');
  env.key('ArrowRight');
  assert.equal(count(), '3 / 3');
  assert.equal(env.$('viewer-next').disabled, true);
  assert.equal(V(w).zoom, 1, 'a new picture starts fitted');
  env.key('+');
  assert.equal(V(w).zoom, 1.25);
  env.key('=');
  assert.equal(V(w).zoom, 1.5625);
  env.key('-');
  assert.equal(V(w).zoom, 1.25);
  env.key('w');
  assert.ok(Math.abs(V(w).zoom - 5.333333) < 1e-4, String(V(w).zoom));
  env.key('1');
  assert.ok(Math.abs(V(w).zoom - 1 / 0.09375) < 1e-9);
  env.key('0');
  assert.equal(V(w).zoom, 1);
  env.key('+');
  env.key('f');
  assert.equal(V(w).zoom, 1);
});

await test('buttons follow the state: Width and 100% only where they differ from Fit', async () => {
  const wide = await back(IMG('a'), { a: [1600, 400] });
  wide.w.viewerOpenFirst();
  assert.equal(wide.env.$('viewer-width').hidden, true, 'wide: Width = Fit');
  assert.equal(wide.env.$('viewer-actual').hidden, false);
  assert.equal(wide.env.$('viewer-out').disabled, true);
  assert.equal(wide.env.$('viewer-in').disabled, false);
  const tall = await back(IMG('a'), { a: [400, 3000] });
  tall.w.viewerOpenFirst();
  assert.equal(tall.env.$('viewer-width').hidden, false);
  const vec = await back(SVG, { s: [400, 200] });
  vec.w.viewerOpenFirst();
  assert.equal(vec.env.$('viewer-actual').hidden, true, 'a vector has no pixels');
  const small = await back(IMG('a'), { a: [300, 200] });
  small.w.viewerOpenFirst();
  assert.equal(small.env.$('viewer-actual').hidden, true, 'enlarged to fit already: 100% is smaller than Fit');
  while (!small.env.$('viewer-in').disabled) {
    small.w.viewerZoomBy(1.25);
  }
  assert.ok(V(small.w).zoom <= small.w.viewerMaxZoom(V(small.w)) * 1.001);
});

await test('double tap rule: zoomed goes to fit; at fit goes to actual size (at least 2x)', async () => {
  const { w } = await back(IMG('a'), { a: [2400, 1600] });
  w.viewerOpenFirst();
  w.viewerToggle();
  assert.ok(Math.abs(V(w).zoom - w.viewerActualZoom(V(w))) < 1e-9);
  w.viewerToggle();
  assert.equal(V(w).zoom, 1);
  const small = await back(IMG('a'), { a: [300, 200] });
  small.w.viewerOpenFirst();
  small.w.viewerToggle();
  assert.equal(V(small.w).zoom, 2);
});

// ── focus, inert, scroll lock ───────────────────────────────────────────────
await test('open: background inert and locked, focus in the viewer; close: all undone, focus back', async () => {
  const { env, stage, w } = await back(IMG('a'), { a: [300, 200] });
  const keep = env.$('btn-hint');
  keep.focus();
  w.viewerOpenFirst();
  const doc = env.w.document;
  assert.equal(doc.body.classList.contains('viewer-open'), true);
  assert.ok([...doc.querySelectorAll('.top-bar, .screen')].every((n) => n.hasAttribute('inert')));
  assert.equal(doc.activeElement, env.$('viewer'));
  const own = doc.querySelectorAll('[inert]').length;
  w.viewerClose();
  assert.equal(doc.body.classList.contains('viewer-open'), false);
  assert.ok(doc.querySelectorAll('[inert]').length < own);
  assert.equal(doc.activeElement, keep);
  w.viewerClose();                                        // closing twice is harmless
  assert.equal(stage.querySelector('#a') !== null, true);
});

await test('an element that was inert before stays inert after the viewer closes', async () => {
  const { env, w } = await back(IMG('a'), { a: [300, 200] });
  const screen = env.w.document.querySelector('.screen');
  screen.setAttribute('inert', '');
  w.viewerOpenFirst();
  w.viewerClose();
  assert.equal(screen.hasAttribute('inert'), true);
});

await test('rendering another card closes the viewer', async () => {
  const { env, w, open } = await back(IMG('a'), { a: [300, 200] });
  w.viewerOpenFirst();
  w.renderBack({ back_type: 'text', back_content: 'next' });
  assert.equal(open(), false);
  assert.equal(env.$('back-content').textContent, 'next');
});

await test('a click right after a tap closed the viewer does not reopen it (ghost click)', async () => {
  const { stage, w, open } = await back(IMG('a'), { a: [300, 200] });
  w.viewerOpenFirst();
  w.viewerClose();
  click(w, stage.querySelector('#a'));
  assert.equal(open(), false);
  await sleep(520);
  click(w, stage.querySelector('#a'));
  assert.equal(open(), true, 'a real click later opens it');
});

// ── the fade ────────────────────────────────────────────────────────────────
await test('fade class: on while there is more to scroll to, off at the end', async () => {
  const { env, w } = await back('<p>x</p>');
  const el = env.$('back-content');
  const set = (scrollHeight, scrollTop, clientHeight) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    w.updateScrollHint();
    return el.classList.contains('more');
  };
  assert.equal(set(1000, 0, 400), true);
  assert.equal(set(1000, 597, 400), true);
  assert.equal(set(1000, 598, 400), false, 'within 2 px of the end');
  assert.equal(set(1000, 600, 400), false);
  assert.equal(set(400, 0, 400), false, 'fits: no fade');
});

await test('the answer is marked zoomable; the fade is wired once however many cards are shown', async () => {
  const { env, w } = await back(IMG('a'), { a: [300, 200] });
  assert.equal(env.$('back-content').classList.contains('zoomable'), true);
  let calls = 0;
  const el = env.$('back-content');
  const real = el.addEventListener.bind(el);
  el.addEventListener = (...a) => { calls++; return real(...a); };
  for (let i = 0; i < 3; i++) {
    w.renderBack({ back_type: 'html', back_content: '<p>again</p>' });
  }
  assert.equal(calls, 0, 'no new listeners per card');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
