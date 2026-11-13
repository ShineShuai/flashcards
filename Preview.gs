// ─── Card preview (Flash menu) ─────────────────────────────────────────────
// A sidebar or window that follows the selected row of the cards sheet and shows
// its back as the app does. Sidebar.html is one static page: the stylesheet, the
// pinned marked/DOMPurify <script> tags and the @render block of index.html are
// copied into it by tools/sync-preview.mjs when the code is committed (CI checks
// that it is current), so there is one source of truth and nothing is read from
// index.html at run time. The page polls getActiveRowPreview about every 1.5 s.

const PREVIEW_TITLE = 'Card preview';

function showPreview_(asWindow) {
  const page = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle(PREVIEW_TITLE);
  const ui = SpreadsheetApp.getUi();
  if (asWindow) {
    ui.showModelessDialog(page.setWidth(640).setHeight(560), PREVIEW_TITLE);
  } else {
    ui.showSidebar(page);
  }
}

function showPreviewSidebar() {
  showPreview_(false);
}

function showPreviewWindow() {
  showPreview_(true);
}

// Called by the sidebar every second or so. Either { note, version } (nothing to show,
// and why: it names the sheet and row the script sees) or the selected row: { row, id,
// title, type, content, version }. A blank back_type shows as text, like in the app
// (Flash > Highlight all fills blank types by sniffing). version is the script's.
function getActiveRowPreview() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const name = sheet.getName();
  if (name !== SHEET_NAME) {
    return {
      note: 'The active sheet is "' + name + '". Open the "' + SHEET_NAME +
        '" sheet and select a card row.',
      version: APP_VERSION
    };
  }
  const range = sheet.getActiveRange();
  const row = range ? range.getRow() : 0;
  if (row < 2) {
    return {
      note: row === 1
        ? 'Row 1 is the header. Select a card row below it.'
        : 'No cell is selected. Select a card row of the "' + SHEET_NAME + '" sheet.',
      version: APP_VERSION
    };
  }
  const headers = readHeaders_(sheet);
  const values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  const get = name => {
    const at = headers.indexOf(name);
    return at < 0 ? '' : String(values[at]);
  };
  return {
    row: row,
    id: get('id'),
    title: get('title'),
    type: get('back_type').toLowerCase().trim() || 'text',
    content: get('back_content'),
    version: APP_VERSION
  };
}
