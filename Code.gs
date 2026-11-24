// ─── Config ────────────────────────────────────────────────────────────────

const SHEET_NAME = 'cards';
const LOG_SHEET_NAME = 'review_log';
const SETTINGS_SHEET_NAME = 'settings';     // personal overrides of DEFAULTS (Config.gs)
const WEIGHTS_SHEET_NAME = 'weights_history';
// Optional tool columns (Highlight.gs): picture thumbnails, the types of a card's tabs;
// never sent to the app
const THUMB_HEADER = 'back_thumb';
const TABS_HEADER = 'back_tabs';
// The study day starts at this local hour; keep equal to ROLLOVER_HOUR in index.html
const ROLLOVER_HOUR = 4;
const FORECAST_DAYS = 30;
const HEADERS = [
  'id', 'title', 'keywords', 'back_content', 'back_type',
  'due', 'stability', 'difficulty', 'elapsed_days',
  'scheduled_days', 'reps', 'lapses', 'state', 'last_review',
  'weak_keywords', 'miss_streak', 'ok_days', 'fail_days', 'trail', 'cap_days'
];
// Columns the app writes on every review
const FSRS_FIELDS = [
  'stability', 'difficulty', 'elapsed_days', 'scheduled_days',
  'reps', 'lapses', 'state', 'last_review', 'due',
  'weak_keywords', 'miss_streak', 'ok_days', 'fail_days', 'trail', 'cap_days'
];
// Kept as plain text so Sheets never converts "3/4", "1.5", "=x" or ISO dates
const TEXT_COLUMNS = [
  'id', 'title', 'keywords', 'back_content', 'back_type',
  'due', 'last_review', 'weak_keywords', 'trail'
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
        if (h !== THUMB_HEADER && h !== TABS_HEADER) c[h] = row[i];
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

// What the app offers now: due cards (most overdue first, new cards last in sheet
// order), their stats, and the new-card limit of the day. With new_per_day > 0 only
// as many new cards as the limit leaves after today's first reviews (the log rows
// with state_before 0 in the client's study day) are offered; reviews are never cut.
function dueView_(cards, now, offsetMs, config) {
  let due = dueCardsFrom_(cards, now);
  const stats = statsFrom_(cards, now);
  const limit = Number(config.new_per_day) || 0;
  const newLimit = { limit: limit, introduced: 0, remaining: 0 };
  if (limit > 0) {
    newLimit.introduced = introducedToday_(now, offsetMs);
    newLimit.remaining  = Math.max(0, limit - newLimit.introduced);
    let seen = 0;
    due = due.filter(c => (Number(c.state) || 0) !== 0 || ++seen <= newLimit.remaining);
    const kept = Math.min(seen, newLimit.remaining);
    stats.due -= stats.new - kept;
    stats.new  = kept;
  }
  return { stats: stats, cards: due, newLimit: newLimit };
}

// First reviews of cards (state_before 0) in the study day of `now`.
function introducedToday_(now, offsetMs) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const last  = sheet ? sheet.getLastRow() : 0;
  if (last < 2) return 0;
  const today = studyDayOf_(now.getTime(), offsetMs);
  let n = 0;
  sheet.getRange(2, 1, last - 1, 4).getValues().forEach(row => {
    const ms = row[0] instanceof Date ? row[0].getTime() : Date.parse(String(row[0]));
    if (Number(row[3]) === 0 && isFinite(ms) && studyDayOf_(ms, offsetMs) === today) n += 1;
  });
  return n;
}

function getDueCards(offsetMin) {
  return dueView_(readCards_(), new Date(), offsetMsOf_(offsetMin), getConfig_()).cards;
}

// ─── API: bootstrap ────────────────────────────────────────────────────────
// Stats and due cards from a single sheet read (home screen).

// offsetMin: the client's UTC offset in minutes (east positive), so study days
// are the client's. Without it, UTC.
function bootstrap(offsetMin) {
  const cards    = readCards_();
  const now      = new Date();
  const offsetMs = offsetMsOf_(offsetMin);
  const config   = getConfig_();
  const view     = dueView_(cards, now, offsetMs, config);
  const upcoming = upcomingFrom_(cards, now);
  return {
    stats:    view.stats,
    cards:    view.cards,
    newLimit: view.newLimit,
    forecast: forecastFrom_(cards, now, offsetMs),
    waiting:  upcoming.waiting,
    nextDue:  upcoming.nextDue,
    config:   config
  };
}

