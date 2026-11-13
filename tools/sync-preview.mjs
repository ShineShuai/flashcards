// Copies the shared card renderer from index.html into Sidebar.html, so the Flash
// menu preview is one static page and nothing is extracted from index.html at run
// time on the Apps Script server.
//   node tools/sync-preview.mjs           rewrite Sidebar.html if it is out of date
//   node tools/sync-preview.mjs --check   exit 1 when it is out of date (CI)
// Copied: the pinned marked/DOMPurify <script> tags, the stylesheet (as a JS string)
// and the "@render" block (the code between "// @render-begin" and "// @render-end").
// Sidebar.html holds three regions the tool owns, each between a begin and an end line:
//   <!-- @sync-scripts-begin --> ... <!-- @sync-scripts-end -->
//   // @sync-render-begin ... // @sync-render-end
//   // @sync-css-begin ... // @sync-css-end
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

// What index.html shares with the preview.
export function extractShell(index) {
  const first = (re, what) => {
    const m = index.match(re);
    if (!m) {
      throw new Error(`index.html: ${what} not found`);
    }
    return m[1];
  };
  const scripts = index.match(/<script[^>]*cdn\.jsdelivr\.net[^>]*><\/script>/g) || [];
  if (scripts.length !== 2) {
    throw new Error(`index.html: expected 2 pinned jsdelivr <script> tags, found ${scripts.length}`);
  }
  return {
    scripts: scripts.join('\n'),
    css: first(/<style>([\s\S]*?)<\/style>/, 'the <style> block'),
    render: first(/^\/\/ @render-begin\n([\s\S]*?)^\/\/ @render-end$/m, 'the @render block')
      .replace(/\n+$/, ''),
  };
}

// The stylesheet as a JS string literal that can sit in an inline <script>:
// "<" is escaped (no tag can close), and so are the two line separators.
export const cssLiteral = (css) => JSON.stringify(css)
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const REGIONS = [
  { name: 'scripts', begin: '<!-- @sync-scripts-begin -->', end: '<!-- @sync-scripts-end -->',
    body: (s) => s.scripts },
  { name: 'render', begin: '// @sync-render-begin', end: '// @sync-render-end',
    body: (s) => s.render },
  { name: 'css', begin: '// @sync-css-begin', end: '// @sync-css-end',
    body: (s) => `const APP_CSS = ${cssLiteral(s.css)};` },
];

// Sidebar.html with every region rewritten from the shell.
export function syncSidebar(sidebar, shell) {
  let out = sidebar;
  for (const r of REGIONS) {
    const from = out.indexOf(r.begin);
    const to = out.indexOf(r.end);
    if (from < 0 || to < from || out.indexOf(r.begin, from + 1) >= 0) {
      throw new Error(`Sidebar.html: the "${r.name}" region markers are missing or repeated`);
    }
    out = out.slice(0, from + r.begin.length) + '\n' + r.body(shell) + '\n' + out.slice(to);
  }
  return out;
}

export function run(root, check) {
  const current = read(root, 'Sidebar.html');
  const wanted = syncSidebar(current, extractShell(read(root, 'index.html')));
  if (wanted === current) {
    return { changed: false };
  }
  if (!check) {
    fs.writeFileSync(path.join(root, 'Sidebar.html'), wanted);
  }
  return { changed: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const check = process.argv.includes('--check');
  try {
    const { changed } = run(root, check);
    if (check && changed) {
      console.error('Sidebar.html is out of date: run node tools/sync-preview.mjs');
      process.exit(1);
    }
    console.log(changed ? 'Sidebar.html updated' : 'Sidebar.html is up to date');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
