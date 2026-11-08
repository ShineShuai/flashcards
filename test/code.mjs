// Run: node test/code.mjs   (no dependencies)
// Runs Code.gs against an in-memory model of the Apps Script services.
// The Sheets model converts values written to non-text cells the way Sheets
// does (ISO strings and "3/4" -> Date, numeric strings -> number, "=x" -> formula);
// it is a model, not the real service.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function loadCodeGs(file = path.join(here, '..', 'Code.gs')) {
  const code = fs.readFileSync(file, 'utf8');
  const stats = { calls: {}, locks: 0, failAppend: false };
  const bump = (name) => {
    stats.calls[name] = (stats.calls[name] || 0) + 1;
  };

  const convert = (v) => {
    if (typeof v !== 'string') {
      return v;
    }
    if (v.startsWith('=')) {
      return { formula: v };
    }
    if (/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)) {
      return new Date(v);
    }
    if (/^\d{1,2}\/\d{1,2}$/.test(v)) {
      return new Date(Date.UTC(2026, Number(v.split('/')[0]) - 1, Number(v.split('/')[1])));
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) {
      return Number(v);
    }
    return v;
  };

  class Sheet {
    constructor(name) {
      this.name = name;
      this.cells = new Map();
      this.fmt = new Map();
      this.maxRows = 1000;
    }
    key(r, c) {
      return `${r},${c}`;
    }
    put(r, c, v) {
      const stored = this.fmt.get(this.key(r, c)) === '@' ? v : convert(v);
      this.cells.set(this.key(r, c), stored);
    }
    raw(r, c, v) {   // test helper: store without conversion
      this.cells.set(this.key(r, c), v);
    }
    get(r, c) {
      const v = this.cells.get(this.key(r, c));
      return v === undefined ? '' : v;
    }
    getMaxRows() {
      return this.maxRows;
    }
    getLastRow() {
      bump('getLastRow');
      let m = 0;
      for (const [k, v] of this.cells) {
        if (v !== '') {
          m = Math.max(m, Number(k.split(',')[0]));
        }
      }
      return m;
    }
    getLastColumn() {
      bump('getLastColumn');
      let m = 0;
      for (const [k, v] of this.cells) {
        if (v !== '') {
          m = Math.max(m, Number(k.split(',')[1]));
        }
      }
      return m;
    }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        return this.fromA1(a);
      }
      return new Range(this, a, b, c || 1, d || 1);
    }
    fromA1(a1) {
      const m = a1.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
      const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      const c1 = col(m[1]);
      const r1 = m[2] ? Number(m[2]) : 1;
      const c2 = m[3] ? col(m[3]) : c1;
      const r2 = m[4] ? Number(m[4]) : (m[3] ? this.maxRows : r1);
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    getRangeList(list) {
      const sheet = this;
      return {
        setNumberFormat(f) {
          bump('rangeList.setNumberFormat');
          list.forEach((a1) => sheet.fromA1(a1).applyFormat(f));
        },
      };
    }
    getDataRange() {
      const rows = Math.max(this.getLastRow(), 1);
      const cols = Math.max(this.getLastColumn(), 1);
      return new Range(this, 1, 1, rows, cols);
    }
    appendRow(arr) {
      bump('appendRow');
      if (stats.failAppend) {
        throw new Error('quota');
      }
      const r = this.getLastRow() + 1;
      arr.forEach((v, i) => this.put(r, i + 1, v));
    }
    setFrozenRows() {}
    setColumnWidth() {}
  }
  class Range {
    constructor(sheet, r, c, nr, nc) {
      Object.assign(this, { sheet, r, c, nr, nc });
    }
    getValues() {
      bump('getValues');
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = this.sheet.get(this.r + i, this.c + j);
          row.push(v && v.formula ? '#FORMULA' : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      bump('setValues');
      vals.forEach((row, i) => row.forEach((v, j) => this.sheet.put(this.r + i, this.c + j, v)));
      return this;
    }
    setValue(v) {
      bump('setValue');
      this.sheet.put(this.r, this.c, v);
      return this;
    }
    applyFormat(f) {
      for (let i = 0; i < this.nr; i++) {
        for (let j = 0; j < this.nc; j++) {
          this.sheet.fmt.set(this.sheet.key(this.r + i, this.c + j), f);
        }
      }
    }
    setNumberFormat(f) {
      bump('setNumberFormat');
      this.applyFormat(f);
      return this;
    }
    setBackground() { return this; }
    setFontColor() { return this; }
    setFontWeight() { return this; }
  }

  const sheets = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet(n) {
      bump('insertSheet');
      const s = new Sheet(n);
      sheets.set(n, s);
      return s;
    },
  };
  const cache = new Map();
  const ctx = vm.createContext({
    Date,
    console: { log: console.log, error() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => bump('flush'),
      getUi: () => ({ alert() {} }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { stats.locks++; },
        releaseLock() {},
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.get(k) || null,
        put: (k, v) => cache.set(k, v),
      }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (alg, s) => [...crypto.createHash(alg).update(s).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
    },
    HtmlService: {}, ScriptApp: {},
  });
  const api = vm.runInContext(
    `${code}\n({ getDueCards, getStats, updateCard, setupSheet, HEADERS,` +
    ` bootstrap: typeof bootstrap === 'function' ? bootstrap : null })`, ctx);
  return { api, ss, sheets, stats, Sheet };
}

