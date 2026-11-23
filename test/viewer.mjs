// Run: node test/viewer.mjs   (needs: npm install --no-save playwright@1.63.0 && npx playwright install chromium)
// Real Chromium: the picture viewer (fit and zoom modes, keys, tabs, touch and mouse gestures),
// the fade under an answer that scrolls, and the taller answer area on a desktop screen.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.join(here, '..', 'index.html');

// A picture with a label per 200 px, as a data URI (loads offline).
const picture = (w, h) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#223"/>` +
  `<text x="20" y="60" fill="#fff" font-size="40">${w}x${h}</text></svg>`);
const img = (w, h, extra = '') => `<img src="${picture(w, h)}" ${extra}>`;
const SVG = '<svg viewBox="0 0 400 200" style="width:100%"><rect width="400" height="200" fill="#4fc3f7"/></svg>';

function stub(content) {
  return `window.marked = { parse: (x) => x };
window.DOMPurify = { isSupported: true, sanitize: (x) => x, addHook() {} };   // the page is the test's own
window.__saved = 0;
const cards = [{ id: '1', title: 'T', keywords: 'a;b;c', back_content: ${JSON.stringify(content)}, back_type: 'html' }];
const mk = (ok, bad) => new Proxy({}, { get(_, fn) {
  if (fn === 'withSuccessHandler') return (f) => mk(f, bad);
  if (fn === 'withFailureHandler') return (f) => mk(ok, f);
  return () => setTimeout(() => {
    if (fn === 'bootstrap') ok({ stats: { total: 1, due: 1, new: 1, review: 0 }, cards: cards.map((c) => ({ ...c })) });
    else if (fn === 'updateCard') { window.__saved++; ok({ ok: true }); }
  }, 0);
} });
window.google = { script: { run: mk(() => {}, () => {}) } };`;
}

