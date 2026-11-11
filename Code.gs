// ─── Config ────────────────────────────────────────────────────────────────

const SHEET_NAME = 'cards';
const LOG_SHEET_NAME = 'review_log';
const SETTINGS_SHEET_NAME = 'settings';     // personal overrides of DEFAULTS (Config.gs)
const WEIGHTS_SHEET_NAME = 'weights_history';
// Optional column of SVG thumbnails (Highlight.gs); never sent to the app
const THUMB_HEADER = 'back_thumb';
const HEADERS = [
  'id', 'title', 'keywords', 'back_content', 'back_type',
  'due', 'stability', 'difficulty', 'elapsed_days',
  'scheduled_days', 'reps', 'lapses', 'state', 'last_review',
  'weak_keywords', 'miss_streak'
];
// Columns the app writes on every review
const FSRS_FIELDS = [
  'stability', 'difficulty', 'elapsed_days', 'scheduled_days',
  'reps', 'lapses', 'state', 'last_review', 'due',
  'weak_keywords', 'miss_streak'
];
// Kept as plain text so Sheets never converts "3/4", "1.5", "=x" or ISO dates
const TEXT_COLUMNS = [
  'id', 'title', 'keywords', 'back_content', 'back_type',
  'due', 'last_review', 'weak_keywords'
];
// One row per review; the input for an FSRS optimizer. rating 1.5 = Recap
// (map it to Hard = 2 before optimizing).
const LOG_HEADERS = [
  'review_time', 'card_id', 'rating', 'state_before', 'elapsed_days',
  'scheduled_days', 'stability', 'difficulty', 'hints', 'keywords', 'duration_ms'
];
// One row per override; a blank value means "use the default".
const SETTINGS_HEADERS = ['key', 'value', 'updated', 'source'];
// Append-only record of every change of the weights (rollback = a new row).
const WEIGHTS_HEADERS = [
  'time', 'n_reviews', 'w', 'loss_before', 'loss_after', 'source', 'note'
];

// ─── Entry Point ───────────────────────────────────────────────────────────

function doGet(e) {
  const page = e?.parameter?.page;
  if (page === 'docs') {
    return HtmlService.createHtmlOutputFromFile('docs')
      .setTitle('⚡ Flash — Documentation')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('⚡ Flash')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

function getDocsUrl() {
  return getAppUrl() + '?page=docs';   // works for /exec and /dev
}

// The deployed version (Version.gs); the app reloads itself when it differs from its own.
function getVersion() {
  return { version: APP_VERSION, url: getAppUrl() };
}

function getDocsHtml() {
  return HtmlService.createHtmlOutputFromFile('docs').getContent();
}


// ─── Sheet Helpers ─────────────────────────────────────────────────────────

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    const hRange = sheet.getRange(1, 1, 1, HEADERS.length);
    hRange.setValues([HEADERS]);
    hRange.setBackground('#7C3AFF').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(HEADERS.indexOf('back_content') + 1, 300);
    applyTextFormat_(sheet, 2);
  }
  return sheet;
}

function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    const hRange = sheet.getRange(1, 1, 1, LOG_HEADERS.length);
    hRange.setValues([LOG_HEADERS]);
    hRange.setBackground('#7C3AFF').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:B').setNumberFormat('@');   // review_time (ISO) and card_id
  }
  return sheet;
}

function getSettingsSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet && create) {
    sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    const hRange = sheet.getRange(1, 1, 1, SETTINGS_HEADERS.length);
    hRange.setValues([SETTINGS_HEADERS]);
    hRange.setBackground('#7C3AFF').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:D').setNumberFormat('@');   // JSON values and ISO times stay text
  }
  return sheet;
}

function getWeightsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WEIGHTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(WEIGHTS_SHEET_NAME);
    const hRange = sheet.getRange(1, 1, 1, WEIGHTS_HEADERS.length);
    hRange.setValues([WEIGHTS_HEADERS]);
    hRange.setBackground('#7C3AFF').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('C:C').setNumberFormat('@');
  }
  return sheet;
}

function readHeaders_(sheet) {
  const cols = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, cols).getValues()[0].map(String);
}

