// Run: node test/ui/preview.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Sidebar.html (a static page: the renderer and stylesheet of index.html are copied
// into it by tools/sync-preview.mjs), polling a stubbed getActiveRowPreview. A card
// is shown in a shadow root of the page (no nested frame); only a live card gets a frame.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const createDOMPurify = require('dompurify');
const realMarked = require('marked');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The pinned marked/DOMPurify tags are replaced by the packages, injected below.
const page = fs.readFileSync(path.join(root, 'Sidebar.html'), 'utf8')
  .replace(/<script[^>]*cdn\.jsdelivr\.net[^>]*><\/script>/g, '');

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

// The sidebar with a scripted server: replies is a queue; an Error instance fails the call.
function open(replies, { silent = false } = {}) {
  const calls = [];
  const dom = new JSDOM(page, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    url: 'https://example.test/',
    beforeParse(w) {
      w.DOMPurify = createDOMPurify(w);
      w.marked = realMarked;
      const run = (ok, bad) => ({
        withSuccessHandler: (f) => run(f, bad),
        withFailureHandler: (f) => run(ok, f),
        getActiveRowPreview() {
          calls.push(Date.now());
          if (silent) return;
          const next = replies.length > 1 ? replies.shift() : replies[0];
          setTimeout(() => (next instanceof Error ? bad(next) : ok(next)), 0);
        },
      });
      w.google = { script: { run: run(() => {}, () => {}) } };
    },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  return {
    w, calls, replies,
    note: () => $('note'),
    host: () => $('card'),
    shadow: () => $('card').shadowRoot,
    back: () => $('card').shadowRoot.querySelector('#back-content'),
    live: () => $('live'),
    liveFrame: () => $('live').querySelector('iframe'),
    diag: () => $('diag'),
    status: () => $('status').textContent,
    meta: () => $('meta').textContent,
    async poll() {
      w.poll();
      await sleep(15);
    },
  };
}
const row = (type, content, n = 2) => ({ row: n, id: 'c' + n, title: 'T', type, content, version: '9.9' });

await test('the CSS literal in the page has no raw "<" (it can not close a tag)', () => {
  const literal = page.split('\n').find((line) => line.startsWith('const APP_CSS'));
  assert.ok(literal.length > 1000, 'css present');
  assert.equal(literal.includes('<'), false);
});

await test('before the first answer the page says so, and the status line counts the polls', async () => {
  const s = open([], { silent: true });
  await sleep(15);
  assert.match(s.note().textContent, /^Waiting for the first answer from the sheet/);
  assert.equal(s.note().hidden, false);
  assert.equal(s.status(), 'polls 1 · answers 0 · last: nothing yet');
  assert.equal(s.diag().hidden, true);
});

await test('the status line shows what the sheet answered and the script version', async () => {
  const s = open([{ note: 'x', version: '9.9' }]);
  await sleep(15);
  assert.equal(s.status(), 'polls 1 · answers 1 · last: note · script v9.9');
  s.replies[0] = row('md', 'x', 4);
  await s.poll();
  assert.equal(s.status(), 'polls 2 · answers 2 · last: row 4 md · script v9.9');
  s.replies[0] = new Error('boom');
  await s.poll();
  assert.match(s.status(), /answers 3 · last: error/);
});

await test('a script error shows as red text on the page, not as silence', async () => {
  const s = open([{ note: 'x' }]);
  await sleep(15);
  assert.equal(s.diag().hidden, true);
  s.w.dispatchEvent(new s.w.ErrorEvent('error', { message: 'boom', lineno: 7 }));
  assert.equal(s.diag().hidden, false);
  assert.equal(s.diag().textContent, 'Script error: boom (line 7)');
  const rejection = new s.w.Event('unhandledrejection');
  rejection.reason = new Error('later');
  s.w.dispatchEvent(rejection);
  assert.equal(s.diag().textContent, 'Script error: boom (line 7)\nScript error: later');
  s.replies[0] = row('text', 'next', 3);                      // the next card clears it
  await s.poll();
  assert.equal(s.diag().hidden, true);
  assert.equal(s.diag().textContent, '');
});

await test('missing libraries are named in the status line; text cards still show', async () => {
  const s = open([row('text', 'plain')]);
  await sleep(15);
  assert.equal(s.status().includes('not loaded'), false);
  const bare = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(), beforeParse(w) {
      w.google = { script: { run: { withSuccessHandler(f) { return { withFailureHandler() {
        return { getActiveRowPreview() { f(row('text', 'plain')); } }; } }; } } } };
    } }).window;
  await sleep(15);
  assert.match(bare.document.getElementById('status').textContent,
    / · DOMPurify not loaded · marked not loaded$/);
  assert.equal(bare.document.getElementById('card').shadowRoot.querySelector('#back-content')
    .textContent.trim(), 'plain');
});

