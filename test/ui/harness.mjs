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

// The page's clock. Tests must not depend on the wall clock: the app counts days from 04:00
// (the study day) and DST moves a card's time of day, so a test run at the wrong hour of the
// wrong day failed. Every window starts at NOW and runs on from there; fixtures are made from
// NOW, never from Date.now(). FC_NOW=2026-11-23T02:30:00 (local time) runs a test at another
// moment: CI repeats the date-using tests at 02:30, before the rollover. Keep FC_NOW off the
// hours around a DST change: the app's studyDay subtracts 4 real hours, so on those two days
// a year its boundary is an hour off the wall clock (and a test that counts calendar days
// is too).
export const NOW = process.env.FC_NOW ? new Date(process.env.FC_NOW) : new Date(2026, 10, 23, 14, 30, 0);
if (Number.isNaN(NOW.getTime())) {
  throw new Error('FC_NOW is not a date: ' + process.env.FC_NOW);
}

// The Date n calendar days before `from` (default NOW), at the same local time of day. Use it,
// not "n * 24 h": across a DST change that lands an hour off, which can move a card across the
// 04:00 rollover and change its gap by a day.
export function daysAgo(n, from = NOW) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

// Replaces the window's Date by one that starts at `start` and ticks from there. `set` and
// `advance` move it. (Only the window's: Node's stays real, so a test's own timeouts do too.)
function installClock(w, start) {
  const Real = w.Date;
  let offset = new Date(start).getTime() - Real.now();
  const now = () => Real.now() + offset;
  function PinnedDate(...args) {
    if (!new.target) {
      return new Real(now()).toString();                  // Date() called as a function
    }
    return Reflect.construct(Real, args.length ? args : [now()], new.target);
  }
  PinnedDate.prototype = Real.prototype;                  // instanceof, methods: unchanged
  PinnedDate.now = now;
  PinnedDate.parse = Real.parse;
  PinnedDate.UTC = Real.UTC;
  w.Date = PinnedDate;
  return {
    now: () => new Real(now()),
    set(moment) {
      offset = new Date(moment).getTime() - Real.now();
    },
    advance(ms) {
      offset += ms;
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/g, '')   // marked, DOMPurify: below
  .replace(/<link[^>]*fonts[^>]*>/, '');

// An AudioContext that records its oscillators; `log.created` counts the contexts made.
export function stubAudio(w) {
  const log = { created: 0, osc: [] };
  w.AudioContext = class {
    constructor() {
      log.created++;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {}
    createGain() {
      const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return { gain: param, connect() {} };
    }
    createOscillator() {
      const osc = { frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      log.osc.push(osc);
      return osc;
    }
  };
  return log;
}

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
//          learning (derived) => { due: [cards], waiting: [{ id, due: ISO }] } (getLearning;
//          derived = what the saved ratings leave in the learning phase, not due yet: the
//          default reply),
//          upcoming { waiting: [ISO..], nextDue: ISO } | () => that (sent with bootstrap; read
//          on every call, so a test can change it; absent: like an older server),
//          activity { today, days } | Error (getActivity)
//          horizonCards [..] | Error (getHorizonCards), applyHorizon (changes) => reply
//          recallRows [..] | Error (getRecallRows)
//          aheadCards (refs) => [cards] | Error (getCardsIfUnchanged)
//          server { failFirst, delay, reply }  (updateCard behaviour)
//          now (a Date or anything new Date() takes; default NOW): where the page's clock starts;
//          env.clock.now() / set(moment) / advance(ms) read and move it
export function boot(options = {}) {
  const { cards = [], storage = {}, dark = false, blockStorage = false,
          docsFail = false, failDue = false, config, realMarkdown = false, noSanitizer = false,
          versionServer = {}, reviewLog, weightsHistory = [], saveSettings, forecast, newLimit,
          upcoming, learning, activity, horizonCards = [], applyHorizon, recallRows = [],
          aheadCards,
          server = {}, now = NOW } = options;
  let clock;
  const ev = [];                                  // what the "server" saw, in order
  const srv = { failFirst: 0, delay: 0, reply: { ok: true }, saved: [], settingsCalls: [],
                bootstrapArgs: [], activityArgs: [], dueArgs: [], horizonCalls: [],
                recallCalls: 0, aheadCalls: [], learningCalls: 0, ...server };
  const own = html.match(/^const APP_VERSION = '([^']*)';/m)[1];
  const ver = { version: own, url: 'https://script.google.test/macros/s/ID/exec', fail: false,
                calls: 0, ...versionServer };   // calls: kept out of ev, which orders saves
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/',
    pretendToBeVisual: true,
    beforeParse(w) {
      clock = installClock(w, now);
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
            config: typeof config === 'function' ? config() : config, forecast, newLimit,
            ...(typeof upcoming === 'function' ? upcoming() : upcoming) });
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
        } else if (fn === 'getLearning') {
          srv.learningCalls++;
          const last = new Map(srv.saved.map((x) => [x.id, x.fsrs]));
          const at = clock.now().getTime();
          const derived = { due: [], waiting: [...last]
            .filter(([, f]) => [1, 3].includes(Number(f.state)) && Date.parse(f.due) > at)
            .map(([id, f]) => ({ id, due: f.due })) };
          const reply = learning ? learning(derived) : derived;
          if (reply instanceof Error) {
            bad({ message: reply.message });
          } else {
            ok({ due: reply.due.map((c) => ({ ...c })), waiting: reply.waiting });
          }
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
        } else if (fn === 'getCardsIfUnchanged') {
          srv.aheadCalls.push(args[0]);
          const reply = aheadCards ? aheadCards(args[0]) : [];
          if (reply instanceof Error) {
            bad({ message: reply.message });
          } else {
            ok(reply.map((c) => ({ ...c })));
          }
        } else if (fn === 'getRecallRows') {
          srv.recallCalls++;
          if (recallRows instanceof Error) {
            bad({ message: recallRows.message });
          } else {
            ok(recallRows.map((c) => ({ ...c })));
          }
        } else if (fn === 'getHorizonCards') {
          if (horizonCards instanceof Error) {
            bad({ message: horizonCards.message });
          } else {
            ok(horizonCards.map((c) => ({ ...c })));
          }
        } else if (fn === 'applyHorizon') {
          srv.horizonCalls.push(args[0]);
          const reply = applyHorizon ? applyHorizon(args[0]) : { ok: true, applied: [] };
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
    w, ev, srv, ver, $, clock,
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
