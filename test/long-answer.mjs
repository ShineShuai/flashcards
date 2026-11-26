// Run: node test/long-answer.mjs   (needs: npm install --no-save playwright@1.63.0 && npx playwright install chromium)
// Real Chromium: a long html or md answer without author tabs is split at its own headings into
// pages that fit the card, the All mode with its outline bar, the full-screen answer, and when each
// of it applies. The content is generic: made here from known heights, so what is expected follows
// from the sizes and from invariants (no heading lost, doubled or reordered; every page fits), not
// from the layout of one particular cell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
// The page is served over http by a route (nothing is fetched). Loaded from file://, Chromium
// sometimes dropped localStorage on a reload in a fresh context (9 of 40 runs), so "reload keeps
// All" failed at random; the app is fine, and Apps Script serves it over https anyway.
const pageUrl = 'http://flash.test/index.html';
const indexHtml = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

function stub(card) {
  return `window.marked = { parse: (md) => md.split(/\\n\\n+/).map((b) => /^## /.test(b) ? '<h2>' + b.slice(3) + '</h2>' : /^# /.test(b) ? '<h1>' + b.slice(2) + '</h1>' : '<p>' + b + '</p>').join('') };
window.DOMPurify = { isSupported: true, sanitize: (x) => x, addHook() {} };     // the page is the test's own
window.__saved = 0;
const cards = [${JSON.stringify(card)}];
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
async function test(name, view, content, fn, { type = 'html', mode = null, routes = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: view.w, height: view.h },
    isMobile: !!view.touch, hasTouch: !!view.touch, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => {
    const url = r.request().url();
    if (url === pageUrl) {
      return r.fulfill({ contentType: 'text/html', body: indexHtml });
    }
    return url.startsWith('http') ? r.abort() : r.continue();
  });
  if (routes) {
    await routes(page);
  }
  await page.addInitScript(stub({ id: '1', title: 'Sample card', keywords: 'a;b;c', back_content: content, back_type: type }));
  if (mode) {
    await page.addInitScript(`try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('flash.pages', '${mode}'); sessionStorage.setItem('seeded', '1'); } } catch (e) {}`);
  }
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

const PHONE = { w: 390, h: 844, touch: true };
const DESKTOP = { w: 1280, h: 800 };
const tabs = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#back-content .fc-tab'), (b) => b.textContent));
const extras = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#back-content .fc-extra'), (b) => b.textContent));
const fit = (page) => page.evaluate(() => { const bc = document.getElementById('back-content'); return { scrollH: bc.scrollHeight, h: bc.clientHeight }; });
const badge = (page) => page.evaluate(() => document.getElementById('back-type-badge').textContent);
const shown = (page, id) => page.evaluate((i) => !document.getElementById(i).classList.contains('hidden'), id);
const sideways = (page) => page.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1);
const block = (h, text = 'text') => `<p style="margin:0;height:${h}px">${text}</p>`;

// A page may run this far over (AUTO_SLACK_PX in the app) before it is split.
const SLACK = 8;
async function everyPageFits(page, n) {
  for (let i = 1; i <= n; i++) {
    await page.click(`.fc-tab:nth-child(${i})`);
    await page.waitForTimeout(60);
    const f = await fit(page);
    assert.ok(f.scrollH <= f.h + SLACK, `page ${i} scrolls: ${f.scrollH} in ${f.h}`);
  }
}

// A generic stand-in for third-party content: one wrapper <div> with a look of its own, a title
// and an intro, then sections under <h3> whose bodies have a known height.
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
function sample(heights = [110, 110, 110, 110, 110, 110], wrap = true) {
  const body = '<h2 style="margin:0 0 10px">Sample answer</h2><p style="margin:0;height:40px">Intro text.</p>' +
    heights.map((h, i) => `<h3 style="margin:14px 0 8px">${NAMES[i]}</h3><div style="height:${h}px">${NAMES[i]} body</div>`).join('');
  return wrap ? `<div style="max-width:700px;margin:0 auto;padding:16px;background:#1a1a1a;color:#e0e0e0;border-radius:12px">${body}</div>` : body;
}
const HEADINGS = ['Sample answer', ...NAMES];
// The headings of every page, in order: the same as the content has, none lost, doubled or moved.
async function headingsOfPages(page) {
  const n = (await tabs(page)).length;
  const all = [];
  for (let i = 1; i <= n; i++) {
    await page.click(`.fc-tab:nth-child(${i})`);
    await page.waitForTimeout(60);
    all.push(...await page.evaluate(() => Array.from(document.querySelectorAll('.fc-tabpanel:not([hidden]) h2, .fc-tabpanel:not([hidden]) h3'), (h) => h.textContent)));
  }
  return all;
}

// ── pages of a generic long answer ──────────────────────────────────────────
for (const [name, view] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  await test(`${name}: a long answer with a wrapper becomes pages: every heading once and in order, every page fits, nothing sideways`,
    view, sample(), async ({ page }) => {
      const names = await tabs(page);
      assert.ok(names.length >= 2 && names.length <= HEADINGS.length, 'pages: ' + names.join('|'));
      assert.equal(names[0], 'Sample answer');
      assert.ok(names.every((n) => HEADINGS.includes(n)), 'pages are named by one of their headings: ' + names.join('|'));
      assert.deepEqual(await extras(page), ['All']);
      assert.equal(await badge(page), `html · ${names.length} pages`);
      assert.deepEqual(await headingsOfPages(page), HEADINGS);
      await everyPageFits(page, names.length);
      assert.equal(await sideways(page), false);
      assert.equal(await page.evaluate(() => document.getElementById('btn-expand').hidden), false);
      const wrapper = await page.evaluate(() => { const w = document.querySelector('.fc-tabpanel:not([hidden]) > div'); return w && getComputedStyle(w).backgroundColor; });
      assert.equal(wrapper, 'rgb(26, 26, 26)', 'the wrapper\'s look is on every page');
    });
}

await test('the same answer without a wrapper is split the same way', PHONE, sample(undefined, false), async ({ page }) => {
  assert.deepEqual(await headingsOfPages(page), HEADINGS);
  await everyPageFits(page, (await tabs(page)).length);
});

await test('keys and swipe move between pages', PHONE, sample(), async ({ page, ctx }) => {
  const at = () => page.evaluate(() => Array.from(document.querySelectorAll('#back-content .fc-tab')).findIndex((b) => b.getAttribute('aria-selected') === 'true'));
  assert.ok((await tabs(page)).length >= 3);
  await page.keyboard.press('ArrowRight');
  assert.equal(await at(), 1);
  const cdp = await ctx.newCDPSession(page);
  const box = await page.evaluate(() => { const r = document.querySelector('.fc-tabbody').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await send('touchStart', [{ x: box.x + 90, y: box.y, id: 1 }]);
  for (let i = 1; i <= 6; i++) await send('touchMove', [{ x: box.x + 90 - 30 * i, y: box.y + i, id: 1 }]);
  await send('touchEnd', []);
  assert.equal(await at(), 2, 'a swipe left: next page');
});

await test('the card header (label, Hints, badge, Expand) stays inside the card on the smallest phones', { w: 320, h: 568, touch: true }, sample(), async ({ page }) => {
  const m = await page.evaluate(() => {
    const meta = document.querySelector('#face-back .card-meta');
    const edge = meta.getBoundingClientRect().right;
    const parts = Array.from(meta.querySelectorAll('.btn-flip, #back-type-badge, #btn-expand'), (n) => n.getBoundingClientRect());
    return { overflow: meta.scrollWidth > meta.clientWidth + 1, outside: parts.filter((r) => r.right > edge + 1).length, pageX: document.scrollingElement.scrollWidth > innerWidth + 1,
      expandVisible: !document.getElementById('btn-expand').hidden };
  });
  assert.deepEqual(m, { overflow: false, outside: 0, pageX: false, expandVisible: true });
});

// ── All and the outline ─────────────────────────────────────────────────────
await test('All: one answer with a bar of section links; a link brings its section up; reload keeps All',
  PHONE, sample(), async ({ page }) => {
    const pagesBefore = (await tabs(page)).length;
    assert.ok(pagesBefore >= 2);
    await page.click('#back-content .fc-extra');
    await page.waitForTimeout(100);
    assert.deepEqual(await tabs(page), HEADINGS, 'a link for every section, the preamble first');
    assert.deepEqual(await extras(page), ['Pages']);
    assert.equal(await badge(page), `html · ${HEADINGS.length} sections`);
    const f = await fit(page);
    assert.ok(f.scrollH > f.h * 1.5, 'the whole answer scrolls');
    const current = () => page.evaluate(() => Array.from(document.querySelectorAll('#back-content .fc-tab')).findIndex((c) => c.getAttribute('aria-current') === 'true'));
    await page.click('#back-content .fc-tab:nth-child(4)');                 // Gamma
    await page.waitForTimeout(150);
    const gap = await page.evaluate(() => {
      const bc = document.getElementById('back-content');
      const bar = bc.querySelector('.fc-barrow').getBoundingClientRect();
      const heading = Array.from(bc.querySelectorAll('h3')).find((h) => /Gamma/.test(h.textContent)).getBoundingClientRect();
      return Math.round(heading.top - bar.bottom);
    });
    assert.ok(gap >= -2 && gap <= 8, 'the heading is just under the bar: ' + gap);
    assert.equal(await current(), 3);
    await page.click('#back-content .fc-tab:nth-child(7)');                 // Zeta: too near the end to reach the top
    await page.waitForTimeout(150);
    assert.equal(await current(), 6, 'a section too near the end to reach the top is still the chosen one');
    await page.evaluate(() => { document.getElementById('back-content').scrollTop = 0; });
    await page.waitForTimeout(100);                       // the chosen section is out of view: free again
    assert.equal(await current(), 0);
    await page.evaluate(() => { const bc = document.getElementById('back-content'); bc.scrollTop = bc.scrollHeight; });
    await page.waitForTimeout(100);
    assert.equal(await current(), 6, 'scrolled to the end: the last section');
    await page.reload();
    await page.waitForSelector('#s-home:not(.hidden)');
    await page.click('#startBtn');
    await page.waitForSelector('#s-session:not(.hidden)');
    await page.evaluate(() => flipCard());
    await page.waitForTimeout(700);
    assert.deepEqual(await extras(page), ['Pages'], 'still All after a reload');
    await page.click('#back-content .fc-extra');
    await page.waitForTimeout(100);
    assert.equal((await tabs(page)).length, pagesBefore);
  }, { mode: 'pages' });

// ── Expand ──────────────────────────────────────────────────────────────────
await test('Expand: the whole answer on the whole screen; Esc closes it, not the answer; E opens it again',
  PHONE, sample(), async ({ page }) => {
    await page.click('#btn-expand');
    assert.equal(await shown(page, 'reader'), true);
    const m = await page.evaluate(() => { const b = document.getElementById('reader-body'); return { title: document.getElementById('reader-title').textContent, h: b.clientHeight, all: b.scrollHeight, h2: b.querySelectorAll('h2, h3').length, tabs: b.querySelectorAll('.fc-tab').length, locked: getComputedStyle(document.body).overflow }; });
    assert.deepEqual([m.title, m.h2, m.tabs, m.locked], ['Sample card', HEADINGS.length, 0, 'hidden']);
    assert.ok(m.h > 650, 'most of the screen: ' + m.h);
    for (const k of ['1', 'Enter', 'ArrowRight', 'Backspace']) await page.keyboard.press(k);
    assert.equal(await page.evaluate(() => __saved), 0, 'no key reached the card');
    await page.keyboard.press('Escape');
    assert.equal(await shown(page, 'reader'), false);
    assert.equal(await page.evaluate(() => isFlipped()), true);
    await page.keyboard.press('e');
    assert.equal(await shown(page, 'reader'), true);
    await page.click('.reader-btn');
    assert.equal(await shown(page, 'reader'), false);
  });

await test('desktop: an answer shorter than the screen is shown whole by the full-screen answer, though the card scrolls it', DESKTOP,
  sample([60, 60, 60, 60]), async ({ page }) => {
    const card = await fit(page);
    assert.ok(card.scrollH > card.h, 'too tall for the card: ' + card.scrollH + ' in ' + card.h);
    assert.equal(await page.evaluate(() => document.getElementById('btn-expand').hidden), false);
    await page.keyboard.press('e');
    const m = await page.evaluate(() => { const b = document.getElementById('reader-body'); return { h: b.clientHeight, all: b.scrollHeight }; });
    assert.ok(m.all <= m.h + 4, `${m.all} in ${m.h}`);
  });

await test('a picture in the full-screen answer opens the viewer; Esc closes the viewer, then the reader', PHONE,
  `<p>text</p><img id="p" src="data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#223"/></svg>')}">`,
  async ({ page }) => {
    await page.keyboard.press('e');
    await page.tap('#reader-body img');
    assert.equal(await shown(page, 'viewer'), true);
    await page.keyboard.press('Escape');
    assert.equal(await shown(page, 'viewer'), false);
    assert.equal(await shown(page, 'reader'), true);
    await page.keyboard.press('Escape');
    assert.equal(await shown(page, 'reader'), false);
  });

