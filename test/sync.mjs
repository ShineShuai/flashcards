// Run: node test/sync.mjs   (no dependencies)
// Sidebar.html (Flash > Preview) carries a copy of the stylesheet, the pinned
// marked/DOMPurify <script> tags and the @render block of index.html, written by
// tools/sync-preview.mjs. The copy must be current, and the page must be safe to serve
// as a static file: no template tags, nothing that ends a <script> early.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssLiteral, extractShell, run, syncSidebar } from '../tools/sync-preview.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
}

const index = read('index.html');
const sidebar = read('Sidebar.html');
const inlineScripts = () => [...sidebar.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]);

test('Sidebar.html is in step with index.html (else: node tools/sync-preview.mjs)', () => {
  assert.equal(run(root, true).changed, false);
});

test('the copy holds what the app has: renderer, stylesheet, both pinned scripts', () => {
  const shell = extractShell(index);
  assert.ok(sidebar.includes(shell.render), 'render block');
  assert.ok(sidebar.includes(cssLiteral(shell.css)), 'stylesheet');
  assert.ok(sidebar.includes(shell.scripts), 'script tags');
  assert.match(shell.render, /function renderHtml\(content, type\)/);
  assert.match(shell.render, /function mountBack\(el, content, type\)/);
  assert.match(shell.css, /\.back-content\s*\{/);
  assert.equal((shell.scripts.match(/<script/g) || []).length, 2);
  assert.match(shell.scripts, /marked@\d+\.\d+\.\d+\/lib\/marked\.umd\.js/);
  assert.match(shell.scripts, /dompurify@\d+\.\d+\.\d+\/dist\/purify\.min\.js/);
  assert.equal(shell.render.includes('@render-'), false);
});

test('Sidebar.html is a static page: no template tags, no early end of a script', () => {
  assert.equal(/<\?/.test(sidebar), false, 'a template tag (<? ... ?>)');
  const scripts = inlineScripts();
  assert.equal(scripts.length, 3, 'error handler, renderer, page script');
  for (const code of scripts) {
    assert.equal(/<\/script/i.test(code), false, '</script in a script');
    assert.equal(code.includes('<!--'), false, '<!-- in a script starts the escaped state');
  }
  const literal = sidebar.split('\n').find((l) => l.startsWith('const APP_CSS = '));
  assert.ok(literal && literal.length > 1000);
  assert.equal(literal.includes('<'), false, 'a raw "<" in the CSS literal');
  assert.doesNotThrow(() => new Function(scripts.join('\n;\n')), 'the scripts parse');
});

test('the error handler comes first, so a failure in any later script shows on the page', () => {
  const [first] = inlineScripts();
  assert.match(first, /function flashFail\(/);
  assert.match(first, /addEventListener\('error'/);
  assert.match(first, /addEventListener\('unhandledrejection'/);
  assert.ok(sidebar.indexOf('id="diag"') < sidebar.indexOf(first), 'the red text exists by then');
});

test('syncSidebar: rewrites the three regions, leaves the rest, is idempotent', () => {
  const shell = { scripts: '<script src="https://cdn.jsdelivr.net/npm/a"></script>', css: 'a{b:c}', render: 'function f() {}' };
  const page = '<head>\n<!-- @sync-scripts-begin -->\nOLD\n<!-- @sync-scripts-end -->\n</head>\n' +
    '<script>\n// @sync-render-begin\nOLD\n// @sync-render-end\n</script>\n' +
    '<script>\n// @sync-css-begin\nOLD\n// @sync-css-end\nrest();\n</script>';
  const once = syncSidebar(page, shell);
  assert.ok(once.includes(shell.scripts) && once.includes('function f() {}') &&
    once.includes('const APP_CSS = "a{b:c}";') && once.includes('rest();'));
  assert.equal(once.includes('OLD'), false);
  assert.equal(syncSidebar(once, shell), once);
});

test('syncSidebar: a missing or repeated marker is an error, not a silent no-op', () => {
  const shell = { scripts: 's', css: 'c', render: 'r' };
  const ok = '<!-- @sync-scripts-begin -->\n<!-- @sync-scripts-end -->\n' +
    '// @sync-render-begin\n// @sync-render-end\n// @sync-css-begin\n// @sync-css-end\n';
  assert.doesNotThrow(() => syncSidebar(ok, shell));
  assert.throws(() => syncSidebar(ok.replace('// @sync-css-end', ''), shell), /"css" region/);
  assert.throws(() => syncSidebar(ok + '// @sync-css-begin\n', shell), /"css" region/);
  assert.throws(() => syncSidebar('nothing', shell), /region markers/);
});

test('extractShell: an index.html without the pieces is an error', () => {
  assert.throws(() => extractShell('<style>a{}</style>'), /jsdelivr/);
  const tags = '<script src="https://cdn.jsdelivr.net/npm/a"></script>' +
    '<script src="https://cdn.jsdelivr.net/npm/b"></script>';
  assert.throws(() => extractShell(tags + '// @render-begin\nx\n// @render-end'), /<style>/);
  assert.throws(() => extractShell(tags + '<style>a{}</style>'), /@render block/);
  const shell = extractShell(tags + '<style>a{}</style>\n// @render-begin\nfunction x() {}\n\n// @render-end\n');
  assert.equal(shell.render, 'function x() {}');
  assert.equal(shell.css, 'a{}');
});

test('cssLiteral: a literal that is safe inside a <script>', () => {
  const lit = cssLiteral('a::after{content:"</script>\u2028"}');
  assert.equal(lit.includes('<'), false);
  assert.equal(lit.includes('\u2028'), false);
  assert.equal(JSON.parse(lit.replace(/\\u2028/g, '\u2028')), 'a::after{content:"</script>\u2028"}');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
