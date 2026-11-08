// Shared jsdom harness: loads index.html with a stubbed google.script.run.
// Needs jsdom:  npm install --no-save jsdom
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ ||= 'Europe/Berlin';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/, '')   // marked: stubbed below
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
//          docsFail, failDue (getDueCards fails),
//          server { failFirst, delay, reply }  (updateCard behaviour)
export function boot(options = {}) {
  const { cards = [], storage = {}, dark = false, blockStorage = false,
          docsFail = false, failDue = false, server = {} } = options;
  const ev = [];                                  // what the "server" saw, in order
  const srv = { failFirst: 0, delay: 0, reply: { ok: true }, saved: [], ...server };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.marked = { parse: (x) => x };
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
          ok({ stats: { total: n, due: n, new: n, review: 0 }, cards: clone() });
        } else if (fn === 'getDueCards') {
          ev.push('getDueCards');
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
    w, ev, srv, $,
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