// ── when it applies ─────────────────────────────────────────────────────────
await test('the author\'s tabs are left alone: no pages, no All; the reader shows them', PHONE,
  `${sample()}\n<!--tab: Second-->\n${sample()}`, async ({ page }) => {
    assert.deepEqual(await tabs(page), ['1', 'Second']);
    assert.deepEqual(await extras(page), []);
    await page.keyboard.press('e');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#reader-body .fc-tab').length), 2);
  });

await test('short: nothing; slightly long: only the fade and Expand; no headings: the same',
  PHONE, `<h3>One</h3>${block(200)}<h3>Two</h3>${block(200)}<h3>Three</h3>${block(60)}`, async ({ page }) => {
    // 3 sections, 560 px in a 494 px area: below 1.3 areas
    assert.equal((await tabs(page)).length, 0);
    assert.equal(await page.evaluate(() => document.getElementById('back-content').classList.contains('more')), true);
    assert.equal(await page.evaluate(() => document.getElementById('btn-expand').hidden), false);
  });

await test('short answer: no bar, no Expand, no fade', PHONE, `<h3>One</h3>${block(60)}<h3>Two</h3>${block(60)}<h3>Three</h3>${block(60)}`, async ({ page }) => {
  assert.equal((await tabs(page)).length, 0);
  assert.equal(await page.evaluate(() => document.getElementById('btn-expand').hidden), true);
  assert.equal(await page.evaluate(() => document.getElementById('back-content').classList.contains('more')), false);
});