// What comes due next, for the home countdown. waiting: due times (ISO, soonest first)
// of sub-day cards (a learning step: scheduled_days < 1, due within a day) that are not
// due yet; the same cards the review session holds back (see requeue() in index.html).
// nextDue: the earliest future due time of any card, or null; the home screen refreshes
// its counts then.
function upcomingFrom_(cards, now) {
  const nowMs   = now.getTime();
  const waiting = [];
  let next = Infinity;
  cards.forEach(c => {
    if (!c.due) return;
    const ms = new Date(c.due).getTime();
    if (!(ms > nowMs)) return;   // due already, or not a date
    next = Math.min(next, ms);
    if (Number(c.scheduled_days) < 1 && ms - nowMs < 86400000) waiting.push(ms);
  });
  waiting.sort((a, b) => a - b);
  return {
    waiting: waiting.map(ms => new Date(ms).toISOString()),
    nextDue: isFinite(next) ? new Date(next).toISOString() : null
  };
}

// ─── Study days: forecast and activity ─────────────────────────────────────

function offsetMsOf_(offsetMin) {
  return typeof offsetMin === 'number' && isFinite(offsetMin) ? offsetMin * 60000 : 0;
}

// Study-day index of a time: the local calendar date, the day starting at ROLLOVER_HOUR.
function studyDayOf_(ms, offsetMs) {
  return Math.floor((ms + offsetMs - ROLLOVER_HOUR * 3600000) / 86400000);
}

// Scheduled cards per study day, FORECAST_DAYS long: [0] = due by the end of today
// (overdue and later-today learning steps included), [k] = k days ahead. New cards
// have no due date and are not counted; a card due later than the range is left out.
function forecastFrom_(cards, now, offsetMs) {
  const today  = studyDayOf_(now.getTime(), offsetMs);
  const counts = new Array(FORECAST_DAYS).fill(0);
  cards.forEach(c => {
    if (!c.due) return;
    const ms = new Date(c.due).getTime();
    if (!isFinite(ms)) return;
    const k = Math.max(0, studyDayOf_(ms, offsetMs) - today);
    if (k < FORECAST_DAYS) counts[k] += 1;
  });
  return counts;
}

// Reviews per study day from the review log: { today, days: { index: count } }. Reads
// only the time column.
function getActivity(offsetMin) {
  const offsetMs = offsetMsOf_(offsetMin);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const last  = sheet ? sheet.getLastRow() : 0;
  const days  = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(row => {
      const ms = row[0] instanceof Date ? row[0].getTime() : Date.parse(String(row[0]));
      if (!isFinite(ms)) return;
      const d = studyDayOf_(ms, offsetMs);
      days[d] = (days[d] || 0) + 1;
    });
  }
  return { today: studyDayOf_(Date.now(), offsetMs), days: days };
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

// ─── Recall record: rebuild from the review log ────────────────────────────
// The app keeps ok_days, fail_days, cap_days and trail per card (recallRecord in
// index.html). This replays the review log to fill them for reviews made before the
// columns existed. Same rules as the app: a review counts when it was made in Review state
// (state_before 2) and the log holds an earlier review of the card to measure the gap
// from (study days); learning steps and same-day reviews do not count. The result
// depends only on the log, so it is safe to re-run. Keep both rules equal.
const RECALL_COLUMNS = ['ok_days', 'fail_days', 'trail', 'cap_days'];
const TRAIL_LEN = 8;
const GUARD_FACTORS = { 1.5: 0.75, 2: 0.85 };   // Recap, Hard: cap = factor * failed gap
const GUARD_GROWTH = 1.3;                         // the cap grows by this per pass
const round2_ = x => Math.round(x * 100) / 100;
const TRAIL_CODES = { 1: 'A', 1.5: 'R', 2: 'H', 3: 'G', 4: 'E' };

// UTC offset of the script time zone at that time, daylight saving included.
function tzOffsetMs_(ms) {
  const z = Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'Z');
  const sign = z.charAt(0) === '-' ? -1 : 1;
  const minutes = Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5));
  return sign * minutes * 60000;
}