// ── tests ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  let failed = 0;
  const test = (name, fn) => {
    try {
      fn();
      console.log('ok   ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
    }
  };
  const iso = (d) => new Date(d).toISOString();
  const fsrsFor = (extra = {}) => ({
    stability: 12.5, difficulty: 6.2, elapsed_days: 3, scheduled_days: 9, reps: 4, lapses: 1,
    state: 2, last_review: '2026-11-06T09:00:00.000Z', due: '2026-11-15T03:00:00.000Z',
    weak_keywords: '3/4;1.5;=x', miss_streak: 2, ...extra,
  });

  function fixture(order) {
    const env = loadCodeGs();
    const sheet = env.ss.insertSheet('cards');
    const headers = order || env.api.HEADERS;
    headers.forEach((h, i) => sheet.raw(1, i + 1, h));
    const put = (r, obj) => headers.forEach((h, i) => {
      if (obj[h] !== undefined) {
        sheet.raw(r, i + 1, obj[h]);
      }
    });
    return { ...env, sheet, headers, put };
  }

  test('new sheet has title, 16 columns and text formats below the header', () => {
    const env = loadCodeGs();
    env.api.setupSheet();
    const sheet = env.sheets.get('cards');
    assert.deepEqual([...env.api.HEADERS].slice(0, 3), ['id', 'title', 'keywords']);
    assert.equal(sheet.get(1, 2), 'title');
    assert.equal(env.api.HEADERS.length, 16);
    assert.equal(sheet.fmt.get('2,3'), '@');                    // keywords
    assert.equal(sheet.fmt.get('1000,14'), '@');                // last_review
    assert.equal(sheet.fmt.get('1,3'), undefined);              // header row untouched
    assert.ok(env.sheets.get('review_log'));
  });

  test('setupSheet on an existing sheet formats only the empty rows below the data', () => {
    const env = fixture();
    env.put(2, { id: 'a', due: new Date('2026-11-01T00:00:00Z') });
    env.api.setupSheet();
    assert.equal(env.sheet.fmt.get('2,6'), undefined);          // existing due cell untouched
    assert.equal(env.sheet.fmt.get('3,6'), '@');
    assert.equal(env.sheet.fmt.get('3,3'), '@');
  });

  test('updateCard writes every field to its column and keeps text as text', () => {
    const env = fixture();
    env.put(2, {
      id: 'a', title: 'T', keywords: 'k1;k2', back_content: 'B', back_type: 'text',
      due: new Date('2026-11-01T00:00:00Z'),
      last_review: new Date('2026-10-30T00:00:00Z'),
    });
    env.put(3, { id: 'b', title: 'U' });
    const res = env.api.updateCard('a', fsrsFor());
    assert.deepEqual({ ...res }, { ok: true });
    const col = (h) => env.headers.indexOf(h) + 1;
    assert.equal(env.sheet.get(2, col('stability')), 12.5);
    assert.equal(env.sheet.get(2, col('state')), 2);
    assert.equal(env.sheet.get(2, col('due')), '2026-11-15T03:00:00.000Z');
    assert.equal(env.sheet.get(2, col('last_review')), '2026-11-06T09:00:00.000Z');
    assert.equal(env.sheet.get(2, col('weak_keywords')), '3/4;1.5;=x');
    assert.equal(env.sheet.get(2, col('miss_streak')), 2);
    assert.equal(env.sheet.get(2, col('title')), 'T');          // untouched
    assert.equal(env.sheet.get(2, col('back_content')), 'B');
    assert.equal(env.sheet.get(3, col('title')), 'U');          // other row untouched
    // single keywords that Sheets would convert
    for (const kw of ['3/4', '=x', '1.5']) {
      env.api.updateCard('a', fsrsFor({ weak_keywords: kw }));
      assert.equal(env.sheet.get(2, col('weak_keywords')), kw);
    }
  });

  test('few service calls per review (no full-sheet read, no flush)', () => {
    const env = fixture();
    for (let r = 2; r < 200; r++) {
      env.put(r, { id: 'c' + r });
    }
    env.api.updateCard('c150', fsrsFor());
    const c = env.stats.calls;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    assert.ok(total <= 8, `too many calls: ${JSON.stringify(c)}`);
    assert.equal(c.setValue || 0, 0);
    assert.equal(c.flush || 0, 0);
    assert.equal(c.setValues, 1);
  });

  test('any column order and extra columns; non-adjacent columns -> several runs', () => {
    const order = [
      'x1', 'last_review', 'id', 'due', 'x2', 'stability', 'difficulty', 'elapsed_days',
      'scheduled_days', 'reps', 'lapses', 'state', 'weak_keywords', 'miss_streak', 'x3',
    ];
    const env = fixture(order);
    env.put(2, { id: 'a', x1: 'keep1', x2: 'keep2', x3: 'keep3' });
    env.api.updateCard('a', fsrsFor());
    const col = (h) => order.indexOf(h) + 1;
    assert.equal(env.sheet.get(2, col('x1')), 'keep1');
    assert.equal(env.sheet.get(2, col('x2')), 'keep2');
    assert.equal(env.sheet.get(2, col('x3')), 'keep3');
    assert.equal(env.sheet.get(2, col('due')), '2026-11-15T03:00:00.000Z');
    assert.equal(env.sheet.get(2, col('reps')), 4);
    assert.equal(env.sheet.get(2, col('last_review')), '2026-11-06T09:00:00.000Z');
  });

  test('missing FSRS columns are added once, under the lock', () => {
    const env = fixture(['id', 'title', 'keywords']);
    env.put(2, { id: 'a' });
    env.api.updateCard('a', fsrsFor());
    assert.equal(env.stats.locks, 1);
    const headers = env.sheet.getRange(1, 1, 1, 20).getValues()[0].filter(Boolean);
    assert.equal(headers.length, 3 + 11);
    assert.equal(new Set(headers).size, headers.length);
    env.api.updateCard('a', fsrsFor({ reps: 5 }));
    assert.equal(env.stats.locks, 1, 'no lock once the columns exist');
    assert.equal(env.sheet.get(2, headers.indexOf('reps') + 1), 5);
  });

  test('unknown id / empty sheet -> ok:false', () => {
    const env = fixture();
    assert.equal(env.api.updateCard('nope', fsrsFor()).ok, false);
    env.put(2, { id: 'a' });
    assert.equal(env.api.updateCard('nope', fsrsFor()).ok, false);
    assert.equal(env.api.updateCard('a', fsrsFor()).ok, true);
  });

  test('review log: lazy sheet, one row per review, retries deduped, failures swallowed', () => {
    const env = fixture();
    env.put(2, { id: 'a' });
    const meta = { rating: 1.5, state_before: 2, hints: 2, keywords: 5, duration_ms: 8123 };
    assert.equal(env.api.updateCard('a', fsrsFor()).ok, true);   // no meta -> no log
    assert.equal(env.sheets.get('review_log'), undefined);
    env.api.updateCard('a', fsrsFor(), meta);
    env.api.updateCard('a', fsrsFor(), meta);                    // retry of the same review
    const log = env.sheets.get('review_log');
    assert.equal(log.getLastRow(), 2);
    const row = log.getRange(2, 1, 1, 11).getValues()[0];
    assert.deepEqual(row, ['2026-11-06T09:00:00.000Z', 'a', 1.5, 2, 3, 9, 12.5, 6.2, 2, 5, 8123]);
    env.api.updateCard('a', fsrsFor({ last_review: '2026-11-07T09:00:00.000Z' }), meta);
    assert.equal(log.getLastRow(), 3);
    env.stats.failAppend = true;
    const later = fsrsFor({ last_review: '2026-11-08T09:00:00.000Z' });
    const res = env.api.updateCard('a', later, meta);
    assert.equal(res.ok, true);
  });

  test('bootstrap == { getStats(), getDueCards() } from one read', () => {
    const env = fixture();
    const now = Date.now();
    env.put(2, { id: 'new1', state: 0 });
    env.put(3, { id: 'late', state: 2, due: new Date(now - 3 * 86400000) });
    env.put(4, { id: 'soon', state: 2, due: iso(now + 5 * 86400000) });
    env.put(5, { id: 'less', state: 3, due: iso(now - 3600000) });
    env.put(6, { state: 2, due: iso(now - 1000) });              // no id: ignored
    env.put(7, { id: 'new2', state: '' });
    const b = env.api.bootstrap();
    assert.deepEqual(JSON.parse(JSON.stringify(b.stats)), { total: 5, due: 4, new: 2, review: 2 });
    assert.deepEqual(b.cards.map((c) => c.id), ['late', 'less', 'new1', 'new2']);
    assert.equal(typeof b.cards[0].due, 'string');               // Date -> ISO
    const plain = (x) => JSON.parse(JSON.stringify(x));
    assert.deepEqual(plain(env.api.getStats()), plain(b.stats));
    assert.deepEqual(env.api.getDueCards(), b.cards);
    env.stats.calls = {};
    env.api.bootstrap();
    assert.equal(env.stats.calls.getValues, 1, 'single sheet read');
  });

  test('empty sheet', () => {
    const env = fixture();
    const b = env.api.bootstrap();
    const zero = { total: 0, due: 0, new: 0, review: 0 };
    assert.deepEqual(JSON.parse(JSON.stringify(b)), { stats: zero, cards: [] });
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