await test('long without headings: no pages (nothing to split at), Expand and the fade', PHONE,
  Array.from({ length: 12 }, (_, i) => block(120, 'paragraph ' + i)).join(''), async ({ page }) => {
    assert.equal((await tabs(page)).length, 0);
    assert.equal(await badge(page), 'html');
    assert.equal(await page.evaluate(() => document.getElementById('btn-expand').hidden), false);
  });

await test('markdown: its headings split it too', PHONE,
  ['# Title', 'intro'].concat(Array.from({ length: 4 }, (_, i) => [`## Part ${i + 1}`, 'Lorem ipsum dolor sit amet, '.repeat(7), 'Consectetur adipiscing elit, '.repeat(6)]).flat()).join('\n\n'),
  async ({ page }) => {
    const names = await tabs(page);
    assert.ok(names.length >= 3, names.join('|'));
    assert.equal(names[0], 'Title');
    assert.match(await badge(page), /^md · \d pages$/);
    await everyPageFits(page, names.length);
  }, { type: 'md' });

await test('a styled card keeps its own <style> on every page', PHONE,
  `<style>h3 { color: rgb(200, 0, 0); } .x { font-size: 20px }</style><div style="padding:10px">${Array.from({ length: 6 }, (_, i) => `<h3>Part ${i + 1}</h3>${block(150)}`).join('')}</div>`,
  async ({ page }) => {
    const n = (await tabs(page)).length;
    assert.ok(n >= 2, 'pages: ' + n);
    for (let i = 1; i <= n; i++) {
      await page.click(`.fc-tab:nth-child(${i})`);
      const color = await page.evaluate(() => { const host = document.querySelector('.fc-tabpanel:not([hidden]) .fc-styled'); const h = host.shadowRoot.querySelector('h3'); return getComputedStyle(h).color; });
      assert.equal(color, 'rgb(200, 0, 0)', 'page ' + i);
    }
  });