function colToA1_(col) {
  let n = col;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Plain-text format for TEXT_COLUMNS from firstRow down. Existing cells above
// firstRow are left alone: converting them would not restore what Sheets
// already parsed into dates or numbers.
function applyTextFormat_(sheet, firstRow) {
  const rows = sheet.getMaxRows() - firstRow + 1;
  if (rows < 1) return;
  const headers = readHeaders_(sheet);
  const ranges = TEXT_COLUMNS
    .map(name => headers.indexOf(name) + 1)
    .filter(col => col > 0)
    .map(col => colToA1_(col) + firstRow + ':' + colToA1_(col) + (firstRow + rows - 1));
  if (ranges.length) sheet.getRangeList(ranges).setNumberFormat('@');
}

// Returns the header row; appends any missing columns (under a lock, so two
// concurrent calls cannot add the same column twice).
function ensureColumns_(sheet, names) {
  let headers = readHeaders_(sheet);
  if (names.every(n => headers.indexOf(n) !== -1)) return headers;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    headers = readHeaders_(sheet);   // another call may have added them meanwhile
    const missing = names.filter(n => headers.indexOf(n) === -1);
    if (missing.length) {
      sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
      headers = headers.concat(missing);
    }
  } finally {
    lock.releaseLock();
  }
  return headers;
}

// ─── API: getDueCards ──────────────────────────────────────────────────────
// Returns all cards with due <= today (or no due date = new card)

function cleanCardDates(card) {
  const cleaned = {};
  for (const [key, value] of Object.entries(card)) {
    if (value instanceof Date) {
      // Convert Date to ISO string
      cleaned[key] = value.toISOString();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively clean nested objects
      cleaned[key] = cleanCardDates(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// One read of the sheet -> card objects (cells may be Date or string).
function readCards_() {
  const data = getSheet_().getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row[0]) // must have id
    .map(row => {
      const c = {};
      headers.forEach((h, i) => {
        if (h !== THUMB_HEADER) c[h] = row[i];
      });
      return c;
    });
}

function dueCardsFrom_(cards, now) {
  return cards
    .filter(c => !c.due || new Date(c.due) <= now)
    .sort((a, b) => {
      if (!a.due && !b.due) return 0;  // both new — preserve relative order
      if (!a.due) return 1;            // new cards at end
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due); // most overdue first
    })
    .map(card => cleanCardDates(card));
}

function statsFrom_(cards, now) {
  const stats = { total: cards.length, due: 0, new: 0, review: 0 };
  cards.forEach(c => {
    if (c.due && new Date(c.due) > now) return;
    stats.due++;
    if ((Number(c.state) || 0) === 0) stats.new++; else stats.review++;
  });
  return stats;
}

function getDueCards() {
  return dueCardsFrom_(readCards_(), new Date());
}

// ─── API: bootstrap ────────────────────────────────────────────────────────
// Stats and due cards from a single sheet read (home screen).

function bootstrap() {
  const cards = readCards_();
  const now   = new Date();
  return {
    stats:  statsFrom_(cards, now),
    cards:  dueCardsFrom_(cards, now),
    config: getConfig_()
  };
}

// ─── Config: DEFAULTS + the user's overrides ───────────────────────────────
// Rows of the settings tab override DEFAULTS key by key. A blank value means no
// override; the last row of a key wins. A value that is not valid JSON, is out of
// range or has the wrong length is ignored and reported in config.rejected.
// config = { w, retention, max_interval, overridden: [keys], rejected: [{key, reason}] }

function parseSetting_(raw) {
  if (typeof raw === 'number') return raw;
  try {
    return JSON.parse(String(raw).trim());
  } catch (err) {
    return undefined;
  }
}

function resolveConfig_(rows) {
  const raw = {};
  rows.forEach(r => {
    const key = String(r[0]).trim();
    if (key) raw[key] = r[1];
  });
  const config = JSON.parse(JSON.stringify(DEFAULTS));
  config.overridden = [];
  config.rejected = [];
  Object.keys(raw).forEach(key => {
    if (String(raw[key]).trim() === '') return;
    const value  = parseSetting_(raw[key]);
    const reason = value === undefined ? 'not valid JSON' : checkSetting_(key, value);
    if (reason) {
      config.rejected.push({ key: key, reason: reason });
    } else {
      config[key] = value;
      config.overridden.push(key);
    }
  });
  return config;
}

function getConfig_() {
  const sheet = getSettingsSheet_(false);          // reading never creates the tab
  const last  = sheet ? sheet.getLastRow() : 0;
  const rows  = last >= 2 ? sheet.getRange(2, 1, last - 1, 2).getValues() : [];
  return resolveConfig_(rows);
}

// patch = { key: value | null }; null removes the override. Validates everything
// first and writes nothing on an error. A change of w is also recorded in
// weights_history. meta (optional): { source, note, n_reviews, loss_before,
// loss_after }.
function saveSettings(patch, meta) {
  const errors = {};
  Object.keys(patch || {}).forEach(key => {
    const reason = patch[key] === null
      ? (key in DEFAULTS ? '' : 'unknown key') : checkSetting_(key, patch[key]);
    if (reason) errors[key] = reason;
  });
  if (!patch || !Object.keys(patch).length || Object.keys(errors).length) {
    return { ok: false, errors: errors };
  }
  const source = String((meta && meta.source) || 'app');
  const now    = new Date().toISOString();
  const lock   = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSettingsSheet_(true);
    const last  = sheet.getLastRow();
    const keys  = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
    Object.keys(patch).forEach(key => {
      const value = patch[key] === null ? '' : JSON.stringify(patch[key]);
      const row   = [key, value, now, source];
      const at    = keys.map(r => String(r[0]).trim()).lastIndexOf(key);
      if (at >= 0) {
        sheet.getRange(at + 2, 1, 1, row.length).setValues([row]);
      } else {
        sheet.appendRow(row);
        keys.push([key]);
      }
    });
    if ('w' in patch) logWeights_(patch.w, source, meta || {}, now);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, config: getConfig_() };
}

// ─── Review log and weights history (weights screen) ───────────────────────
// The whole review log, in sheet order: { columns, rows } with ISO text for dates.
function getReviewLog() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const last  = sheet ? sheet.getLastRow() : 0;
  if (last < 2) {
    return { columns: LOG_HEADERS, rows: [] };
  }
  const rows = sheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
  return {
    columns: LOG_HEADERS,
    rows: rows.map(r => r.map(v => (v instanceof Date ? v.toISOString() : v)))
  };
}