// rows: review_log rows (time, card id, rating, state_before, ...). offsetMin (optional)
// fixes the UTC offset of the study days; without it the script time zone is used.
// Returns { cards: { id: { ok, fail, cap, trail: ['gap:code'] } }, counted }.
function replayRecall_(rows, offsetMin) {
  const fixed = typeof offsetMin === 'number' && isFinite(offsetMin);
  const events = rows
    .map(r => ({
      ms: r[0] instanceof Date ? r[0].getTime() : Date.parse(String(r[0])),
      id: String(r[1]),
      rating: Number(r[2]),
      before: Number(r[3])
    }))
    .filter(e => isFinite(e.ms) && e.id)
    .sort((a, b) => a.ms - b.ms);
  const cards = {};
  let counted = 0;
  events.forEach(e => {
    const offsetMs = fixed ? offsetMin * 60000 : tzOffsetMs_(e.ms);
    const day = studyDayOf_(e.ms, offsetMs);
    const st = cards[e.id] || (cards[e.id] = { day: null, ok: 0, fail: 0, cap: 0, trail: [] });
    const code = TRAIL_CODES[e.rating];
    const gap = st.day === null ? 0 : day - st.day;
    if (e.before === 2 && code && gap >= 1) {
      if (e.rating >= 3) {
        st.ok = Math.max(st.ok, gap);
        if (st.fail && gap >= st.fail) {
          st.fail = 0;
        }
        st.cap = st.fail && st.cap ? round2_(st.cap * GUARD_GROWTH) : 0;
      } else {
        st.fail = gap;
        st.cap = GUARD_FACTORS[e.rating] ? round2_(GUARD_FACTORS[e.rating] * gap) : 0;
      }
      st.trail.push(gap + ':' + code);
      if (st.trail.length > TRAIL_LEN) {
        st.trail.shift();
      }
      counted += 1;
    }
    st.day = day;
  });
  return { cards: cards, counted: counted };
}

// Fills ok_days, fail_days, cap_days and trail of every card that has counted reviews in
// the log; other cards keep their cells. Run it from Flash > Rebuild recall history (or
// the editor), not while reviewing: a review saved meanwhile may be overwritten.
function rebuildHorizons(offsetMin) {
  const sheet   = getSheet_();
  const headers = ensureColumns_(sheet, RECALL_COLUMNS);
  const rows    = Math.max(sheet.getLastRow() - 1, 0);
  const log     = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const logRows = log ? Math.max(log.getLastRow() - 1, 0) : 0;
  const result  = { cards: rows, written: 0, reviews: 0 };
  if (!rows || !logRows) {
    return result;
  }
  const replay = replayRecall_(log.getRange(2, 1, logRows, 4).getValues(), offsetMin);
  result.reviews = replay.counted;
  const ids  = sheet.getRange(2, headers.indexOf('id') + 1, rows, 1).getValues();
  const cols = RECALL_COLUMNS.map(name => headers.indexOf(name) + 1);
  const cells = cols.map(col => sheet.getRange(2, col, rows, 1).getValues());
  ids.forEach((row, i) => {
    const st = replay.cards[String(row[0])];
    if (!st || !st.trail.length) {
      return;
    }
    const values = {
      ok_days: st.ok || '', fail_days: st.fail || '', cap_days: st.cap || '',
      trail: st.trail.join(' ')
    };
    RECALL_COLUMNS.forEach((name, k) => {
      cells[k][i][0] = values[name];
    });
    result.written += 1;
  });
  if (!result.written) {
    return result;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    cols.forEach((col, k) => {
      const range = sheet.getRange(2, col, rows, 1);
      if (RECALL_COLUMNS[k] === 'trail') {
        range.setNumberFormat('@');
      }
      range.setValues(cells[k]);
    });
  } finally {
    lock.releaseLock();
  }
  return result;
}

// Flash menu entry
function rebuildHorizonsMenu() {
  const r = rebuildHorizons();
  SpreadsheetApp.getUi().alert(
    'Recall history rebuilt from the review log.\n\n' +
    r.written + ' of ' + r.cards + ' cards updated (' + r.reviews + ' reviews counted).');
  return r;
}

// ─── Horizon guard: cards already scheduled past their cap ─────────────────
// Candidates: Review-state cards with a failure on record and an active cap_days. The
// app decides what to change (horizonPull in index.html); this returns slim rows and
// writes the result, skipping any card that was reviewed since the app read it.
const HORIZON_MAX = 5000;

function msOf_(v) {
  return v instanceof Date ? v.getTime() : reviewMs_(v);
}

function isoOf_(v) {
  const ms = msOf_(v);
  return isNaN(ms) ? '' : new Date(ms).toISOString();
}

