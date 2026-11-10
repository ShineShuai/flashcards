// Run: node test/ui/preview.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Sidebar.html, evaluated like an Apps Script template with the shell read from
// index.html, polling a stubbed getActiveRowPreview.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadCodeGs } from '../code.mjs';
import { sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const createDOMPurify = require('dompurify');
const realMarked = require('marked');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// <?!= expr ?> printed raw, with `shell` in scope (what createTemplateFromFile does)
const shell = loadCodeGs().api.appShell_();
const page = fs.readFileSync(path.join(root, 'Sidebar.html'), 'utf8')
  .replace(/<\?!=([\s\S]*?)\?>/g, (_, expr) => new Function('shell', `return (${expr});`)(shell))
  .replace(/<script[^>]*cdn\.jsdelivr\.net[^>]*><\/script>/g, '');   // injected below

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
function open(replies) {
  const calls = [];
  const dom = new JSDOM(page, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    beforeParse(w) {
      w.DOMPurify = createDOMPurify(w);
      w.marked = realMarked;
      const run = (ok, bad) => ({
        withSuccessHandler: (f) => run(f, bad),
        withFailureHandler: (f) => run(ok, f),
        getActiveRowPreview() {
          calls.push(Date.now());
          const next = replies.length > 1 ? replies.shift() : replies[0];
          setTimeout(() => (next instanceof Error ? bad(next) : ok(next)), 0);
        },
      });
      w.google = { script: { run: run(() => {}, () => {}) } };
    },
  });
  const w = dom.window;
  return {
    w, calls, replies,
    note: () => w.document.getElementById('note'),
    frame: () => w.document.getElementById('view'),
    meta: () => w.document.getElementById('meta').textContent,
    async poll() {
      w.poll();
      await sleep(15);
    },
  };
}

await test('the CSS literal in the page has no raw "<" (it can not close a tag)', () => {
  const literal = page.split('\n').find((line) => line.startsWith('const APP_CSS'));
  assert.ok(literal.length > 1000, 'css present');
  assert.equal(literal.includes('<'), false);
});

await test('a note is shown while no card row is selected', async () => {
  const s = open([{ note: 'Select a card row below the header.' }]);
  await sleep(15);
  assert.equal(s.note().hidden, false);
  assert.equal(s.note().textContent, 'Select a card row below the header.');
  assert.equal(s.frame().hidden, true);
});

await test('a row renders sanitized in a sandboxed frame, app markup and CSS', async () => {
  const content =
    '**hi** <img src=x onerror="window.top.__xss=1"><script>1</script> [a](https://e.test)';
  const s = open([{ row: 2, id: 'card1', title: 'T', type: 'md', content }]);
  await sleep(15);
  const doc = s.frame().getAttribute('srcdoc');
  assert.equal(s.frame().hidden, false);
  assert.equal(s.note().hidden, true);
  assert.equal(s.meta(), 'row 2 · card1 · md');
  assert.match(doc, /<div class="back-content" id="back-content">/);
  assert.match(doc, /<strong>hi<\/strong>/);
  assert.match(doc, /<a href="https:\/\/e\.test" target="_blank" rel="noopener noreferrer">a</);
  assert.equal(/onerror|<script>1/.test(doc), false);
  assert.match(doc, /\.back-content\s*\{/, 'the app CSS is in the frame');
  const sandbox = s.frame().getAttribute('sandbox').split(/\s+/);
  assert.equal(sandbox.includes('allow-scripts') || sandbox.includes('allow-same-origin'), false);
  assert.ok(sandbox.includes('allow-popups'), 'links can open');
});

await test('html and svg render like the app; text is escaped', async () => {
  const cases = [
    ['html', '<ruby>漢<rt>kan</rt></ruby><iframe src="x"></iframe>',
      /<ruby>漢<rt>kan<\/rt><\/ruby>/, /iframe/],
    ['svg', '<svg viewBox="0 0 1 1"><circle r="1" onload="1"/></svg>',
      /<svg[^>]*viewBox/, /onload/],
    ['text', '<b>x</b>', /&lt;b&gt;x&lt;\/b&gt;/, /<b>/],
  ];
  for (const [type, content, want, unwanted] of cases) {
    const s = open([{ row: 2, id: 'a', title: '', type, content }]);
    await sleep(15);
    const doc = s.frame().getAttribute('srcdoc');
    assert.match(doc, want, type);
    assert.equal(unwanted.test(doc.slice(doc.indexOf('id="back-content"'))), false, type);
  }
});

await test('an unchanged row is not re-rendered; a changed one is', async () => {
  const row = { row: 2, id: 'a', title: '', type: 'md', content: 'one' };
  const s = open([row]);
  await sleep(15);
  s.frame().setAttribute('srcdoc', 'SENTINEL');
  await s.poll();
  assert.equal(s.frame().getAttribute('srcdoc'), 'SENTINEL', 'same data: untouched');
  s.replies[0] = { ...row, content: 'two' };
  await s.poll();
  assert.match(s.frame().getAttribute('srcdoc'), /two/);
  s.replies[0] = { ...row, row: 3, content: 'two' };            // another row, same text
  s.frame().setAttribute('srcdoc', 'SENTINEL');
  await s.poll();
  assert.match(s.frame().getAttribute('srcdoc'), /two/);
});

await test('a server error shows as a note; the next good reply recovers', async () => {
  const s = open([new Error('boom')]);
  await sleep(15);
  assert.equal(s.note().textContent, 'Error: boom');
  assert.equal(s.frame().hidden, true);
  s.replies[0] = { row: 2, id: 'a', title: '', type: 'text', content: 'ok' };
  await s.poll();
  assert.equal(s.frame().hidden, false);
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
