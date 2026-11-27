// Run: node test/dev.mjs   (no dependencies)
// tools/dev.mjs: the real Code.gs behind /rpc on the Sheets model, Apps Script's refusal of
// values it cannot carry, the sheet kept between runs, the version and failure hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { illegalPath, startDevServer } from '../tools/dev.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dev-'));
const stateFile = path.join(tmp, 'sheet.json');
const start = (extra = {}) => startDevServer({
  port: 0, latency: 0, stateFile, log: () => {}, ...extra,
});
const rpc = async (dev, fn, ...args) => (await fetch(`${dev.base}/rpc`, {
  method: 'POST', body: JSON.stringify({ fn, args }),
})).json();
const get = async (dev, url, options) => (await fetch(dev.base + url, options)).text();
const cell = (d, row, name) => d.env().sheets.get('cards')
  .get(row, d.env().api.HEADERS.indexOf(name) + 1);       // row 2 is card 1

// The server runs on the real clock, so the review is dated relative to now: fixed
// dates go stale (a card due "2026-11-26" is due again the next day).
const reviewedAt = new Date().toISOString();
const dueAt = new Date(Date.now() + 3 * 86400000).toISOString();

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

let dev = await start();

await test('illegalPath names what google.script.run cannot carry', () => {
  assert.equal(illegalPath({ a: [1, { b: 'x' }], c: null }), '');
  assert.equal(illegalPath([new Date()]), '0');
  assert.equal(illegalPath({ a: [1, { when: new Date() }] }), 'a.1.when');
  assert.equal(illegalPath({ f() {} }), 'f');
});

await test('the app page is the real index.html plus the shim, at server version', async () => {
  const page = await get(dev, '/');
  const own = dev.env().api.APP_VERSION;
  assert.match(page, /window\.google = \{ script/);
  assert.ok(page.includes(`const APP_VERSION = '${own}';`));
  assert.match(page, /id="s-home"/);
  assert.match(await get(dev, '/?page=docs'), /Documentation|docs/i);
});

await test('bootstrap comes from the real Code.gs: seeded cards, all new', async () => {
  const { result } = await rpc(dev, 'bootstrap', -60);
  assert.equal(result.cards.length, 9);
  assert.equal(result.stats.new, 9);
  assert.deepEqual(result.cards.map((c) => c.back_type).slice(0, 3), ['text', 'md', 'html']);
  assert.ok(result.cards.some((c) => /<!-- tab md: Summary -->/.test(c.back_content)));
});

await test('updateCard writes the card and the log; the card is no longer due', async () => {
  const fsrs = {
    stability: 3, difficulty: 5, elapsed_days: 0, scheduled_days: 3, reps: 1, lapses: 0,
    state: 2, last_review: reviewedAt, due: dueAt,
    weak_keywords: '', miss_streak: 0, ok_days: 0, fail_days: 0, trail: '', cap_days: '',
  };
  const saved = await rpc(dev, 'updateCard', '1', fsrs, { hints: 0, duration_ms: 1000 });
  assert.equal(saved.result.ok, true, JSON.stringify(saved));
  assert.equal(cell(dev, 2, 'reps'), 1);
  assert.equal(cell(dev, 2, 'state'), 2);
  assert.equal(dev.env().sheets.get('review_log').getLastRow(), 2);
  const { result } = await rpc(dev, 'bootstrap', -60);
  assert.ok(!result.cards.some((c) => c.id === '1'), 'scheduled for later: no longer due');
});

await test('apps script rules: a trailing underscore is private, unknown is unknown', async () => {
  assert.match((await rpc(dev, 'readCards_')).error, /not found/);
  assert.match((await rpc(dev, 'noSuchFunction')).error, /Script function not found/);
});

await test('a Date in a result is refused like Apps Script does', async () => {
  const ctx = dev.env().ctx;
  ctx.devDateProbe = () => ({ rows: [{ due: new Date() }] });
  const reply = await rpc(dev, 'devDateProbe');
  assert.match(reply.error, /illegal value in property: rows\.0\.due/);
  delete ctx.devDateProbe;
});

await test('the sheet is kept between runs, and --reset reseeds it', async () => {
  await dev.close();
  dev = await start();
  assert.equal(cell(dev, 2, 'reps'), 1, 'the review survived');
  assert.equal(cell(dev, 2, 'last_review'), reviewedAt);
  await dev.close();
  dev = await start({ reset: true });
  assert.equal(cell(dev, 2, 'reps'), '');
});

await test('/__dev/version: a new version is served and reported together', async () => {
  const before = (await rpc(dev, 'getVersion')).result.version;
  await get(dev, '/__dev/version?v=2099.1.1.1');
  assert.equal((await rpc(dev, 'getVersion')).result.version, '2099.1.1.1');
  assert.match(await get(dev, '/'), /const APP_VERSION = '2099\.1\.1\.1';/);
  await get(dev, '/__dev/version');
  assert.equal((await rpc(dev, 'getVersion')).result.version, before);
});

await test('/__dev/fail: the next N calls of a function fail, then it works again', async () => {
  await get(dev, '/__dev/fail?fn=getDueCards&n=2');
  assert.match((await rpc(dev, 'getDueCards', -60)).error, /injected/);
  assert.match((await rpc(dev, 'getDueCards', -60)).error, /injected/);
  assert.ok(Array.isArray((await rpc(dev, 'getDueCards', -60)).result));
});

await test('the preview follows the selected row, as the real sidebar does', async () => {
  assert.match((await rpc(dev, 'getActiveRowPreview')).result.title, /Plain text/);
  await get(dev, '/__dev/row?n=10');
  const row = (await rpc(dev, 'getActiveRowPreview')).result;
  assert.equal(row.row, 10);
  assert.equal(row.type, 'live');
  assert.equal(row.title, 'Live frame');
  await get(dev, '/__dev/row?n=1');
  assert.match((await rpc(dev, 'getActiveRowPreview')).result.note, /header/);
});

await test('sidebar, framed and docs pages are served', async () => {
  assert.match(await get(dev, '/frame/sidebar'), /window\.google/);
  assert.match(await get(dev, '/sidebar'), /\/frame\/sidebar/);
  assert.match(await get(dev, '/sidebar?mode=window'), /width:640px/);
  const framed = await get(dev, '/framed');
  assert.match(framed, /sandbox="[^"]*allow-top-navigation-by-user-activation/);
  assert.match(framed, /src="http:\/\/127\.0\.0\.1:\d+\/\?exec=/, 'another origin than localhost');
  assert.ok(!/allow-top-navigation/.test(await get(dev, '/framed?block=1')), 'block=1');
  assert.match(await get(dev, '/nope'), /not found/);
});

await test('--offline serves marked and DOMPurify from node_modules', async () => {
  const off = await start({ offline: true });
  try {
    const page = await get(off, '/');
    assert.ok(!page.includes('cdn.jsdelivr.net'));
    assert.match(page, /src="\/vendor\/marked\.js"/);
    assert.match(page, /src="\/vendor\/purify\.js"/);
    const marked = await get(off, '/vendor/marked.js');
    if (/npm install/.test(marked)) {
      console.log('     (the file itself skipped: npm install --no-save marked dompurify)');
    } else {
      assert.match(marked, /marked/);
    }
  } finally {
    await off.close();
  }
});

await dev.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