// The last 10 changes of the weights, newest first; w is null for "back to defaults".
function getWeightsHistory() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WEIGHTS_SHEET_NAME);
  const last  = sheet ? sheet.getLastRow() : 0;
  if (last < 2) {
    return [];
  }
  const first = Math.max(2, last - 9);
  const rows  = sheet.getRange(first, 1, last - first + 1, WEIGHTS_HEADERS.length).getValues();
  const num   = v => (v === '' ? null : Number(v));
  return rows.reverse().map(r => {
    let w = null;
    try {
      const parsed = JSON.parse(String(r[2]));
      w = Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      w = null;
    }
    return {
      time: String(r[0]), n_reviews: num(r[1]), w: w, loss_before: num(r[3]),
      loss_after: num(r[4]), source: String(r[5]), note: String(r[6])
    };
  });
}

function logWeights_(w, source, meta, now) {
  try {
    const num = v => (typeof v === 'number' && isFinite(v) ? v : '');
    getWeightsSheet_().appendRow([
      now, num(meta.n_reviews), w === null ? '' : JSON.stringify(w),
      num(meta.loss_before), num(meta.loss_after), source,
      String(meta.note || (w === null ? 'back to defaults' : ''))
    ]);
  } catch (err) {
    console.error('weights history failed: ' + err);   // never fail the save
  }
}

// ─── API: updateCard ───────────────────────────────────────────────────────
// Writes FSRS fields back to the row matching id: one id-column read, one
// last_review read and one setValues per run of adjacent columns. Columns are
// located by header name, so extra columns and any column order are fine. meta
// (optional) is logged to the review_log sheet; meta.undo removes that review's
// log row instead. A stale save (see isStale_) writes nothing: { ok, stale }.

