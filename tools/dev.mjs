#!/usr/bin/env node
// Local dev server: look at and click through the app without deploying anything.
//   node tools/dev.mjs [--port 8787] [--lan] [--latency 200] [--reset] [--offline]
//
// Serves the real index.html and Sidebar.html; google.script.run is replaced by fetch() calls
// to /rpc, which runs the real Code.gs against the in-memory Sheets model of test/code.mjs
// (a model, not the real service: IMAGE(), emoji styling, number formats, quotas, sandbox
// quirks need the real Apps Script: tools/dev-push.mjs). Files are read on every request:
// edit, reload. Cards are seeded from tools/dev-fixtures.mjs; the sheet is kept in
// .dev/sheet.json between runs (--reset reseeds).
//
//   /          the app (as /exec)          /framed   the app in an Apps Script-like frame
//                                              /framed?block=1  ... that may not navigate the top
//                                              window: the update banner, not the auto reload
//   /sidebar   Flash > Preview (sidebar)   /sidebar?mode=window   ... as the window
//   /?page=docs   the documentation
//   /__dev/version?v=X      pretend X was just deployed (the app should update itself)
//   /__dev/fail?fn=F&n=N    the next N calls of F fail (offline, quota)
//   /__dev/row?n=R          select sheet row R (the sidebar follows)
//   --offline  marked and DOMPurify from node_modules instead of jsdelivr (no network)
//   --lan      listen on all interfaces, to open it on a phone (plain http: no clipboard API)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodeGs } from '../test/code.mjs';
import { fixtureCards } from './dev-fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GS_FILES = ['Code.gs', 'Config.gs', 'Version.gs', 'Highlight.gs', 'Preview.gs'];
// The sandbox attribute of the frame Apps Script puts a web app in (as far as known: check
// on a /dev deployment). Whether the update reload of the top window goes through then depends
// on the browser and on user activation: ?block=1 takes the top-navigation flag away.
const FRAME_SANDBOX = 'allow-downloads allow-forms allow-modals allow-popups ' +
  'allow-popups-to-escape-sandbox allow-same-origin allow-scripts ' +
  'allow-storage-access-by-user-activation allow-top-navigation-by-user-activation';
const VENDOR = {
  'marked.js': 'marked/lib/marked.umd.js',
  'purify.js': 'dompurify/dist/purify.min.js',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What google.script.run refuses to carry (a Date, a function, ...): the path of the first
// offender, or ''. Shared by the server and the page shim, so both fail like Apps Script.
export function illegalPath(value, at = '') {
  if (value instanceof Date || ['function', 'symbol', 'bigint'].includes(typeof value)) {
    return at || '0';
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const bad = illegalPath(item, at ? at + '.' + key : key);
      if (bad) {
        return bad;
      }
    }
  }
  return '';
}

// Runs in the page, in place of Apps Script's google.script.run.
function shimMain(illegal) {
  const exec = new URLSearchParams(location.search).get('exec') || '';
  const call = (fn, args, ok, bad) => {
    const where = illegal(args);
    if (where) {
      setTimeout(() => bad(new Error('Failed due to illegal value in property: ' + where)), 0);
      return;
    }
    fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fc-exec': exec },
      body: JSON.stringify({ fn, args }),
    }).then((r) => r.json()).then(
      (r) => ('error' in r ? bad(new Error(r.error)) : ok(r.result)),
      (e) => bad(new Error(String(e))),
    );
  };
  const make = (ok, bad) => new Proxy({}, {
    get(_, fn) {
      if (fn === 'withSuccessHandler') {
        return (f) => make(f, bad);
      }
      if (fn === 'withFailureHandler') {
        return (f) => make(ok, f);
      }
      return (...args) => call(fn, args, ok, bad);
    },
  });
  window.google = { script: { run: make(() => {}, (e) => console.error(e.message)) } };
}
const SHIM = `${illegalPath};(${shimMain})(illegalPath);`;

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function findModule(rel) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', rel);
    if (fs.existsSync(file)) {
      return file;
    }
    if (dir === path.dirname(dir)) {
      throw new Error(`${rel} not found: npm install --no-save marked dompurify`);
    }
  }
}

const framePage = (inner, exec, sandbox) => `<!DOCTYPE html><meta charset="utf-8">
<title>Flash (framed)</title><style>html,body{margin:0;height:100%}iframe{border:0;
width:100%;height:100%}</style>
<iframe sandbox="${sandbox}" src="${inner}?exec=${encodeURIComponent(exec)}"></iframe>`;