function getHorizonCards() {
  return readCards_()
    .filter(c => Number(c.state) === 2 && Number(c.fail_days) > 0 && Number(c.cap_days) > 0)
    .map(c => ({
      id: String(c.id),
      title: String(c.title || ''),
      stability: Number(c.stability),
      scheduled_days: Number(c.scheduled_days),
      last_review: isoOf_(c.last_review),
      due: isoOf_(c.due),
      ok_days: Number(c.ok_days) || 0,
      fail_days: Number(c.fail_days),
      cap_days: Number(c.cap_days)
    }));
}

// changes: [{ id, last_review, due, scheduled_days, stability }]; last_review is the
// version the change was made from. The same call restores an earlier state: send the
// old values with the same last_review. Nothing is logged: no review took place.
function applyHorizon(changes) {
  if (!Array.isArray(changes) || changes.length > HORIZON_MAX) {
    return { ok: false, error: 'expected a list of at most ' + HORIZON_MAX + ' changes' };
  }
  const sheet   = getSheet_();
  const headers = ensureColumns_(sheet, FSRS_FIELDS);
  const rows    = Math.max(sheet.getLastRow() - 1, 0);
  const result  = { ok: true, applied: [], stale: 0, missing: 0, invalid: 0 };
  const col     = name => headers.indexOf(name) + 1;
  const row     = {};
  const seen    = rows ? sheet.getRange(2, col('last_review'), rows, 1).getValues() : [];
  if (rows) {
    sheet.getRange(2, col('id'), rows, 1).getValues().forEach((r, i) => {
      if (!(String(r[0]) in row)) {
        row[String(r[0])] = i;
      }
    });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    changes.forEach(ch => {
      const valid = ch && typeof ch === 'object' && ch.id !== undefined &&
        isFinite(ch.stability) && ch.stability > 0 &&
        isFinite(ch.scheduled_days) && ch.scheduled_days >= 0 &&
        isFinite(reviewMs_(ch.due)) && isFinite(reviewMs_(ch.last_review));
      if (!valid) {
        result.invalid += 1;
        return;
      }
      const i = row[String(ch.id)];
      if (i === undefined) {
        result.missing += 1;
        return;
      }
      if (msOf_(seen[i][0]) !== reviewMs_(ch.last_review)) {
        result.stale += 1;
        return;
      }
      writeFields_(sheet, i + 2, headers, {
        stability: ch.stability, scheduled_days: ch.scheduled_days, due: ch.due
      });
      result.applied.push(String(ch.id));
    });
  } finally {
    lock.releaseLock();
  }
  return result;
}

// ─── API: getRecallRows (Recall screen) ────────────────────────────────────
// Every card with the fields the Recall screen needs, no card content.
function getRecallRows() {
  return readCards_().map(c => ({
    id: String(c.id),
    title: String(c.title || ''),
    state: Number(c.state) || 0,
    stability: Number(c.stability) || 0,
    scheduled_days: Number(c.scheduled_days) || 0,
    reps: Number(c.reps) || 0,
    lapses: Number(c.lapses) || 0,
    last_review: isoOf_(c.last_review),
    due: isoOf_(c.due),
    ok_days: Number(c.ok_days) || 0,
    fail_days: Number(c.fail_days) || 0,
    cap_days: Number(c.cap_days) || 0,
    trail: String(c.trail || '')
  }));
}

// ─── API: getCardsIfUnchanged (Review ahead) ───────────────────────────────
// refs: [{ id, last_review }] as the app read them. Returns the cards, in that order,
// that were not reviewed since (same last_review); the others are left out.
const AHEAD_REFS_MAX = 200;

function getCardsIfUnchanged(refs) {
  if (!Array.isArray(refs) || refs.length > AHEAD_REFS_MAX) {
    return [];
  }
  const byId = {};
  readCards_().forEach(c => {
    byId[String(c.id)] = c;
  });
  const out = [];
  refs.forEach(ref => {
    const c = ref && byId[String(ref.id)];
    if (c && isoOf_(c.last_review) === isoOf_(ref.last_review)) {
      out.push(c);
    }
  });
  return out;
}

// ─── API: getStats ─────────────────────────────────────────────────────────

function getStats(offsetMin) {
  return dueView_(readCards_(), new Date(), offsetMsOf_(offsetMin), getConfig_()).stats;
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
