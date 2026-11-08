// Run: node test/layout.mjs   (needs: npm install --no-save playwright@1.63.0
//                              npx playwright install chromium)
// Layout checks in real Chromium: five rating buttons in one row with usable
// tap targets, no horizontal scroll, rating row visible without scrolling.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = 'file://' + path.join(here, '..', 'index.html');

const STUB = `
window.marked = { parse: (x) => x };
const keywords = 'chlorophyll;light reactions;Calvin cycle;stomata;ATP';
const back = 'Plants convert light energy into chemical energy.\\n'.repeat(12);
const cards = [{
  id: '1', title: 'Photosynthesis', keywords, back_content: back, back_type: 'text',
}];
const mk = (ok, bad) => new Proxy({}, { get(_, fn) {
  if (fn === 'withSuccessHandler') return (f) => mk(f, bad);
  if (fn === 'withFailureHandler') return (f) => mk(ok, f);
  return () => setTimeout(() => {
    if (fn === 'bootstrap') {
      ok({ stats: { total: 1, due: 1, new: 1, review: 0 }, cards: cards.map((c) => ({ ...c })) });
    }
    else if (fn === 'updateCard') ok({ ok: true });
  }, 0);
} });
window.google = { script: { run: mk(() => {}, () => {}) } };
`;

const viewports = [
  { w: 360, h: 640, scheme: 'light', touch: true },
  { w: 390, h: 844, scheme: 'dark', touch: true },
  { w: 320, h: 568, scheme: 'light', touch: true },
  { w: 1280, h: 800, scheme: 'light', touch: false },
];

const browser = await chromium.launch();
let failed = 0;
for (const v of viewports) {
  const label = `${v.w}x${v.h} ${v.scheme}`;
  const context = await browser.newContext({
    viewport: { width: v.w, height: v.h }, isMobile: v.touch, hasTouch: v.touch,
    colorScheme: v.scheme,
  });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const external = route.request().url().startsWith('http');
    return external ? route.abort() : route.continue();
  });
  await page.addInitScript(STUB);
  try {
    await page.goto(page_url);
    await page.waitForSelector('#s-home:not(.hidden)');
    await page.click('#startBtn');
    await page.waitForSelector('#s-session:not(.hidden)');
    const front = await page.evaluate(() => {
      const card = document.querySelector('.card-face-front').getBoundingClientRect();
      const show = document.querySelector('.front-actions .btn-flip').getBoundingClientRect();
      return { ratio: show.width / card.width };
    });
    assert.ok(front.ratio > 0.8, `"Show answer" should span the card (${front.ratio.toFixed(2)})`);
    await page.evaluate('flipCard()');
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.btn-rate')];
      const rects = buttons.map((b) => b.getBoundingClientRect());
      return {
        rows: new Set(buttons.map((b) => b.offsetTop)).size,
        minW: Math.min(...rects.map((r) => r.width)),
        minH: Math.min(...rects.map((r) => r.height)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        vh: innerHeight,
        hscroll: document.documentElement.scrollWidth > innerWidth,
        scrollPx: document.documentElement.scrollHeight - innerHeight,
      };
    });
    assert.equal(m.rows, 1, 'rating buttons must sit in one row');
    const target = `${m.minW.toFixed(0)}x${m.minH.toFixed(0)}`;
    assert.ok(m.minW >= 44 && m.minH >= 44, `tap target ${target}`);
    assert.ok(m.bottom <= m.vh, 'rating row visible without scrolling');
    assert.equal(m.hscroll, false, 'no horizontal scroll');
    if (v.touch) {
      assert.ok(m.scrollPx <= 2, `page should fit the phone screen (${m.scrollPx}px over)`);
    }
    console.log(`ok   ${label}: 1 row, buttons >= ${target}, no scroll`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${label}: ${err.message}`);
  }
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