function writeFields_(sheet, row, headers, fsrs) {
  const cells = FSRS_FIELDS
    .filter(f => fsrs[f] !== undefined)
    .map(f => ({ name: f, col: headers.indexOf(f) + 1, value: fsrs[f] }))
    .sort((a, b) => a.col - b.col);

  // text cells first, so ISO timestamps and keyword lists stay text
  const textCells = cells
    .filter(c => TEXT_COLUMNS.indexOf(c.name) !== -1)
    .map(c => colToA1_(c.col) + row);
  if (textCells.length) sheet.getRangeList(textCells).setNumberFormat('@');

  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    sheet.getRange(row, run[0].col, 1, run.length).setValues([run.map(c => c.value)]);
    run = [];
  };
  cells.forEach(c => {
    if (run.length && c.col !== run[run.length - 1].col + 1) flushRun();
    run.push(c);
  });
  flushRun();
}

function logReview_(id, fsrs, meta) {
  if (!meta) return;
  try {
    // A retried request must not log the same review twice
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, id + '|' + fsrs.last_review);
    const key   = 'rv:' + Utilities.base64EncodeWebSafe(digest);
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return;
    const num = v => (typeof v === 'number' && isFinite(v) ? v : '');
    getLogSheet_().appendRow([
      fsrs.last_review, id, num(meta.rating), num(meta.state_before),
      num(fsrs.elapsed_days), num(fsrs.scheduled_days),
      num(fsrs.stability), num(fsrs.difficulty),
      num(meta.hints), num(meta.keywords), num(meta.duration_ms)
    ]);
    cache.put(key, '1', 21600);
  } catch (err) {
    console.error('review log failed: ' + err);   // never fail the card update
  }
}

// Undo of a review: drop its row from the log (matched by card id + review time).
// Idempotent: a retried undo finds nothing to delete.
function unlogReview_(id, reviewTime) {
  if (!reviewTime) return;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);   // appendRow elsewhere must not shift rows under us
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
    const last  = sheet ? sheet.getLastRow() : 0;
    if (last < 2) return;
    const keys = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (let i = keys.length - 1; i >= 0; i--) {
      if (String(keys[i][0]) === String(reviewTime) && String(keys[i][1]) === String(id)) {
        sheet.deleteRow(i + 2);
        return;
      }
    }
  } catch (err) {
    console.error('review unlog failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// A save is stale when the sheet already holds a later review of the same card
// (a delayed retry from another tab or device). Only a known timestamp counts:
// blank cells, legacy Date cells and unparsable values are never stale. An undo
// writes the previous (older) state, so it is applied only while the review it
// undoes is still the latest. Not covered: two saves running at the same moment.
function reviewMs_(v) {
  return typeof v === 'string' && v ? Date.parse(v) : NaN;
}

function isStale_(stored, fsrs, meta) {
  const have = reviewMs_(stored);
  if (isNaN(have)) return false;
  if (meta && meta.undo) {
    const undone = reviewMs_(meta.undone_time);
    return !isNaN(undone) && have !== undone;
  }
  const incoming = reviewMs_(fsrs.last_review);
  return !isNaN(incoming) && have > incoming;
}

function updateCard(id, fsrs, meta) {
  const sheet   = getSheet_();
  const headers = ensureColumns_(sheet, FSRS_FIELDS);
  const idCol   = headers.indexOf('id') + 1;
  const lastRow = sheet.getLastRow();
  if (idCol > 0 && lastRow >= 2) {
    const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    const at  = ids.findIndex(r => String(r[0]) === String(id));
    if (at >= 0) {
      const lrCol  = headers.indexOf('last_review') + 1;
      const stored = sheet.getRange(at + 2, lrCol, 1, 1).getValues()[0][0];
      if (isStale_(stored, fsrs, meta)) {
        return { ok: true, stale: true };
      }
      writeFields_(sheet, at + 2, headers, fsrs);
      if (meta && meta.undo) {
        unlogReview_(id, meta.undone_time);
      } else {
        logReview_(id, fsrs, meta);
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Card not found: ' + id };
}

// ─── API: getStats ─────────────────────────────────────────────────────────

function getStats() {
  return statsFrom_(readCards_(), new Date());
}

// ─── Setup (run once from editor) ─────────────────────────────────────────

function setupSheet() {
  const sheet = getSheet_();
  applyTextFormat_(sheet, sheet.getLastRow() + 1);   // safe to re-run
  getLogSheet_();
  getSettingsSheet_(true);
  SpreadsheetApp.getUi().alert(
    '✅ Sheets "cards", "review_log" and "settings" are ready!\n\n' +
    'Add cards manually or via the sheet tab.');
}