const browser = await chromium.launch();
let failed = 0;
async function test(name, view, content, fn) {
  const ctx = await browser.newContext({ viewport: { width: view.w, height: view.h },
    isMobile: !!view.touch, hasTouch: !!view.touch, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => (r.request().url().startsWith('http') ? r.abort() : r.continue()));
  await page.addInitScript(stub(content));
  try {
    await page.goto(pageUrl);
    await page.waitForSelector('#s-home:not(.hidden)');
    await page.click('#startBtn');
    await page.waitForSelector('#s-session:not(.hidden)');
    await page.evaluate(() => flipCard());
    await page.waitForTimeout(700);                       // flip transition
    await fn({ page, ctx });
    assert.deepEqual(errors, [], 'page errors');
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
  await ctx.close();
}

const DESKTOP = { w: 1280, h: 800 };
const PHONE = { w: 390, h: 844, touch: true };
const opened = (page) => page.evaluate(() => !document.getElementById('viewer').classList.contains('hidden'));
const view = (page) => page.evaluate(() => {
  const st = document.getElementById('viewer-stage');
  const cv = document.getElementById('viewer-canvas').getBoundingClientRect();
  return { sw: st.clientWidth, sh: st.clientHeight, cw: Math.round(cv.width), ch: Math.round(cv.height),
    zoom: viewer.zoom, scrollX: st.scrollWidth > st.clientWidth + 1, scrollY: st.scrollHeight > st.clientHeight + 1,
    left: st.scrollLeft, top: st.scrollTop, count: document.getElementById('viewer-count').textContent };
});
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const hiddenBtn = (page, id) => page.evaluate((i) => document.getElementById('viewer-' + i).hidden, id);

// ── height and fade ─────────────────────────────────────────────────────────
const longText = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1}</p>`).join('');
await test('desktop: the answer area is taller than before, the page does not scroll, ratings in view',
  DESKTOP, longText, async ({ page }) => {
    const m = await page.evaluate(() => ({
      area: document.getElementById('back-content').getBoundingClientRect().height,
      over: document.scrollingElement.scrollHeight - innerHeight,
      rate: document.querySelector('.rating-grid').getBoundingClientRect().bottom <= innerHeight }));
    assert.ok(m.area >= 400, 'answer area ' + m.area + ' (was 305 at 1280x800)');
    assert.equal(m.over, 0);
    assert.equal(m.rate, true);
  });

await test('scroll fade: shown while there is more below, gone at the end, never on a short answer',
  DESKTOP, longText, async ({ page }) => {
    const state = () => page.evaluate(() => {
      const el = document.getElementById('back-content');
      const cs = getComputedStyle(el);
      return { more: el.classList.contains('more'), mask: cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none' };
    });
    assert.deepEqual(await state(), { more: true, mask: true });
    await page.evaluate(() => { const el = document.getElementById('back-content'); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(100);
    assert.deepEqual(await state(), { more: false, mask: false });
    await page.evaluate(() => { document.getElementById('back-content').scrollTop = 0; });
    await page.waitForTimeout(100);
    assert.equal((await state()).more, true);
  });

await test('scroll fade: not on a short answer', DESKTOP, '<p>short</p>', async ({ page }) => {
  assert.equal(await page.evaluate(() => document.getElementById('back-content').classList.contains('more')), false);
});

await test('scroll fade follows the tab: a tall tab fades, a short one does not', DESKTOP,
  `<p>short</p>\n<!--tab-->\n${longText}`, async ({ page }) => {
    const more = () => page.evaluate(() => document.getElementById('back-content').classList.contains('more'));
    assert.equal(await more(), false);
    await page.click('.fc-tab:nth-child(2)');
    await page.waitForTimeout(150);
    assert.equal(await more(), true);
    await page.click('.fc-tab:nth-child(1)');
    await page.waitForTimeout(150);
    assert.equal(await more(), false);
  });

// ── fit, zoom modes ─────────────────────────────────────────────────────────
await test('tall picture: opens fitted, Width / 100% / zoom buttons, Fit comes back', DESKTOP,
  img(800, 3200), async ({ page }) => {
    assert.equal(await opened(page), false);
    await page.click('#back-content img');
    assert.equal(await opened(page), true);
    let v = await view(page);
    assert.ok(v.cw <= v.sw && v.ch <= v.sh + 1, `fits: ${v.cw}x${v.ch} in ${v.sw}x${v.sh}`);
    assert.ok(near(v.ch, v.sh, 3) || near(v.cw, v.sw, 3), 'one side fills the screen');
    assert.equal(v.zoom, 1);
    assert.equal(await hiddenBtn(page, 'width'), false, 'a tall picture offers Width');
    assert.equal(await hiddenBtn(page, 'actual'), false);
    await page.click('#viewer-width');
    v = await view(page);
    assert.ok(near(v.cw, v.sw, 3), `Width: ${v.cw} vs ${v.sw}`);
    assert.equal(v.scrollY, true, 'then it scrolls down');
    await page.click('#viewer-actual');
    v = await view(page);
    assert.ok(near(v.cw, 800, 2) && near(v.ch, 3200, 2), `100%: ${v.cw}x${v.ch}`);
    await page.click('#viewer-fit');
    v = await view(page);
    assert.equal(v.zoom, 1);
    assert.ok(v.cw <= v.sw && v.ch <= v.sh + 1);
    const before = v.cw;
    await page.click('#viewer-in');
    assert.ok((await view(page)).cw > before, '+ enlarges');
    await page.click('#viewer-out');
    assert.ok(near((await view(page)).cw, before, 2), '- goes back');
    assert.equal(await page.evaluate(() => document.getElementById('viewer-out').disabled), true, 'at fit: nothing to zoom out');
  });

await test('wide picture on a phone: fits the width, Width hidden, 100% shows its pixels',
  PHONE, img(2400, 600), async ({ page }) => {
    await page.tap('#back-content img');
    assert.equal(await opened(page), true);
    let v = await view(page);
    assert.ok(near(v.cw, v.sw, 2), `fits the width: ${v.cw} vs ${v.sw}`);
    assert.equal(await hiddenBtn(page, 'width'), true, 'Width = Fit here');
    assert.equal(await hiddenBtn(page, 'actual'), false);
    await page.tap('#viewer-actual');
    v = await view(page);
    assert.ok(near(v.cw, 2400, 2) && near(v.ch, 600, 2));
    assert.equal(v.scrollX, true);
  });

await test('a small bitmap is enlarged to fit (at most 4x); an SVG scales to the screen', DESKTOP,
  `${img(200, 100)}\n<!--tab-->\n${SVG}`, async ({ page }) => {
    await page.click('#back-content img');
    let v = await view(page);
    assert.ok(near(v.cw, 800, 2) && near(v.ch, 400, 2), `bitmap capped at 4x: ${v.cw}x${v.ch}`);
    await page.keyboard.press('Escape');
    await page.click('.fc-tab:nth-child(2)');
    await page.click('#back-content .fc-tabpanel:not([hidden]) svg');
    v = await view(page);
    assert.ok(near(v.cw, v.sw, 2) || near(v.ch, v.sh, 2), `svg fills one side: ${v.cw}x${v.ch} in ${v.sw}x${v.sh}`);
    assert.equal(await hiddenBtn(page, 'actual'), true, 'no 100% for a vector');
  });

// ── what opens and what does not ────────────────────────────────────────────
await test('not offered: an icon, a picture inside a link; offered: an inline SVG', DESKTOP,
  `${img(24, 24, 'id="icon"')}<a href="#x">${img(300, 200, 'id="linked"')}</a>${SVG}`, async ({ page }) => {
    await page.click('#icon');
    assert.equal(await opened(page), false);
    await page.click('#linked');
    assert.equal(await opened(page), false, 'the link keeps its click');
    await page.click('#back-content svg');
    assert.equal(await opened(page), true);
    assert.equal(await page.evaluate(() => document.querySelector('#viewer-canvas svg').getAttribute('viewBox')), '0 0 400 200');
  });

await test('V opens the first picture of the answer; nothing to open: the key is left alone', DESKTOP,
  `<p>text</p>${img(300, 200)}`, async ({ page }) => {
    await page.keyboard.press('v');
    assert.equal(await opened(page), true);
    await page.keyboard.press('Escape');
    assert.equal(await opened(page), false);
    assert.equal(await page.evaluate(() => isFlipped()), true, 'Esc closed the viewer, not the answer');
  });

await test('V on an answer without a picture does nothing', DESKTOP, '<p>text</p>', async ({ page }) => {
  await page.keyboard.press('v');
  assert.equal(await opened(page), false);
});

// ── modal: the keys behind it ───────────────────────────────────────────────
await test('while open: no rating, no flip back, no tab change; Esc closes, then keys work again',
  DESKTOP, `${img(300, 200)}\n<!--tab-->\n<p>two</p>`, async ({ page }) => {
    await page.click('#back-content img');
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => __saved), 0, 'nothing was rated');
    assert.equal(await page.evaluate(() => isFlipped()), true);
    assert.equal(await page.evaluate(() => document.querySelector('.fc-tab[aria-selected=true]').textContent), '1', 'tab did not move');
    assert.equal(await opened(page), true);
    await page.keyboard.press('Escape');
    assert.equal(await opened(page), false);
    assert.equal(await page.evaluate(() => isFlipped()), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.querySelector('.fc-tab[aria-selected=true]').textContent), '2', 'tabs work again');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => isFlipped()), false, 'now Esc goes back to the hints');
  });

await test('background: inert and not scrollable while open; focus returns on close', DESKTOP,
  img(300, 200), async ({ page }) => {
    await page.click('#back-content img');
    const m = await page.evaluate(() => ({
      bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
      inert: [...document.querySelectorAll('.top-bar, .screen')].every((n) => n.hasAttribute('inert')),
      focus: document.activeElement.id }));
    assert.deepEqual(m, { bodyLocked: true, inert: true, focus: 'viewer' });
    await page.click('#viewer-close');
    const after = await page.evaluate(() => ({
      locked: document.body.classList.contains('viewer-open'),
      inert: document.querySelectorAll('[inert]').length }));
    assert.equal(after.locked, false);
    assert.equal(after.inert, 1, 'only the back face keeps its own inert');
  });

await test('Tab stays inside the viewer', DESKTOP, `${img(300, 200)}${img(300, 200)}`, async ({ page }) => {
  await page.click('#back-content img');
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => document.activeElement.closest('#viewer') ? document.activeElement.id : 'OUTSIDE'));
  }
  assert.equal(seen.has('OUTSIDE'), false);
  assert.ok(seen.size >= 4);
});

// ── pictures of a tab ───────────────────────────────────────────────────────
await test('several pictures: counter, arrows move between them (not tabs), stop at the ends',
  DESKTOP, `${img(300, 200)}${img(500, 300)}${img(400, 400)}\n<!--tab-->\n${img(300, 100)}`, async ({ page }) => {
    await page.click('#back-content img:nth-of-type(2)');
    assert.equal((await view(page)).count, '2 / 3');
    await page.keyboard.press('ArrowRight');
    assert.equal((await view(page)).count, '3 / 3');
    await page.keyboard.press('ArrowRight');
    assert.equal((await view(page)).count, '3 / 3');
    assert.equal(await page.evaluate(() => document.getElementById('viewer-next').disabled), true);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal((await view(page)).count, '1 / 3');
    assert.equal(await page.evaluate(() => document.querySelector('.fc-tab[aria-selected=true]').textContent), '1');
  });

await test('keys in the viewer: + - 0 W 1', DESKTOP, img(800, 3200), async ({ page }) => {
  await page.keyboard.press('v');
  const w = async () => (await view(page)).cw;
  const fit = await w();
  await page.keyboard.press('+');
  assert.ok(await w() > fit);
  await page.keyboard.press('-');
  assert.ok(near(await w(), fit, 2));
  await page.keyboard.press('w');
  assert.ok(near(await w(), (await view(page)).sw, 3));
  await page.keyboard.press('1');
  assert.ok(near(await w(), 800, 2));
  await page.keyboard.press('0');
  assert.ok(near(await w(), fit, 2));
});

// ── mouse ───────────────────────────────────────────────────────────────────
await test('mouse: double click toggles the zoom, drag pans, Ctrl+wheel zooms at the pointer', DESKTOP,
  img(2400, 1600), async ({ page }) => {
    await page.click('#back-content img');
    const box = await page.evaluate(() => { const r = document.getElementById('viewer-stage').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.dblclick(box.x, box.y);
    let v = await view(page);
    assert.ok(v.zoom > 1.5, 'zoomed in: ' + v.zoom);
    assert.equal(v.scrollX || v.scrollY, true);
    const left = v.left;
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y - 80, { steps: 6 });
    await page.mouse.up();
    v = await view(page);
    assert.ok(v.left > left + 60, `dragged left pans right: ${left} -> ${v.left}`);
    assert.equal(await opened(page), true, 'a drag is not a tap');
    await page.mouse.dblclick(box.x, box.y);
    assert.equal((await view(page)).zoom, 1);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    assert.ok((await view(page)).zoom > 1, 'Ctrl+wheel zooms');
  });

await test('mouse: a click beside the picture closes, a click on it does not', DESKTOP,
  img(300, 900), async ({ page }) => {
    await page.click('#back-content img');
    const r = await page.evaluate(() => { const p = document.querySelector('.viewer-pic').getBoundingClientRect(); return { l: p.left, r: p.right, cy: p.top + p.height / 2 }; });
    await page.mouse.click((r.l + r.r) / 2, r.cy);
    await page.waitForTimeout(350);
    assert.equal(await opened(page), true);
    await page.mouse.click(r.l - 80, r.cy);
    assert.equal(await opened(page), false);
  });

// ── touch ───────────────────────────────────────────────────────────────────
async function touch(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  return {
    async drag(x0, y0, x1, y1, steps = 6) {
      await send('touchStart', [{ x: x0, y: y0, id: 1 }]);
      for (let i = 1; i <= steps; i++) await send('touchMove', [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, id: 1 }]);
      await send('touchEnd', []);
    },
    async pinch(cx, cy, d0, d1, steps = 8) {
      const at = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
      await send('touchStart', at(d0));
      for (let i = 1; i <= steps; i++) await send('touchMove', at(d0 + (d1 - d0) * i / steps));
      await send('touchEnd', []);
    },
    async tap(x, y) { await send('touchStart', [{ x, y, id: 1 }]); await send('touchEnd', []); },
  };
}
const centre = (page) => page.evaluate(() => { const r = document.getElementById('viewer-stage').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

await test('touch: tap opens; pinch zooms, pinch back returns to fit; one finger pans; double tap toggles',
  PHONE, img(1600, 1200), async ({ page, ctx }) => {
    const t = await touch(ctx, page);
    await page.tap('#back-content img');
    assert.equal(await opened(page), true);
    const c = await centre(page);
    await t.pinch(c.x, c.y, 60, 180);
    let v = await view(page);
    assert.ok(v.zoom > 2, 'pinched out: ' + v.zoom);
    const left = v.left;
    await t.drag(c.x + 80, c.y, c.x - 40, c.y);
    v = await view(page);
    assert.ok(v.left > left + 60, `one finger pans: ${left} -> ${v.left}`);
    assert.equal(await opened(page), true);
    await t.pinch(c.x, c.y, 200, 40);
    assert.equal((await view(page)).zoom, 1, 'pinched in below fit: stops at fit');
    await t.tap(c.x, c.y);
    await page.waitForTimeout(60);
    await t.tap(c.x, c.y);
    assert.ok((await view(page)).zoom > 1.5, 'double tap zooms in');
    await t.tap(c.x, c.y);
    await page.waitForTimeout(60);
    await t.tap(c.x, c.y);
    assert.equal((await view(page)).zoom, 1, 'double tap again: fit');
  });

await test('touch: a tap on the dark area beside a tall picture closes the viewer', PHONE,
  img(200, 1200), async ({ page, ctx }) => {
    const t = await touch(ctx, page);
    await page.tap('#back-content img');
    const r = await page.evaluate(() => { const p = document.querySelector('.viewer-pic').getBoundingClientRect(); return { l: p.left, cy: p.top + p.height / 2 }; });
    await t.tap(r.l - 20, r.cy);
    await page.waitForTimeout(200);                         // the click that follows the tap lands below
    assert.equal(await opened(page), false, 'not reopened by the click on the picture underneath');
  });

await test('phone: the tool bar fits the screen (wraps, never scrolls sideways) and buttons are 44 px',
  PHONE, `${img(800, 3200)}${img(300, 200)}`, async ({ page }) => {
    await page.tap('#back-content img');
    const m = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.viewer-btn:not([hidden])')].map((b) => b.getBoundingClientRect());
      return { minW: Math.min(...btns.map((b) => b.width)), minH: Math.min(...btns.map((b) => b.height)),
        overflowX: document.getElementById('viewer').scrollWidth > innerWidth + 1,
        right: Math.max(...btns.map((b) => b.right)) };
    });
    assert.ok(m.minW >= 44 && m.minH >= 44, JSON.stringify(m));
    assert.equal(m.overflowX, false);
    assert.ok(m.right <= 390, 'buttons inside the screen: ' + m.right);
  });

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
