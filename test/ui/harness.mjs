// Shared jsdom harness: loads index.html with a stubbed google.script.run.
// Needs:  npm install --no-save jsdom dompurify marked   (versions: see test.yml)
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const createDOMPurify = require('dompurify');
const realMarked = require('marked');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ ||= 'Europe/Berlin';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/g, '')   // marked, DOMPurify: below
  .replace(/<link[^>]*fonts[^>]*>/, '');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) {
      throw new Error('timeout waiting for condition');
    }
    await sleep(5);
  }
}

export const card = (id, keywords = 'a;b;c', extra = {}) => ({
  id, title: 'T' + id, keywords, back_content: 'B' + id, back_type: 'text', ...extra,
});

// options: cards, storage (initial localStorage), dark (system theme), blockStorage,
//          docsFail, failDue (getDueCards fails), config (sent with bootstrap; or a function),
//          realMarkdown (real marked instead of an identity stub), noSanitizer,
//          versionServer { version, url, fail } (getVersion; default: the page's own version),
//          reviewLog { columns, rows }, weightsHistory [..], saveSettings (patch, meta) => reply,
//          forecast [..], newLimit { limit, introduced, remaining } (both sent with bootstrap),
//          activity { today, days } | Error (getActivity)
//          server { failFirst, delay, reply }  (updateCard behaviour)
export function boot(options = {}) {
  const { cards = [], storage = {}, dark = false, blockStorage = false,
          docsFail = false, failDue = false, config, realMarkdown = false, noSanitizer = false,
          versionServer = {}, reviewLog, weightsHistory = [], saveSettings, forecast, newLimit,
          activity, server = {} } = options;
  const ev = [];                                  // what the "server" saw, in order
  const srv = { failFirst: 0, delay: 0, reply: { ok: true }, saved: [], settingsCalls: [],
                bootstrapArgs: [], activityArgs: [], dueArgs: [], ...server };
  const own = html.match(/^const APP_VERSION = '([^']*)';/m)[1];
  const ver = { version: own, url: 'https://script.google.test/macros/s/ID/exec', fail: false,
                calls: 0, ...versionServer };   // calls: kept out of ev, which orders saves
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/',
    pretendToBeVisual: true,
    beforeParse(w) {
      // A page interval (the version check) must not keep the test process alive
      w.setInterval = (fn, ms, ...rest) => {
        const timer = setInterval(fn, ms, ...rest);
        timer.unref();
        return timer;
      };
      w.clearInterval = (timer) => clearInterval(timer);
      w.marked = realMarkdown ? realMarked : { parse: (x) => x };
      if (!noSanitizer) {
        w.DOMPurify = createDOMPurify(w);               // the real one, bound to this window
      }
      w.alert = () => {};
      w.matchMedia = (q) => ({ matches: dark && /dark/.test(q), addEventListener() {} });
      w.URL.createObjectURL = () => 'blob:test';
      w.URL.revokeObjectURL = () => {};
      if (blockStorage) {
        Object.defineProperty(w, 'localStorage', {
          get() {
            throw new w.DOMException('denied', 'SecurityError');
          },
        });
      } else {
        Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      }
      const server$ = (ok, bad) => new Proxy({}, {
        get(_, fn) {
          if (fn === 'withSuccessHandler') {
            return (f) => server$(f, bad);
          }
          if (fn === 'withFailureHandler') {
            return (f) => server$(ok, f);
          }
          return (...args) => setTimeout(() => call(fn, args, ok, bad), 0);
        },
      });
      const clone = () => cards.map((c) => ({ ...c }));
      function call(fn, args, ok, bad) {
        if (fn === 'bootstrap') {
          ev.push('bootstrap');
          const n = cards.length;
          srv.bootstrapArgs.push(args);
          ok({ stats: { total: n, due: n, new: n, review: 0 }, cards: clone(),
            config: typeof config === 'function' ? config() : config, forecast, newLimit });
        } else if (fn === 'getDueCards') {
          ev.push('getDueCards');
          srv.dueArgs.push(args);
          if (failDue) {
            bad({ message: 'boom' });
          } else {
            ok(clone());
          }
        } else if (fn === 'updateCard') {
          if (srv.failFirst > 0) {
            srv.failFirst--;
            ev.push('fail:' + args[0]);
            bad({ message: 'offline' });
            return;
          }
          setTimeout(() => {
            ev.push('save:' + args[0]);
            srv.saved.push({ id: args[0], fsrs: args[1], meta: args[2] });
            ok(srv.reply);
          }, srv.delay);
        } else if (fn === 'getActivity') {
          srv.activityArgs.push(args);
          if (activity instanceof Error) {
            bad({ message: activity.message });
          } else if (activity) {
            ok(activity);
          }
        } else if (fn === 'getReviewLog') {
          if (reviewLog instanceof Error) {
            bad({ message: reviewLog.message });
          } else {
            ok(reviewLog || { columns: ['review_time'], rows: [] });
          }
        } else if (fn === 'getWeightsHistory') {
          ok(weightsHistory.map((h) => ({ ...h })));
        } else if (fn === 'saveSettings') {
          srv.settingsCalls.push({ patch: args[0], meta: args[1] });
          const reply = saveSettings ? saveSettings(args[0], args[1]) : { ok: true, config: {} };
          if (reply instanceof Error) {
            bad({ message: reply.message });
          } else {
            ok(reply);
          }
        } else if (fn === 'getVersion') {
          ver.calls++;
          if (ver.fail) {
            bad({ message: 'offline' });
          } else {
            ok({ version: ver.version, url: ver.url });
          }
        } else if (fn === 'getDocsHtml') {
          if (docsFail) {
            bad({ message: 'nope' });
          } else {
            ok('<html>docs</html>');
          }
        }
      }
      w.google = { script: { run: server$(() => {}, () => {}) } };
    },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  return {
    w, ev, srv, ver, $,
    saved: srv.saved,
    txt: (id) => $(id).textContent,
    shown: (id) => !$(id).classList.contains('hidden'),
    key(k, opts = {}, target = w.document.body) {
      const init = { key: k, bubbles: true, cancelable: true, ...opts };
      const e = new w.KeyboardEvent('keydown', init);
      target.dispatchEvent(e);
      return e;
    },
    // waits for the home screen, then starts a session from the cached bootstrap cards
    async start() {
      await until(() => !$('s-home').classList.contains('hidden'));
      w.startSession();
      await sleep(5);
    },
  };
}