const sidebarPage = (windowMode) => `<!DOCTYPE html><meta charset="utf-8">
<title>Preview card (dev)</title>
<style>body{margin:0;display:flex;gap:16px;padding:12px;background:#e8e8ee;
font:14px system-ui}iframe{border:1px solid #888;background:#fff;
width:${windowMode ? 640 : 300}px;height:${windowMode ? 560 : 'calc(100vh - 26px)'}}
select{width:230px}</style>
<div><b>Sheet row</b><br><select id="rows" size="14"></select>
<p><a href="/sidebar">sidebar (300 px)</a><br><a href="/sidebar?mode=window">window (640x560)</a>
</p></div><iframe src="/frame/sidebar"></iframe>
<script>
const sel = document.getElementById('rows');
fetch('/__dev/rows').then((r) => r.json()).then((rows) => {
  rows.forEach((r) => sel.add(new Option(r.row + ' · ' + r.id + ' · ' + r.title, r.row)));
  sel.value = 2;
  sel.onchange = () => fetch('/__dev/row?n=' + sel.value);
  sel.onchange();
});
</script>`;

// opts: port (0 = any), host, latency (ms), reset, offline, stateFile (null: keep nothing),
//       log (a function)
export async function startDevServer(opts = {}) {
  const { port = 8787, host = '127.0.0.1', latency = 200, reset = false, offline = false,
          stateFile = path.join(root, '.dev', 'sheet.json'), log = console.log } = opts;
  const fixtures = fixtureCards();
  const fixtureHash = crypto.createHash('sha1').update(JSON.stringify(fixtures))
    .digest('hex').slice(0, 8);
  const failures = new Map();
  let versionOverride = '';
  let env;
  let loadedKey = '';

  const codeKey = () => GS_FILES.map((f) => fs.statSync(path.join(root, f)).mtimeMs).join();
  const cardsSheet = () => env.sheets.get('cards');
  const selectSheet = () => {
    env.ctx.__active = cardsSheet();
  };

  function snapshot() {
    return {
      fixtures: fixtureHash,
      sheets: Object.fromEntries([...env.sheets].map(([name, s]) => [name, {
        cells: [...s.cells], fmt: [...s.fmt], active: s.active,
      }])),
    };
  }
  function restore(snap) {
    for (const [name, data] of Object.entries(snap.sheets)) {
      const s = env.ss.getSheetByName(name) || env.ss.insertSheet(name);
      s.cells = new Map(data.cells);
      s.fmt = new Map(data.fmt);
      s.active = data.active;
    }
    selectSheet();
  }
  const encode = function (key, value) {
    return this[key] instanceof Date ? { $date: this[key].toISOString() } : value;
  };
  const decode = (key, value) => (value && typeof value === 'object' && '$date' in value
    ? new Date(value.$date) : value);

  function seed() {
    env.api.setupSheet();                       // cards and review_log, as in a new sheet
    const sheet = cardsSheet();
    fixtures.forEach((card, i) => env.api.HEADERS.forEach((h, c) => {
      sheet.raw(i + 2, c + 1, card[h] ?? '');
    }));
    selectSheet();
  }
  const persist = () => {
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(snapshot(), encode));
    }
  };

  // The server code is reloaded when a .gs file changed; the sheet survives through a snapshot.
  function load() {
    const key = codeKey();
    if (key === loadedKey) {
      return;
    }
    const snap = env ? JSON.parse(JSON.stringify(snapshot(), encode), decode) : null;
    env = loadCodeGs();
    loadedKey = key;
    if (snap) {
      restore(snap);
      return;
    }
    const saved = !reset && stateFile && fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf8'), decode) : null;
    if (saved) {
      restore(saved);
      if (saved.fixtures !== fixtureHash) {
        log('note: the fixture cards changed since this sheet was saved; use --reset');
      }
    } else {
      seed();
    }
  }
  load();
  persist();

  const own = () => env.api.APP_VERSION;
  const served = () => versionOverride || own();

  async function rpc(req, { fn, args = [] }) {
    const started = Date.now();
    await sleep(latency);
    load();
    const left = failures.get(fn) || 0;
    if (left > 0) {
      failures.set(fn, left - 1);
      return { error: `dev: injected failure of ${fn}` };
    }
    const f = env.ctx[fn];
    if (typeof f !== 'function' || fn.endsWith('_')) {
      return { error: `Script function not found: ${fn}` };
    }
    const bad = illegalPath(args);
    if (bad) {
      return { error: 'Failed due to illegal value in property: ' + bad };
    }
    env.ctx.__url = req.headers['x-fc-exec'] || `http://${req.headers.host}/`;
    let result;
    try {
      result = f(...args);
    } catch (err) {
      log(`rpc ${fn} threw: ${err.message}`);
      return { error: err.message };
    }
    if (fn === 'getVersion' && versionOverride) {
      result = { ...result, version: versionOverride };
    }
    const badResult = illegalPath(result);
    if (badResult) {
      log(`rpc ${fn}: illegal value in the result at ${badResult}`);
      return { error: 'Failed due to illegal value in property: ' + badResult };
    }
    persist();
    log(`rpc ${fn} ${Date.now() - started} ms`);
    return { result: result === undefined ? null : result };
  }

  // marked and DOMPurify: jsdelivr (pinned, with integrity) or, with offline, node_modules
  function vendor(html) {
    if (!offline) {
      return html;
    }
    return html.replace(/<script[^>]*cdn\.jsdelivr\.net[^>]*><\/script>/g, (tag) => {
      const name = /\/marked@/.test(tag) ? 'marked.js'
        : /\/dompurify@/.test(tag) ? 'purify.js' : '';
      return name ? `<script src="/vendor/${name}"></script>` : tag;
    });
  }
  const withShim = (html) => html.replace(/<head>/i, (m) => `${m}<script>${SHIM}</script>`);

  const send = (res, status, type, body) => {
    res.writeHead(status, {
      'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(body);
  };
  const json = (res, value) => send(res, 200, 'application/json', JSON.stringify(value));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const origin = `http://${req.headers.host}`;
    try {
      if (req.method === 'POST' && url.pathname === '/rpc') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        return json(res, await rpc(req, JSON.parse(body)));
      }
      load();
      switch (url.pathname) {
        case '/':
          if (url.searchParams.get('page') === 'docs') {
            return send(res, 200, 'text/html', read('docs.html'));
          }
          return send(res, 200, 'text/html', withShim(vendor(read('index.html')))
            .replace(/^const APP_VERSION = '[^']*';/m, `const APP_VERSION = '${served()}';`));
        case '/framed': {
          // another origin than the outer page where the host name allows it, as on Google's
          const [, name, rest] = /^(localhost|127\.0\.0\.1)(:\d+)?$/.exec(req.headers.host) || [];
          const other = name ? (name === 'localhost' ? '127.0.0.1' : 'localhost') + (rest || '')
            : req.headers.host;
          const sandbox = url.searchParams.has('block')
            ? FRAME_SANDBOX.replace(' allow-top-navigation-by-user-activation', '')
            : FRAME_SANDBOX;
          return send(res, 200, 'text/html',
            framePage(`http://${other}/`, `${origin}/framed`, sandbox));
        }
        case '/sidebar':
          return send(res, 200, 'text/html',
            sidebarPage(url.searchParams.get('mode') === 'window'));
        case '/frame/sidebar':
          return send(res, 200, 'text/html', withShim(vendor(read('Sidebar.html'))));
        case '/__dev/version':
          versionOverride = url.searchParams.get('v') || '';
          return json(res, { version: served() });
        case '/__dev/fail':
          failures.set(url.searchParams.get('fn'), Number(url.searchParams.get('n') || 1));
          return json(res, { ok: true });
        case '/__dev/row':
          cardsSheet().active = { r: Number(url.searchParams.get('n')), c: 1 };
          persist();
          return json(res, { ok: true });
        case '/__dev/rows': {
          const sheet = cardsSheet();
          const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
          const at = (name) => headers.indexOf(name) + 1;
          return json(res, Array.from({ length: Math.max(sheet.getLastRow() - 1, 0) }, (_, i) => ({
            row: i + 2, id: String(sheet.get(i + 2, at('id'))),
            title: String(sheet.get(i + 2, at('title'))),
          })));
        }
        default: {
          const name = url.pathname.replace(/^\/vendor\//, '');
          if (offline && url.pathname.startsWith('/vendor/') && VENDOR[name]) {
            return send(res, 200, 'text/javascript', fs.readFileSync(findModule(VENDOR[name])));
          }
          return send(res, 404, 'text/plain', 'not found');
        }
      }
    } catch (err) {
      log(`${req.method} ${url.pathname} failed: ${err.stack}`);
      return send(res, 500, 'text/plain', err.message);
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const base = `http://localhost:${server.address().port}`;
  return {
    server, base, env: () => env,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? fallback : Number(argv[at + 1]);
  };
  const lan = flag('lan');
  const dev = await startDevServer({
    port: value('port', 8787), host: lan ? '0.0.0.0' : '127.0.0.1',
    latency: value('latency', 200), reset: flag('reset'), offline: flag('offline'),
  });
  console.log(`Flash dev server
  app      ${dev.base}/
  framed   ${dev.base}/framed
  sidebar  ${dev.base}/sidebar   (?mode=window)
  docs     ${dev.base}/?page=docs
  sheet    .dev/sheet.json (--reset reseeds); dev hooks: /__dev/version /__dev/fail /__dev/row`);
  if (lan) {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const portNo = dev.server.address().port;
    console.log(`  phone    ${ips.map((ip) => `http://${ip}:${portNo}/`).join('  ')}`);
  }
}
