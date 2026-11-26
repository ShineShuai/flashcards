// Run: node test/ui/devserver.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// The real index.html and Sidebar.html in jsdom, served by tools/dev.mjs --offline: the page
// talks to the real Code.gs through the shim in place of google.script.run. A review lands in
// the sheet, the shim refuses what Apps Script refuses, a new server version makes the page
// update itself, and the preview shows the selected row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jsdom from 'jsdom';
import { startDevServer } from '../../tools/dev.mjs';
import { sleep, until } from './harness.mjs';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dev-ui-'));
const dev = await startDevServer({
  port: 0, latency: 0, offline: true, stateFile: path.join(tmp, 'sheet.json'), log: () => {},
});
const windows = [];

// Only this server: no fonts or anything else from the network
const localOnly = {
  interceptors: [requestInterceptor((request) => (request.url.startsWith(dev.base)
    ? undefined : new Response('', { status: 404 })))],
};

async function open(url) {
  const html = await (await fetch(dev.base + url)).text();
  const { window: w } = new JSDOM(html, {
    runScripts: 'dangerously', resources: localOnly, pretendToBeVisual: true,
    url: dev.base + url, virtualConsole: new VirtualConsole(),   // jsdom cannot navigate: silent
    beforeParse(win) {
      win.fetch = (u, options) => fetch(new URL(u, dev.base), options);
      win.matchMedia = () => ({ matches: false, addEventListener() {} });
      win.alert = () => {};
      win.URL.createObjectURL = () => 'blob:test';
      win.URL.revokeObjectURL = () => {};
    },
  });
  windows.push(w);
  // the vendor <script>s pause the parser: the page is complete at "load"
  if (w.document.readyState !== 'complete') {
    await new Promise((resolve) => w.addEventListener('load', resolve));
  }
  return w;
}
const row = (title) => {
  const sheet = dev.env().sheets.get('cards');
  for (let r = 2; sheet.get(r, 1) !== ''; r++) {
    if (sheet.get(r, 2) === title) {
      return r;
    }
  }
  return 0;
};
const cell = (r, name) => dev.env().sheets.get('cards')
  .get(r, dev.env().api.HEADERS.indexOf(name) + 1);
const failure = (w, fn, ...args) => new Promise((resolve) => {
  w.google.script.run.withFailureHandler(resolve)[fn](...args);
});

// ── the app: home, a review, the shim's refusals
const w = await open('/');
const $ = (id) => w.document.getElementById(id);
await until(() => !$('s-home').classList.contains('hidden'), 5000);
assert.equal($('stat-total').textContent, '9', 'the seeded cards');
w.startSession();
await sleep(20);
const title = $('card-title').textContent;
assert.ok(row(title), `card "${title}" is in the sheet`);
w.flipCard();
await sleep(20);
assert.ok($('back-content').textContent.length > 0, 'the answer is shown');
w.rate(3);
await until(() => cell(row(title), 'reps') === 1, 3000);
assert.equal(dev.env().sheets.get('review_log').getLastRow(), 2, 'one line in the review log');

const bad = await failure(w, 'updateCard', '1', { due: new w.Date() }, {});
assert.match(bad.message, /illegal value in property: 1\.due/);
await fetch(dev.base + '/__dev/fail?fn=getDueCards&n=1');
assert.match((await failure(w, 'getDueCards', 0)).message, /injected failure of getDueCards/);

// ── a new version is "deployed": the idle app notices and offers the update
w.showHome();
await sleep(50);
await fetch(dev.base + '/__dev/version?v=2099.1.1.1');
w.checkVersion();
await until(() => !$('update-banner').classList.contains('hidden'), 4000);
assert.equal($('update-version').textContent, '2099.1.1.1');

// ── the preview follows the selected row
await fetch(dev.base + '/__dev/row?n=3');
const side = await open('/frame/sidebar');
await until(() => !side.document.getElementById('card').hidden, 4000);
// the card is drawn in a shadow root, as in the app's stylesheet isolation
const body = () => side.document.getElementById('card').shadowRoot
  ?.querySelector('#back-content')?.innerHTML ?? '';
assert.match(body(), /<table/, 'row 3: the markdown table');
await fetch(dev.base + '/__dev/row?n=4');
// a card with a <style> block is drawn in a shadow root of its own, inside that one
const deepText = (node) => [node.textContent, ...[...node.querySelectorAll('*')]
  .filter((el) => el.shadowRoot).map((el) => deepText(el.shadowRoot))].join(' ');
await until(() => /A box from the card/.test(
  deepText(side.document.getElementById('card').shadowRoot)), 4000);

windows.forEach((win) => win.close());
await dev.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('all passed');
