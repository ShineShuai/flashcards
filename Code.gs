// ─── Config ────────────────────────────────────────────────────────────────

const SHEET_NAME = 'cards';
const LOG_SHEET_NAME = 'review_log';
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
  return getAppUrl().replace('/exec', '/exec?page=docs');
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
      headers.forEach((h, i) => c[h] = row[i]);
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
  return { stats: statsFrom_(cards, now), cards: dueCardsFrom_(cards, now) };
}

// ─── API: updateCard ───────────────────────────────────────────────────────
// Writes FSRS fields back to the row matching id: one id-column read and one
// setValues per run of adjacent columns. Columns are located by header name, so
// extra columns and any column order are fine. meta (optional) is logged to the
// review_log sheet.

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

function updateCard(id, fsrs, meta) {
  const sheet   = getSheet_();
  const headers = ensureColumns_(sheet, FSRS_FIELDS);
  const idCol   = headers.indexOf('id') + 1;
  const lastRow = sheet.getLastRow();
  if (idCol > 0 && lastRow >= 2) {
    const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    const at  = ids.findIndex(r => String(r[0]) === String(id));
    if (at >= 0) {
      writeFields_(sheet, at + 2, headers, fsrs);
      logReview_(id, fsrs, meta);
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
  SpreadsheetApp.getUi().alert(
    '✅ Sheets "cards" and "review_log" are ready!\n\nAdd cards manually or via the sheet tab.');
}
