// Copies the shared card renderer from index.html into Sidebar.html, so the Flash
// menu preview is one static page and nothing is extracted from index.html at run
// time on the Apps Script server. The tab splitter (the "@tabs" block) is copied into
// Highlight.gs as well, so the sheet tools split a cell exactly as the app does.
//   node tools/sync-preview.mjs           rewrite Sidebar.html and Highlight.gs if out of date
//   node tools/sync-preview.mjs --check   exit 1 when one is out of date (CI)
// Copied into Sidebar.html: the pinned marked/DOMPurify <script> tags, the stylesheet (as a
// JS string) and the "@render" block (the code between "// @render-begin" and
// "// @render-end"). Sidebar.html holds three regions the tool owns, each between a begin
// and an end line:
//   <!-- @sync-scripts-begin --> ... <!-- @sync-scripts-end -->
//   // @sync-render-begin ... // @sync-render-end
//   // @sync-css-begin ... // @sync-css-end
// Highlight.gs holds one: // @sync-tabs-begin ... // @sync-tabs-end
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
    tabs: first(/^\/\/ @tabs-begin\n([\s\S]*?)^\/\/ @tabs-end$/m, 'the @tabs block')
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

const HIGHLIGHT_REGIONS = [
  { name: 'tabs', begin: '// @sync-tabs-begin', end: '// @sync-tabs-end', body: (s) => s.tabs },
];

// `text` of `file` with every region rewritten from the shell.
function syncRegions(text, regions, shell, file) {
  let out = text;
  for (const r of regions) {
    const from = out.indexOf(r.begin);
    const to = out.indexOf(r.end);
    if (from < 0 || to < from || out.indexOf(r.begin, from + 1) >= 0) {
      throw new Error(`${file}: the "${r.name}" region markers are missing or repeated`);
    }
    out = out.slice(0, from + r.begin.length) + '\n' + r.body(shell) + '\n' + out.slice(to);
  }
  return out;
}

export const syncSidebar = (sidebar, shell) =>
  syncRegions(sidebar, REGIONS, shell, 'Sidebar.html');
export const syncHighlight = (highlight, shell) =>
  syncRegions(highlight, HIGHLIGHT_REGIONS, shell, 'Highlight.gs');

// Rewrites (or, with check, only compares) the files; `changed` names the stale ones.
export function run(root, check) {
  const shell = extractShell(read(root, 'index.html'));
  const changed = [];
  for (const [file, sync] of [['Sidebar.html', syncSidebar], ['Highlight.gs', syncHighlight]]) {
    const current = read(root, file);
    const wanted = sync(current, shell);
    if (wanted !== current) {
      changed.push(file);
      if (!check) {
        fs.writeFileSync(path.join(root, file), wanted);
      }
    }
  }
  return { changed: changed.length > 0, files: changed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const check = process.argv.includes('--check');
  try {
    const { changed, files } = run(root, check);
    if (check && changed) {
      console.error(`${files.join(', ')} out of date: run node tools/sync-preview.mjs`);
      process.exit(1);
    }
    console.log(changed ? `${files.join(', ')} updated` : 'Sidebar.html, Highlight.gs up to date');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
