// ─── Config ────────────────────────────────────────────────────────────────

const SHEET_NAME = 'cards';
const HEADERS = [
  'id', 'keywords', 'back_content', 'back_type',
  'due', 'stability', 'difficulty', 'elapsed_days',
  'scheduled_days', 'reps', 'lapses', 'state', 'last_review'
];

// ─── Entry Point ───────────────────────────────────────────────────────────

//function doGet(e) {
//  return HtmlService.createHtmlOutputFromFile('index')
//    .setTitle('⚡ Flash')
//    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
//    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
//}

function doGet(e) {
  const page = e?.parameter?.page;
  if (page === 'docs') {
    return HtmlService.createHtmlOutputFromFile('docs')
      .setTitle('⚡ Flash — Documentation')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('⚡ Flash')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
    sheet.setColumnWidth(3, 300); // back_content wider
  }
  return sheet;
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

function getDueCards() {
  const sheet = getSheet_();
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(String);
  const today   = new Date();
  today.setHours(23, 59, 59, 999);

  return data.slice(1)
    .filter(row => row[0]) // must have id
    .map(row => {
      const c = {};
      headers.forEach((h, i) => c[h] = row[i]);
      return c;
    })
    .filter(c => !c.due || new Date(c.due) <= today)
    .sort((a, b) => {
      if (!a.due && !b.due) return 0;  // both new — preserve relative order
      if (!a.due) return 1;            // new cards at end
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due); // most overdue first
    })
    .map(card => cleanCardDates(card));
}

// ─── API: updateCard ───────────────────────────────────────────────────────
// Writes FSRS fields back to the sheet row matching id.
// Writes each field as an individual cell — safe if the sheet has extra
// columns or was created manually with headers in any order.

function updateCard(id, fsrs) {
  const sheet   = getSheet_();
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const fields  = ['stability', 'difficulty', 'elapsed_days', 'scheduled_days',
                   'reps', 'lapses', 'state', 'last_review', 'due'];

  // Verify all FSRS columns exist; auto-add any that are missing
  fields.forEach(f => {
    if (headers.indexOf(f) === -1) {
      const newCol = headers.length + 1;
      sheet.getRange(1, newCol).setValue(f);
      headers.push(f);
    }
  });

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      const rowNum = i + 1;
      fields.forEach(f => {
        if (fsrs[f] === undefined) return;
        const col = headers.indexOf(f) + 1; // 1-based
        if (col > 0) sheet.getRange(rowNum, col).setValue(fsrs[f]);
      });
      SpreadsheetApp.flush(); // force write before response
      return { ok: true };
    }
  }
  return { ok: false, error: 'Card not found: ' + id };
}

// ─── API: getStats ─────────────────────────────────────────────────────────

function getStats() {
  const sheet   = getSheet_();
  const data    = sheet.getDataRange().getValues();
  if (data.length < 2) return { total: 0, due: 0, new: 0, review: 0 };

  const headers  = data[0].map(String);
  const idIdx    = headers.indexOf('id');
  const dueIdx   = headers.indexOf('due');
  const stateIdx = headers.indexOf('state');
  const today    = new Date();
  today.setHours(23, 59, 59, 999);

  let total = 0, due = 0, newCards = 0, review = 0;
  data.slice(1).forEach(row => {
    if (!row[idIdx]) return;
    total++;
    const dueDate = row[dueIdx];
    const isDue   = !dueDate || new Date(dueDate) <= today;
    if (isDue) {
      due++;
      const state = Number(row[stateIdx]) || 0;
      if (state === 0) newCards++; else review++;
    }
  });
  return { total, due, new: newCards, review };
}

// ─── Setup (run once from editor) ─────────────────────────────────────────

function setupSheet() {
  getSheet_();
  SpreadsheetApp.getUi().alert('✅ Sheet "cards" is ready!\n\nAdd cards manually or via the sheet tab.');
}