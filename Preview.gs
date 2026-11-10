// ─── Card preview (Flash menu) ─────────────────────────────────────────────
// A sidebar or window that follows the selected row of the cards sheet and shows
// its back exactly as the app does: the sidebar page reuses the CSS, the pinned
// marked/DOMPurify <script> tags and the @render block of index.html, read at run
// time, so there is one source of truth and nothing to keep in step.

const PREVIEW_TITLE = 'Card preview';

function appShell_() {
  const src = HtmlService.createHtmlOutputFromFile('index').getContent();
  const first = re => {
    const m = src.match(re);
    return m ? m[1] : '';
  };
  return {
    css: first(/<style>([\s\S]*?)<\/style>/),
    scripts: (src.match(/<script[^>]*cdn\.jsdelivr\.net[^>]*><\/script>/g) || []).join('\n'),
    render: first(/\/\/ @render-begin([\s\S]*?)\/\/ @render-end/)
  };
}

function showPreview_(asWindow) {
  const tpl = HtmlService.createTemplateFromFile('Sidebar');
  tpl.shell = appShell_();
  const page = tpl.evaluate().setTitle(PREVIEW_TITLE);
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

// Called by the sidebar every second or so. A blank back_type shows as text, like
// in the app (Flash > Highlight all fills blank types by sniffing).
function getActiveRowPreview() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) {
    return { note: 'Select a row on the "' + SHEET_NAME + '" sheet.' };
  }
  const row = sheet.getActiveRange().getRow();
  if (row < 2) {
    return { note: 'Select a card row below the header.' };
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
    content: get('back_content')
  };
}