// ── planning again ──────────────────────────────────────────────────────────
await test('a new size plans again; the address bar moving a little does not', PHONE, sample(), async ({ page }) => {
  const at = () => page.evaluate(() => Array.from(document.querySelectorAll('#back-content .fc-tab')).findIndex((b) => b.getAttribute('aria-selected') === 'true'));
  await page.click('.fc-tab:nth-child(3)');
  await page.setViewportSize({ width: 390, height: 800 });         // the card 9 % lower
  await page.waitForTimeout(450);
  assert.equal(await at(), 2, 'not rebuilt: the same page');
  await page.setViewportSize({ width: 390, height: 600 });
  await page.waitForTimeout(450);
  const names = await tabs(page);
  assert.ok(names.length >= 5, 'a smaller card: more pages (' + names.length + ')');   // a section taller than a page has one alone
});

await test('a picture that arrives late: pages are planned with its real height', DESKTOP,
  `<h3>One</h3>${block(60)}<h3>Two</h3><img id="late" src="https://img.test/tall.svg" style="display:block;width:300px"><h3>Three</h3>${block(60)}<h3>Four</h3>${block(60)}`,
  async ({ page }) => {
    await page.waitForTimeout(900);
    const names = await tabs(page);
    assert.ok(names.length >= 2, 'pages after the picture: ' + names.length);
    for (let i = 1; i <= names.length; i++) {
      await page.click(`.fc-tab:nth-child(${i})`);
      await page.waitForTimeout(60);
      const f = await fit(page);
      assert.ok(f.scrollH <= f.h + 2, `page ${i}: ${f.scrollH} in ${f.h}`);
    }
  }, { routes: async (page) => {
    await page.route('https://img.test/**', async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#789"/></svg>' });
    });
  } });

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
