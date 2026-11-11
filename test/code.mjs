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
  // Apps Script shares one global scope across files
  const root = path.dirname(file);
  const code = ['Version.gs', 'Config.gs', 'Highlight.gs', 'Preview.gs']
    .map((f) => path.join(root, f))
    .concat(file).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
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
      this.rich = new Map();       // rich text values written with setRichTextValues
      this.heights = new Map();
      this.active = { r: 2, c: 1 };
      this.maxRows = 1000;
    }
    getName() {
      return this.name;
    }
    setRowHeight(r, h) {
      this.heights.set(r, h);
    }
    clear() {
      this.cells.clear();
      this.rich.clear();
    }
    getActiveRange() {
      return new Range(this, this.active.r, this.active.c, 1, 1);
    }
    key(r, c) {
      return `${r},${c}`;
    }
    put(r, c, v) {
      const stored = this.fmt.get(this.key(r, c)) === '@' ? v : convert(v);
      this.cells.set(this.key(r, c), stored);
      this.rich.delete(this.key(r, c));          // a plain write drops the styling
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
    deleteRow(row) {
      bump('deleteRow');
      const last = this.getLastRow();
      for (let r = row; r <= last; r++) {
        for (let c = 1; c <= this.getLastColumn(); c++) {
          this.cells.set(this.key(r, c), this.get(r + 1, c));
        }
      }
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
    getSheet() { return this.sheet; }
    getRow() { return this.r; }
    getColumn() { return this.c; }
    getNumRows() { return this.nr; }
    getNumColumns() { return this.nc; }
    getFormulas() {
      bump('getFormulas');
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = this.sheet.get(this.r + i, this.c + j);
          row.push(v && v.formula ? v.formula : '');
        }
        out.push(row);
      }
      return out;
    }
    setFormulas(vals) {
      bump('setFormulas');
      vals.forEach((row, i) => row.forEach((f, j) => {
        const key = this.sheet.key(this.r + i, this.c + j);
        this.sheet.cells.set(key, f === '' ? '' : { formula: f });
      }));
      return this;
    }
    setFormula(f) {
      return this.setFormulas([[f]]);
    }
    setRichTextValues(vals) {
      bump('setRichTextValues');
      vals.forEach((row, i) => row.forEach((v, j) => {
        this.sheet.put(this.r + i, this.c + j, v.text);
        this.sheet.rich.set(this.sheet.key(this.r + i, this.c + j), v);
      }));
      return this;
    }
    getRichTextValue() {
      const key = this.sheet.key(this.r, this.c);
      return this.sheet.rich.get(key) || richValue('' + this.sheet.get(this.r, this.c), []);
    }
    setBackground() { return this; }
    setFontColor() { return this; }
    setFontWeight() { return this; }
  }

  // Rich text model: { text, runs: [{ s, e, style }] }; getRuns() lists the styled runs
  const richValue = (text, runs) => ({
    text, runs,
    getRuns: () => runs.map((r) => ({
      getText: () => text.slice(r.s, r.e),
      getTextStyle: () => ({ getForegroundColor: () => r.style.color || null }),
    })),
  });
  const richBuilder = () => {
    let text = '';
    const runs = [];
    const b = {
      setText(t) { text = t; return b; },
      setTextStyle(s, e, style) { runs.push({ s, e, style }); return b; },
      build: () => richValue(text, runs.slice()),
    };
    return b;
  };
  const styleBuilder = () => {
    const st = {};
    const b = {
      setForegroundColor(c) { st.color = c; return b; },
      setBold(v) { st.bold = v; return b; },
      setItalic(v) { st.italic = v; return b; },
      build: () => ({ ...st }),
    };
    return b;
  };

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
  const menu = { items: [], opened: [] };
  const ctx = vm.createContext({
    Date,
    console: { log: console.log, error() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => Object.assign(ss, { toast: (m) => (menu.toast = m) }),
      getActiveSheet: () => ctx.__active || null,
      newRichTextValue: richBuilder,
      newTextStyle: styleBuilder,
      flush: () => bump('flush'),
      getUi: () => ({
        alert() {},
        createMenu(name) {
          const m = {
            addItem(label, fn) { menu.items.push([name, label, fn]); return m; },
            addSeparator() { return m; },
            addToUi() {},
          };
          return m;
        },
        showSidebar: (page) => menu.opened.push(['sidebar', page]),
        showModelessDialog: (page, title) => menu.opened.push(['window', page, title]),
      }),
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
      Charset: { UTF_8: 'utf8' },
      base64Encode: (s, cs) => Buffer.from(s, cs).toString('base64'),
    },
    HtmlService: {
      createHtmlOutputFromFile: (n) => ({
        getContent: () => fs.readFileSync(path.join(root, n + '.html'), 'utf8'),
      }),
      createTemplateFromFile: (n) => {
        const page = {
          name: n,
          setTitle(t) { page.title = t; return page; },
          setWidth(w) { page.width = w; return page; },
          setHeight(h) { page.height = h; return page; },
        };
        return { evaluate: () => page };
      },
    },
    ScriptApp: { getService: () => ({ getUrl: () => ctx.__url }) },
  });
  const api = vm.runInContext(
    `${code}\n({ getDueCards, getStats, updateCard, setupSheet, getDocsUrl, HEADERS, DEFAULTS,` +
    ` saveSettings, getVersion, APP_VERSION, getReviewLog, getWeightsHistory,` +
    ` onEdit, onOpen, highlightAll, addThumbnailColumn, checkSheetTools,` +
    ` tokenize_, sniffType_, thumbFormula_, appShell_, getActiveRowPreview,` +
    ` showPreviewSidebar, showPreviewWindow, HL_STYLES, THUMB_HEADER,` +
    ` bootstrap: typeof bootstrap === 'function' ? bootstrap : null })`, ctx);
  return { api, ss, sheets, stats, Sheet, ctx, menu };
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

  test('undo restores the fields and removes exactly that review from the log', () => {
    const env = fixture();
    env.put(2, { id: 'a', due: '2026-11-06T04:00:00.000Z', stability: 5, reps: 3, state: 2,
                 last_review: '2026-11-05T09:00:00.000Z' });
    env.put(3, { id: 'b' });
    const meta = { rating: 3, state_before: 2, hints: 0, keywords: 2, duration_ms: 1 };
    env.api.updateCard('b', fsrsFor({ last_review: '2026-11-06T08:00:00.000Z' }), meta);
    const first = fsrsFor({ last_review: '2026-11-06T09:00:00.000Z', reps: 4, stability: 9 });
    env.api.updateCard('a', first, meta);
    env.api.updateCard('a', fsrsFor({ last_review: '2026-11-06T09:05:00.000Z' }), meta);
    const log = env.sheets.get('review_log');
    assert.equal(log.getLastRow(), 4);
    const prev = { stability: 5, reps: 3, state: 2, due: '2026-11-06T04:00:00.000Z',
                   last_review: '2026-11-05T09:00:00.000Z', difficulty: '', weak_keywords: '' };
    const undo = { undo: true, undone_time: '2026-11-06T09:05:00.000Z' };
    assert.equal(env.api.updateCard('a', prev, undo).ok, true);
    // a retried undo finds nothing more to delete
    assert.equal(env.api.updateCard('a', prev, undo).ok, true);
    assert.equal(log.getLastRow(), 3);
    const rows = log.getRange(2, 1, 2, 2).getValues();
    assert.deepEqual(rows, [
      ['2026-11-06T08:00:00.000Z', 'b'],
      ['2026-11-06T09:00:00.000Z', 'a'],
    ]);
    const col = (h) => env.headers.indexOf(h) + 1;
    assert.equal(env.sheet.get(2, col('stability')), 5);
    assert.equal(env.sheet.get(2, col('last_review')), '2026-11-05T09:00:00.000Z');
    assert.equal(env.sheet.get(2, col('difficulty')), '');
    assert.equal(log.getLastRow(), 3, 'undo must not add a log row');
  });

  test('stale save: a later stored review wins; nothing is written or logged', () => {
    const env = fixture();
    env.put(2, { id: 'a', reps: 5, stability: 20, last_review: '2026-11-07T09:00:00.000Z' });
    const col = (h) => env.headers.indexOf(h) + 1;
    const meta = { rating: 3, state_before: 2, hints: 0, keywords: 1, duration_ms: 1 };
    const older = fsrsFor({ last_review: '2026-11-06T09:00:00.000Z' });
    assert.deepEqual({ ...env.api.updateCard('a', older, meta) }, { ok: true, stale: true });
    assert.equal(env.sheet.get(2, col('reps')), 5);
    assert.equal(env.sheet.get(2, col('stability')), 20);
    assert.equal(env.sheet.get(2, col('last_review')), '2026-11-07T09:00:00.000Z');
    assert.equal(env.sheets.get('review_log'), undefined, 'a skipped save must not log');
    // equal timestamp (a retry of the stored review) and a later review are applied
    const retry = fsrsFor({ last_review: '2026-11-07T09:00:00.000Z' });
    assert.equal(env.api.updateCard('a', retry).stale, undefined);
    const later = fsrsFor({ last_review: '2026-11-08T09:00:00.000Z', reps: 6 });
    assert.equal(env.api.updateCard('a', later, meta).stale, undefined);
    assert.equal(env.sheet.get(2, col('reps')), 6);
    assert.equal(env.sheets.get('review_log').getLastRow(), 2);
  });

  test('stale guard needs a known timestamp (blank, Date, junk, no last_review)', () => {
    const env = fixture();
    const col = (h) => env.headers.indexOf(h) + 1;
    env.put(2, { id: 'blank' });
    env.put(3, { id: 'date', last_review: new Date('2026-12-01T00:00:00Z') });
    env.put(4, { id: 'junk', last_review: 'n/a' });
    env.put(5, { id: 'iso', last_review: '2026-12-01T00:00:00.000Z' });
    for (const id of ['blank', 'date', 'junk']) {
      assert.equal(env.api.updateCard(id, fsrsFor()).stale, undefined, id);
    }
    assert.equal(env.sheet.get(3, col('last_review')), '2026-11-06T09:00:00.000Z');
    const noReview = fsrsFor();
    delete noReview.last_review;                       // partial write, not a review
    assert.equal(env.api.updateCard('iso', noReview).stale, undefined);
    assert.equal(env.sheet.get(5, col('reps')), 4);
  });

  test('undo applies only while the undone review is still the latest', () => {
    const env = fixture();
    const col = (h) => env.headers.indexOf(h) + 1;
    const prev = { stability: 5, reps: 3, state: 2, last_review: '2026-11-05T09:00:00.000Z' };
    const meta = { rating: 3, state_before: 2, hints: 0, keywords: 1, duration_ms: 1 };
    env.put(2, { id: 'a', ...prev });
    env.api.updateCard('a', fsrsFor({ last_review: '2026-11-06T09:00:00.000Z' }), meta);
    // another device reviews the card later; the late undo of the first review is skipped
    env.api.updateCard('a', fsrsFor({ last_review: '2026-11-06T10:00:00.000Z', reps: 5 }), meta);
    const late = { undo: true, undone_time: '2026-11-06T09:00:00.000Z' };
    assert.deepEqual({ ...env.api.updateCard('a', prev, late) }, { ok: true, stale: true });
    assert.equal(env.sheet.get(2, col('reps')), 5);
    assert.equal(env.sheets.get('review_log').getLastRow(), 3, 'log row kept');
    // undo of the latest review is applied
    const now = { undo: true, undone_time: '2026-11-06T10:00:00.000Z' };
    const res = env.api.updateCard('a', fsrsFor({ ...prev, reps: 4 }), now);
    assert.deepEqual({ ...res }, { ok: true });
    assert.equal(env.sheet.get(2, col('reps')), 4);
    assert.equal(env.sheets.get('review_log').getLastRow(), 2);
  });

  // ── config: DEFAULTS + settings tab ──────────────────────────────────────
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const withSettings = (rows) => {
    const env = fixture();
    const st = env.ss.insertSheet('settings');
    ['key', 'value', 'updated', 'source'].forEach((h, i) => st.raw(1, i + 1, h));
    rows.forEach((r, i) => r.forEach((v, j) => st.raw(i + 2, j + 1, v)));
    return env;
  };
  const w21 = (x) => plain(loadCodeGs().api.DEFAULTS.w).map((v) => (x === undefined ? v : x));

  test('no settings tab: bootstrap sends the defaults and creates nothing', () => {
    const env = fixture();
    const { config } = plain(env.api.bootstrap());
    assert.deepEqual(config, { ...plain(env.api.DEFAULTS), overridden: [], rejected: [] });
    assert.equal(env.sheets.get('settings'), undefined);
  });

  test('settings rows override key by key (JSON text or number, blank = default)', () => {
    const w = plain(loadCodeGs().api.DEFAULTS.w);
    w[0] = 0.5;
    const env = withSettings([
      ['retention', '0.9', '', ''],
      ['max_interval', 720, '', ''],               // a cell Sheets turned into a number
      ['w', JSON.stringify(w), '', ''],
      ['retention', '0.92', '', ''],               // last row of a key wins
    ]);
    const { config } = plain(env.api.bootstrap());
    assert.equal(config.retention, 0.92);
    assert.equal(config.max_interval, 720);
    assert.deepEqual(config.w, w);
    assert.deepEqual(config.overridden.sort(), ['max_interval', 'retention', 'w']);
    assert.deepEqual(config.rejected, []);
    const blank = withSettings([['retention', '', '', ''], ['w', '  ', '', '']]);
    const b = plain(blank.api.bootstrap()).config;
    assert.deepEqual(b.overridden, []);
    assert.equal(b.retention, 0.94);
  });

  test('invalid overrides are ignored and reported, the rest still applies', () => {
    const w = plain(loadCodeGs().api.DEFAULTS.w);
    const env = withSettings([
      ['retention', '0.5', '', ''],                // below 0.80
      ['max_interval', '12.5', '', ''],            // not whole
      ['w', JSON.stringify(w.slice(1)), '', ''],   // 18 values
      ['typo_key', '1', '', ''],
      ['x', '{oops', '', ''],
    ]);
    const { config } = plain(env.api.bootstrap());
    const keys = config.rejected.map((r) => r.key);
    assert.deepEqual(keys, ['retention', 'max_interval', 'w', 'typo_key', 'x']);
    assert.equal(config.rejected[2].reason, 'expected 21 values');
    assert.equal(config.rejected[4].reason, 'not valid JSON');
    assert.deepEqual(config.overridden, []);
    assert.equal(config.retention, 0.94);
    const hi = plain(w);
    hi[7] = 0.9;                                   // above the optimizer's clip 0.75
    const out = withSettings([['w', JSON.stringify(hi), '', ''], ['retention', '0.9', '', '']]);
    const c = plain(out.api.bootstrap()).config;
    assert.match(c.rejected[0].reason, /^w\[7\] outside/);
    assert.equal(c.retention, 0.9);
  });

  test('saveSettings: validates first, upserts, clears, records w in weights_history', () => {
    const env = fixture();
    const bad = env.api.saveSettings({ retention: 0.99, max_interval: 90 });
    const errors = { retention: 'expected a number in 0.8–0.97' };
    assert.deepEqual(plain(bad), { ok: false, errors });
    assert.equal(env.sheets.get('settings'), undefined, 'nothing written on an error');
    assert.equal(env.api.saveSettings({}).ok, false);
    assert.equal(env.api.saveSettings({ nope: null }).errors.nope, 'unknown key');

    const ok = env.api.saveSettings({ retention: 0.9, max_interval: 90 }, { source: 'dialog' });
    assert.equal(ok.ok, true);
    assert.equal(ok.config.retention, 0.9);
    const st = env.sheets.get('settings');
    assert.deepEqual(st.getRange(2, 1, 2, 2).getValues(),
      [['retention', '0.9'], ['max_interval', '90']]);
    assert.equal(st.get(2, 4), 'dialog');
    assert.equal(env.sheets.get('weights_history'), undefined, 'no w, no history');

    env.api.saveSettings({ retention: 0.92 });     // upsert, no second row
    assert.equal(st.getLastRow(), 3);
    assert.equal(st.get(2, 2), '0.92');
    const w = plain(env.api.DEFAULTS.w);
    w[2] = 3.5;
    const meta = { source: 'optimizer', n_reviews: 1200, loss_before: 0.41,
                   loss_after: 0.37, note: 'run 1' };
    assert.deepEqual(plain(env.api.saveSettings({ w }, meta).config.w), w);
    const hist = env.sheets.get('weights_history');
    assert.deepEqual(hist.getRange(2, 2, 1, 6).getValues()[0],
      [1200, JSON.stringify(w), 0.41, 0.37, 'optimizer', 'run 1']);
    assert.equal(typeof hist.get(2, 1), 'string', 'time stays text');

    env.api.saveSettings({ w: null, retention: null });   // back to defaults
    const c = plain(env.api.bootstrap()).config;
    assert.deepEqual(c.overridden, ['max_interval']);     // still 90
    assert.equal(c.retention, 0.94);
    assert.equal(hist.getLastRow(), 3);
    assert.equal(hist.get(3, 7), 'back to defaults');
    assert.equal(hist.get(3, 3), '');
  });

  test('setupSheet creates the settings tab with its headers', () => {
    const env = loadCodeGs();
    env.api.setupSheet();
    const st = env.sheets.get('settings');
    assert.deepEqual(st.getRange(1, 1, 1, 4).getValues()[0],
      ['key', 'value', 'updated', 'source']);
    assert.equal(st.fmt.get('2,2'), '@');
  });

  // ── sheet tools: highlight, sniffing, thumbnails, preview ────────────────
  const toolSheet = (rows, { thumb = false } = {}) => {
    const env = fixture();
    if (thumb) {
      env.sheet.raw(1, 17, 'back_thumb');
    }
    rows.forEach((r, i) => env.put(i + 2, r));
    return env;
  };
  const edit = (env, r, c, nr = 1, nc = 1) =>
    env.api.onEdit({ range: env.sheet.getRange(r, c, nr, nc) });
  // [[styled text, color | 'bold' | 'italic'], ...] of a cell, or null when never styled
  const runs = (env, r, c = 4) => {
    const v = env.sheet.rich.get(`${r},${c}`);
    return v && v.runs.map((x) => [v.text.slice(x.s, x.e),
      x.style.color || (x.style.bold ? 'bold' : 'italic')]);
  };
  const svgDoc = '<svg viewBox="0 0 10 10"><circle r="4"/></svg>';
  const b64Of = (formula) =>
    Buffer.from(formula.slice(formula.indexOf('base64,') + 7, -2), 'base64').toString();

  test('onEdit styles back_content, fills a blank back_type, keeps a set one', () => {
    const env = toolSheet([
      { id: 'a', back_content: '<b class="x">hi</b>', back_type: '' },
      { id: 'b', back_content: '# T', back_type: 'text' },
    ]);
    edit(env, 2, 4, 2);
    const c = (cls) => env.api.HL_STYLES[cls].color;
    assert.deepEqual(runs(env, 2), [['<b', c('tag')], ['class', c('attr')], ['"x"', c('string')],
      ['>', c('tag')], ['</b', c('tag')], ['>', c('tag')]]);
    assert.equal(env.sheet.get(2, 5), 'html');
    assert.equal(env.sheet.get(3, 5), 'text');
    assert.deepEqual(runs(env, 3), []);
    assert.equal(env.stats.calls.setRichTextValues, 1, 'one write for consecutive rows');
  });

  test('edits elsewhere are ignored: other columns, header row, other sheets, no range', () => {
    const env = toolSheet([{ id: 'a', back_content: '<b>x</b>', back_type: 'html' }]);
    edit(env, 2, 1);
    edit(env, 1, 4);
    const other = env.ss.insertSheet('other');
    other.raw(1, 1, '<b>');
    env.api.onEdit({ range: other.getRange(1, 1, 1, 1) });
    env.api.onEdit({});
    assert.equal(env.stats.calls.setRichTextValues, undefined);
  });

  test('formulas, numbers and blank cells are left alone', () => {
    const env = toolSheet([
      { id: 'a' }, { id: 'b', back_content: '<b>x</b>', back_type: 'html' },
      { id: 'c' }, { id: 'd', back_content: 7 },
    ]);
    env.sheet.cells.set('2,4', { formula: '=B2' });
    edit(env, 2, 4, 4);
    assert.deepEqual(env.sheet.get(2, 4), { formula: '=B2' });
    assert.equal(runs(env, 3).length, 4);
    assert.equal(env.sheet.get(5, 4), 7);
    assert.equal(env.sheet.get(5, 5), '');
    assert.equal(env.stats.calls.setRichTextValues, 1);
  });

  test('editing back_type restyles the row; clearing it sniffs again', () => {
    const env = toolSheet([{ id: 'a', back_content: '**x** <b>y</b>', back_type: 'md' }]);
    edit(env, 2, 4);
    assert.deepEqual(runs(env, 2).map((r) => r[0]), ['**x**', '<b', '>', '</b', '>']);
    env.sheet.put(2, 5, 'text');
    edit(env, 2, 5);
    assert.deepEqual(runs(env, 2), []);
    env.sheet.put(2, 5, '');
    edit(env, 2, 5);
    assert.equal(env.sheet.get(2, 5), 'html');
    assert.equal(runs(env, 2).length, 4, 'now styled as html');
  });

  test('thumbnails: svg rows get an IMAGE data URI, others none, only with the column', () => {
    const env = toolSheet([
      { id: 'a', back_content: svgDoc, back_type: 'svg' },
      { id: 'b', back_content: '<b>x</b>', back_type: 'html' },
    ], { thumb: true });
    edit(env, 2, 4, 2);
    const f = env.sheet.get(2, 17).formula;
    assert.match(f, /^=IMAGE\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\)$/);
    assert.equal(b64Of(f), svgDoc.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.equal(env.sheet.get(3, 17), '');
    assert.equal(env.sheet.heights.get(2), 72);
    env.sheet.put(2, 5, 'html');                      // no longer an svg: thumbnail goes
    edit(env, 2, 5);
    assert.equal(env.sheet.get(2, 17), '');
    const none = toolSheet([{ id: 'a', back_content: svgDoc, back_type: 'svg' }]);
    edit(none, 2, 4);
    assert.equal(none.stats.calls.setFormulas, undefined, 'no column, no thumbnails');
  });

  test('thumbFormula_: non-svg, existing xmlns, size limit, UTF-8', () => {
    const t = loadCodeGs().api.thumbFormula_;
    assert.equal(t('<b>x</b>'), '');
    assert.equal(t(''), '');
    const kept = b64Of(t('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    assert.equal(kept.match(/xmlns/g).length, 1);
    assert.equal(t('<svg>' + 'x'.repeat(40000) + '</svg>'), '', 'over 45 000 characters');
    assert.equal(b64Of(t('<svg><text>桜😀</text></svg>')).includes('桜😀'), true);
  });

  test('one edit restyles at most 500 rows; Highlight all covers the rest in chunks', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      ({ id: 'c' + i, back_content: '<b>x</b>', back_type: 'html' }));
    const env = toolSheet(rows);
    edit(env, 2, 4, 600);
    assert.ok(env.sheet.rich.get('501,4'));
    assert.equal(env.sheet.rich.get('502,4'), undefined);
    assert.equal(env.stats.calls.setRichTextValues, 1);
    const total = plain(env.api.highlightAll());
    assert.deepEqual(total, { styled: 600, typed: 0, thumbs: 0 });
    assert.equal(env.stats.calls.setRichTextValues, 3, 'two chunks of 300');
    assert.ok(env.sheet.rich.get('601,4'));
    assert.match(env.menu.toast, /^600 cells styled, 0 back_type filled$/);
  });

  test('typing a pasted block fills blank types in one write', () => {
    const rows = [{ id: 'a', back_content: '# h' }, { id: 'b', back_content: '<p>x</p>' },
      { id: 'c', back_content: 'plain' }, { id: 'd', back_content: svgDoc }];
    const env = toolSheet(rows);
    edit(env, 2, 4, 4);
    assert.deepEqual([2, 3, 4, 5].map((r) => env.sheet.get(r, 5)), ['md', 'html', 'text', 'svg']);
    assert.equal(env.stats.calls.setValues, 1);
  });

  test('addThumbnailColumn adds the header once after the last column and fills it', () => {
    const env = toolSheet([{ id: 'a', back_content: svgDoc, back_type: 'svg' }]);
    const total = plain(env.api.addThumbnailColumn());
    assert.equal(env.sheet.get(1, 17), 'back_thumb');
    assert.equal(total.thumbs, 1);
    assert.match(env.sheet.get(2, 17).formula, /^=IMAGE\(/);
    env.api.addThumbnailColumn();
    assert.equal(env.sheet.get(1, 18), '', 'no second column');
  });

  test('the app never receives back_thumb', () => {
    const env = toolSheet([{ id: 'a', back_content: svgDoc, back_type: 'svg' }], { thumb: true });
    edit(env, 2, 4);
    const card = plain(env.api.bootstrap()).cards[0];
    assert.equal(card.id, 'a');
    assert.equal('back_thumb' in card, false);
    assert.equal(card.back_content, svgDoc);
  });

  test('Flash menu: every item points at a function that exists', () => {
    const env = loadCodeGs();
    env.api.onOpen();
    assert.deepEqual(env.menu.items.map((i) => i[0]), Array(5).fill('Flash'));
    for (const [, , fn] of env.menu.items) {
      assert.equal(vm.runInContext('typeof ' + fn, env.ctx), 'function', fn);
    }
  });

  test('getActiveRowPreview: notes off the cards sheet or on the header, else the row', () => {
    const env = toolSheet([
      { id: 'a', title: 'T', back_content: '<b>x</b>', back_type: ' HTML ' },
      { id: 'b', back_content: 'plain', back_type: '' },
    ]);
    env.ctx.__active = env.sheet;
    env.sheet.active = { r: 2, c: 1 };
    assert.deepEqual(plain(env.api.getActiveRowPreview()),
      { row: 2, id: 'a', title: 'T', type: 'html', content: '<b>x</b>' });
    env.sheet.active = { r: 3, c: 4 };
    assert.equal(env.api.getActiveRowPreview().type, 'text', 'blank type: text, like the app');
    env.sheet.active = { r: 1, c: 1 };
    assert.match(env.api.getActiveRowPreview().note, /below the header/);
    env.ctx.__active = env.ss.insertSheet('other');
    assert.match(env.api.getActiveRowPreview().note, /"cards" sheet/);
  });

  test('appShell_ takes css, pinned scripts and the render block from index.html', () => {
    const shell = loadCodeGs().api.appShell_();
    assert.match(shell.css, /\.back-content\s*\{/);
    assert.equal((shell.scripts.match(/<script/g) || []).length, 2);
    assert.match(shell.scripts, /marked@\d+\.\d+\.\d+\/lib\/marked\.umd\.js/);
    assert.match(shell.scripts, /dompurify@\d+\.\d+\.\d+\/dist\/purify\.min\.js/);
    assert.match(shell.render, /function renderHtml\(content, type\)/);
    assert.equal(shell.render.includes('@render-begin'), false);
  });

  test('preview opens as sidebar or as a 640 px window, titled "Card preview"', () => {
    const env = loadCodeGs();
    env.api.showPreviewSidebar();
    env.api.showPreviewWindow();
    const [side, win] = env.menu.opened;
    assert.equal(side[0], 'sidebar');
    assert.equal(side[1].title, 'Card preview');
    assert.equal(side[1].name, 'Sidebar');
    assert.deepEqual([win[0], win[1].width, win[1].height, win[2]],
      ['window', 640, 560, 'Card preview']);
  });

  test('checkSheetTools writes _flash_check and finds no offset mismatch in the model', () => {
    const env = loadCodeGs();
    assert.deepEqual(plain(env.api.checkSheetTools()), { offsetMismatches: 0 });
    const sheet = env.sheets.get('_flash_check');
    assert.match(sheet.get(1, 2), /^ok:/);
    assert.match(sheet.get(2, 1).formula, /^=IMAGE\("data:image\/svg\+xml;base64,/);
    env.api.checkSheetTools();                        // can be run again
    assert.match(sheet.get(1, 2), /^ok:/);
  });

  test('getVersion reports the stamped version and the web app URL', () => {
    const env = loadCodeGs();
    env.ctx.__url = 'https://script.google.com/macros/s/ID/exec';
    const stamped = fs.readFileSync(path.join(here, '..', 'Version.gs'), 'utf8')
      .match(/APP_VERSION = '([^']*)'/)[1];
    assert.deepEqual(plain(env.api.getVersion()),
      { version: stamped, url: 'https://script.google.com/macros/s/ID/exec' });
    assert.equal(env.api.APP_VERSION, stamped);
  });

  test('getReviewLog returns what the app logged; empty before the first review', () => {
    const env = fixture();
    assert.deepEqual(plain(env.api.getReviewLog()).rows, []);
    env.put(2, { id: 'a', reps: 1 });
    const meta = { rating: 3, state_before: 2, hints: 1, keywords: 3, duration_ms: 900 };
    env.api.updateCard('a', fsrsFor({ last_review: '2026-11-07T09:00:00.000Z' }), meta);
    const log = plain(env.api.getReviewLog());
    assert.equal(log.columns[0], 'review_time');
    assert.equal(log.rows.length, 1);
    const row = Object.fromEntries(log.columns.map((c, i) => [c, log.rows[0][i]]));
    assert.equal(row.card_id, 'a');
    assert.equal(row.rating, 3);
    assert.equal(row.state_before, 2);
    assert.equal(row.review_time, '2026-11-07T09:00:00.000Z');
    assert.equal(row.duration_ms, 900);
  });

  test('getWeightsHistory: newest first, at most 10, w parsed, null after a reset', () => {
    const env = fixture();
    assert.deepEqual(plain(env.api.getWeightsHistory()), []);
    const w = plain(env.api.DEFAULTS.w);
    for (let i = 0; i < 12; i++) {
      const v = w.slice();
      v[2] = 2 + i / 100;
      env.api.saveSettings({ w: v }, { source: 'optimizer', n_reviews: 100 + i,
        loss_before: 0.4, loss_after: 0.35, note: 'run ' + i });
    }
    env.api.saveSettings({ w: null }, { source: 'app' });
    const hist = plain(env.api.getWeightsHistory());
    assert.equal(hist.length, 10);
    assert.equal(hist[0].w, null);
    assert.equal(hist[0].note, 'back to defaults');
    assert.equal(hist[1].note, 'run 11');
    assert.equal(hist[1].w[2], 2.11);
    assert.equal(hist[1].n_reviews, 111);
    assert.equal(hist[1].loss_after, 0.35);
    assert.equal(hist[1].source, 'optimizer');
    assert.equal(hist[9].note, 'run 3');
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

  test('docs URL appends ?page=docs to the /exec and /dev URLs', () => {
    const env = loadCodeGs();
    for (const base of ['https://script.google.com/macros/s/ID/exec',
                        'https://script.google.com/macros/s/ID/dev']) {
      env.ctx.__url = base;
      assert.equal(env.api.getDocsUrl(), base + '?page=docs');
    }
  });

  test('empty sheet', () => {
    const env = fixture();
    const b = env.api.bootstrap();
    const zero = { total: 0, due: 0, new: 0, review: 0 };
    const { config, ...rest } = JSON.parse(JSON.stringify(b));
    assert.deepEqual(rest, { stats: zero, cards: [] });
    assert.equal(config.retention, 0.94);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