await test('a note is shown while no card row is selected', async () => {
  const s = open([{ note: 'Select a card row below the header.' }]);
  await sleep(15);
  assert.equal(s.note().hidden, false);
  assert.equal(s.note().textContent, 'Select a card row below the header.');
  assert.equal(s.host().hidden, true);
  assert.equal(s.live().hidden, true);
});

await test('a row renders sanitized in a shadow root: app markup and CSS, no nested frame', async () => {
  const content =
    '**hi** <img src=x onerror="window.top.__xss=1"><script>1</script> [a](https://e.test)';
  const s = open([row('md', content)]);
  await sleep(15);
  assert.equal(s.host().hidden, false);
  assert.equal(s.note().hidden, true);
  assert.equal(s.meta(), 'row 2 · c2 · md');
  const back = s.back();
  assert.ok(back, 'the app markup: .back-content#back-content');
  assert.equal(back.className, 'back-content');
  assert.equal(back.querySelector('strong').textContent, 'hi');
  const a = back.querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://e.test');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(/onerror|<script/.test(s.shadow().innerHTML), false);
  assert.equal(s.w.__xss, undefined);
  assert.match(s.shadow().querySelector('style').textContent, /\.back-content\s*\{/,
    'the app CSS is in the shadow root');
  assert.equal(s.w.document.querySelectorAll('iframe').length, 0, 'no nested frame');
  assert.equal(s.w.document.querySelector('strong'), null, 'nothing of the card in the page');
});

await test('a card image that fails to load is named in the preview, with the Drive hint', async () => {
  const s = open([row('html', '<img src="https://drive.google.com/thumbnail?id=X&sz=w780" alt="d">')]);
  await sleep(15);
  const img = s.back().querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://drive.google.com/thumbnail?id=X&sz=w780');
  assert.equal(s.back().querySelector('.back-note'), null);
  img.dispatchEvent(new s.w.Event('error'));
  assert.match(s.back().querySelector('.back-note').textContent,
    /^Image did not load: drive\.google\.com\/thumbnail\?id=X&sz=w780 .*Anyone with the link/);
});

await test('the app CSS is scoped to the card: html, body and :root become .fc-page', async () => {
  const s = open([row('text', 'x')]);
  await sleep(15);
  const css = s.shadow().querySelector('style').textContent;
  assert.match(css, /\.fc-page\s*\{/);
  assert.equal(/(^|[\s,}])(html|body|:root)\s*[{,]/.test(css), false);
  assert.ok(s.shadow().querySelector('.fc-page #back-content'));
});

await test('html and svg render like the app; text is escaped', async () => {
  const cases = [
    ['html', '<ruby>漢<rt>kan</rt></ruby><iframe src="x"></iframe>', 'ruby', 'iframe'],
    ['svg', '<svg viewBox="0 0 1 1"><circle r="1" onload="1"/></svg>', 'svg', null],
    ['text', '<b>x</b>', null, 'b'],
  ];
  for (const [type, content, want, unwanted] of cases) {
    const s = open([row(type, content)]);
    await sleep(15);
    if (want) {
      assert.ok(s.back().querySelector(want), type);
    }
    if (unwanted) {
      assert.equal(s.back().querySelector(unwanted), null, type);
    }
    assert.equal(/onload/.test(s.back().innerHTML), false, type);
  }
  const text = open([row('text', '<b>x</b>')]);
  await sleep(15);
  assert.equal(text.back().textContent.trim(), '<b>x</b>');
});

await test('an html card with its own <style> shows in a nested shadow root, as in the app', async () => {
  const styled = '<head><style>body{background:#f9f9f9}mark{color:#1e3c5c}</style></head>' +
    '<body><p>The <mark>flood</mark></p></body>';
  const s = open([row('html', styled)]);
  await sleep(15);
  const host = s.back().querySelector('.fc-styled');
  assert.ok(host && host.shadowRoot);
  assert.equal(host.shadowRoot.querySelector('mark').textContent, 'flood');
  assert.match(Array.from(host.shadowRoot.querySelectorAll('style')).map((x) => x.textContent)
    .join(' '), /\.fc-root\s*\{\s*background:#f9f9f9/);
  assert.equal(s.shadow().querySelector('mark'), null, 'not in the preview page itself');
  assert.equal(s.w.document.querySelector('mark'), null);
});

await test('a live card runs as a frame, isolated; other types stay inert', async () => {
  const live = '<script>document.title = "x"</script><b>hi</b>';
  const s = open([row('live', live)]);
  await sleep(15);
  assert.equal(s.live().hidden, false);
  assert.equal(s.host().hidden, true);
  const frame = s.liveFrame();
  const flags = frame.getAttribute('sandbox').split(/\s+/).sort();
  assert.deepEqual(flags, ['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts']);
  const doc = frame.getAttribute('srcdoc');
  assert.ok(doc.includes(live), 'script kept: this is what the card does in the app');
  assert.match(doc, /Content-Security-Policy[^>]*connect-src 'none'/);
  assert.equal(doc.includes('id="back-content"'), false, 'not wrapped like the other types');
  // the next card is plain again: the frame is gone
  s.replies[0] = row('html', '<p>x</p>', 3);
  await s.poll();
  assert.equal(s.liveFrame(), null);
  assert.equal(s.live().hidden, true);
  assert.equal(s.host().hidden, false);
  assert.ok(s.back().querySelector('p'));
});

await test('a live frame that reports back is sized; one that stays silent is called out', async () => {
  const s = open([{ note: 'x' }]);
  await sleep(15);
  s.w.eval('liveWaitMs = 30');
  s.replies[0] = row('live', '<b>hi</b>');
  await s.poll();
  const frame = s.liveFrame();
  assert.equal(s.diag().hidden, true, 'not yet: the frame may still report');
  await sleep(60);
  assert.equal(s.diag().hidden, false, 'silent: blocked');
  assert.match(s.diag().textContent, /did not start/);
  s.w.dispatchEvent(new s.w.MessageEvent('message', { data: { fcLive: true, h: 321.2 },
    source: frame.contentWindow }));
  assert.equal(frame.style.height, '322px');
  assert.equal(s.diag().hidden, true, 'a late report clears the notice');
  s.w.dispatchEvent(new s.w.MessageEvent('message', { data: { fcLive: true, h: 700 },
    source: s.w }));                                          // not from the frame
  assert.equal(frame.style.height, '322px');
  s.replies[0] = row('live', '<b>other</b>', 3);              // a reporting frame: no notice
  await s.poll();
  const second = s.liveFrame();
  s.w.dispatchEvent(new s.w.MessageEvent('message', { data: { fcLive: true, h: 100 },
    source: second.contentWindow }));
  await sleep(60);
  assert.equal(s.diag().hidden, true);
});

await test('an unchanged row is not re-rendered; a changed one is', async () => {
  const r = row('md', 'one');
  const s = open([r]);
  await sleep(15);
  s.back().setAttribute('data-sentinel', '1');
  await s.poll();
  assert.equal(s.back().getAttribute('data-sentinel'), '1', 'same data: untouched');
  s.replies[0] = { ...r, content: 'two' };
  await s.poll();
  assert.match(s.back().textContent, /two/);
  assert.equal(s.back().getAttribute('data-sentinel'), null);
  s.back().setAttribute('data-sentinel', '1');
  s.replies[0] = { ...r, row: 3, content: 'two' };            // another row, same text
  await s.poll();
  assert.equal(s.back().getAttribute('data-sentinel'), null);
  assert.equal(s.meta(), 'row 3 · c2 · md');
});

await test('a render error shows as a note instead of a silent blank card', async () => {
  const s = open([{ note: 'x' }]);
  await sleep(15);
  s.w.mountBack = () => {
    throw new Error('boom');
  };
  s.replies[0] = row('md', 'x');
  await s.poll();
  assert.equal(s.note().hidden, false);
  assert.equal(s.note().textContent, 'Preview failed: boom');
  assert.equal(s.host().hidden, true);
  assert.equal(s.meta(), '');
});

await test('a server error shows as a note; the next good reply recovers', async () => {
  const s = open([new Error('boom')]);
  await sleep(15);
  assert.equal(s.note().textContent, 'Error: boom');
  assert.equal(s.host().hidden, true);
  s.replies[0] = row('text', 'ok');
  await s.poll();
  assert.equal(s.host().hidden, false);
  assert.equal(s.note().hidden, true);
  assert.equal(s.back().textContent.trim(), 'ok');
});

await test('a hidden tab does not poll', async () => {
  const s = open([{ note: 'x' }]);
  await sleep(15);
  const before = s.calls.length;
  Object.defineProperty(s.w.document, 'hidden', { get: () => true });
  await s.poll();
  assert.equal(s.calls.length, before);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
