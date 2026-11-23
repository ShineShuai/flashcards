// ─── Sheet tools ───────────────────────────────────────────────────────────
// Syntax highlighting of the back_content column (html, svg, live, md), back_type
// sniffing and optional picture thumbnails. They run on every edit (simple trigger
// onEdit) and from the Flash menu, never from the web app. Cell values change
// only where noted: a blank back_type is filled by sniffing, and the back_thumb
// column (if present) holds =IMAGE(url) for each html card whose first picture tab (or
// whole card) is one hosted <img src="https://...">. There is no thumbnail of an SVG:
// IMAGE takes http(s) URLs only (a data: URI is "not a valid url"), and the preview shows
// SVGs. A cell can hold several tabs (see splitTabs); the back_tabs column (if present)
// lists their types.

const EDIT_ROW_CAP = 500;          // rows one edit may restyle; Flash > Highlight all: the rest
const HIGHLIGHT_CHUNK = 300;
const THUMB_ROW_HEIGHT = 72;
const THUMB_MAX_URL = 2000;        // the longest URL IMAGE accepts

// Light palette, at least 4.5:1 on white (test/highlight.mjs checks it).
const HL_STYLES = {
  tag:      { color: '#116329' },
  attr:     { color: '#0550AE' },
  string:   { color: '#0A3069' },
  comment:  { color: '#57606A', italic: true },
  entity:   { color: '#953800' },
  meta:     { color: '#6639BA' },
  embedded: { color: '#57606A' },
  heading:  { color: '#0550AE', bold: true },
  marker:   { color: '#CF222E', bold: true },
  quote:    { color: '#57606A', italic: true },
  code:     { color: '#82071E' },
  link:     { color: '#0550AE' },
  bold:     { bold: true },
  em:       { italic: true }
};

// ─── Tabs ──────────────────────────────────────────────────────────────────
// splitTabs and TAB_MARKER are copied from index.html by tools/sync-preview.mjs (CI checks
// that the copy is current): edit them there, not here.
// @sync-tabs-begin
// One card, several tabs. A line that holds only an HTML comment "tab", "tab TYPE" or
// "tab TYPE: Label" (also "tab: Label") starts the next tab. TYPE (text, md, html, svg,
// live) replaces the card's back_type for that tab. The text before the first marker is
// tab 1; blank tabs are dropped. Without a marker the card is one tab, as it always was.
// A comment is invisible in html, svg and md, so an older client shows the tabs one after
// the other. (No literal comment opener here: the sidebar page embeds this block in a
// <script>, where it would start the escaped state; hence the escaped dashes.)
// This block is also copied into Highlight.gs by tools/sync-preview.mjs: the sheet tools
// split a cell exactly as the app does. Each tab is content.slice(start, end); `type` is
// the card's type, or null where the caller does not know it yet (the sheet sniffs it
// from tab 1), and then a tab without a marker type has type null.
const TAB_MARKER =
  /^[ \t]*<!\-\-[ \t]*tab(?:[ \t]+(text|md|html|svg|live))?[ \t]*(?::[ \t]*([^\n]*?))?[ \t]*\-\->[ \t]*$/gim;
const TAB_LABEL_MAX = 40;
function splitTabs(content, type) {
  const tabs = [];
  let from = 0;
  let cur = { type, label: '' };
  const push = end => {
    let start = from;
    let body = content.slice(from, end);
    if (from > 0) {
      const lead = /^\r?\n/.exec(body);
      if (lead) {
        start += lead[0].length;
        body = body.slice(lead[0].length);
      }
    }
    if (end < content.length) {
      body = body.replace(/\r?\n$/, '');
    }
    if (body.trim()) {
      tabs.push({ type: cur.type, label: cur.label, content: body, start, end: start + body.length });
    }
  };
  for (const m of content.matchAll(TAB_MARKER)) {
    push(m.index);
    from = m.index + m[0].length;
    cur = { type: m[1] ? m[1].toLowerCase() : type,
            label: (m[2] || '').trim().slice(0, TAB_LABEL_MAX) };
  }
  push(content.length);
  return tabs;
}
// @sync-tabs-end

// ─── back_type sniffing ────────────────────────────────────────────────────

function sniffType_(text) {
  const t = String(text).trim();
  if (!t) return 'text';
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t)) return 'svg';
  if (/^(<!doctype|<!--|<\/?[a-z][\w:.-]*(\s|\/?>))/i.test(t) ||
      /<\/[a-z][\w:.-]*>|<br\s*\/?>/i.test(t)) {
    return 'html';
  }
  if (/^ {0,3}#{1,6}[ \t]+\S/m.test(t) || /^ {0,3}(`{3,}|~{3,})/m.test(t) ||
      /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+\S/m.test(t) || /^ {0,3}>[ \t]?\S/m.test(t) ||
      /\*\*[^*\n]+\*\*/.test(t) || /\[[^\]\n]+\]\([^)\s]+\)/.test(t) ||
      /^\|.+\|[ \t]*$/m.test(t) || /`[^`\n]+`/.test(t)) {
    return 'md';
  }
  return 'text';
}

// The back_type of a cell: the type of tab 1 (a marker type wins), else what its text
// looks like. A cell without a marker is one tab: sniffType_(text).
function sniffCard_(text) {
  const first = splitTabs(String(text), null)[0];
  return first ? first.type || sniffType_(first.content) : 'text';
}

// ─── Tokenizer: tokenize_(text, kind) -> [{ s, e, cls }] ───────────────────
// One left-to-right pass, so tokens never overlap and nothing is painted twice
// (the old highlighter repainted attribute names inside strings and tags inside
// comments). Offsets are JS string indices. Unknown kinds give no tokens.

const RE_TAG_OPEN = /<\/?[A-Za-z][\w:.-]*/y;
const RE_WS = /\s+/y;
const RE_ATTR = /[^\s=>\/"'<]+/y;
const RE_EQ = /\s*=\s*/y;
const RE_UNQUOTED = /[^\s>]+/y;
const RE_ENTITY = /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/y;
const RE_AUTOLINK = /<(?:https?:\/\/|mailto:)[^\s<>]+>/y;
const RE_MD_LINK = /!?\[([^\]\n]*)\]\(([^)\s]*)((?:\s+"[^"\n]*")?)\)/y;
const RE_MD_BOLD = /(\*\*|__)(?=\S)[^\n]*?\S\1/y;
const RE_MD_EM = /([*_])(?=\S)[^\n*_]*?\S\1/y;

function match_(re, text, i) {
  re.lastIndex = i;
  return re.exec(text);
}

// A tag, comment or declaration starting at text[i] === '<'. Pushes its tokens and
// returns the index after it, or i when it is not markup.
function scanMarkup_(text, i, out) {
  const n = text.length;
  const whole = (end, cls) => {
    const e = end < 0 ? n : end;
    out.push({ s: i, e: e, cls: cls });
    return e;
  };
  if (text.startsWith('<!--', i)) {
    const k = text.indexOf('-->', i + 4);
    return whole(k < 0 ? -1 : k + 3, 'comment');
  }
  if (text.startsWith('<![CDATA[', i)) {
    const k = text.indexOf(']]>', i);
    return whole(k < 0 ? -1 : k + 3, 'meta');
  }
  if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
    const k = text.indexOf('>', i);
    return whole(k < 0 ? -1 : k + 1, 'meta');
  }
  const open = match_(RE_TAG_OPEN, text, i);
  if (!open) return i;
  out.push({ s: i, e: RE_TAG_OPEN.lastIndex, cls: 'tag' });
  const closing = open[0][1] === '/';
  const name = open[0].replace(/^<\/?/, '').toLowerCase();
  let p = RE_TAG_OPEN.lastIndex;
  let ended = false;
  let selfClosed = false;
  while (p < n && !ended) {
    if (match_(RE_WS, text, p)) p = RE_WS.lastIndex;
    if (p >= n) break;
    if (text[p] === '>') {
      out.push({ s: p, e: p + 1, cls: 'tag' });
      p += 1;
      ended = true;
    } else if (text[p] === '/' && text[p + 1] === '>') {
      out.push({ s: p, e: p + 2, cls: 'tag' });
      p += 2;
      ended = true;
      selfClosed = true;
    } else if (match_(RE_ATTR, text, p)) {
      out.push({ s: p, e: RE_ATTR.lastIndex, cls: 'attr' });
      p = RE_ATTR.lastIndex;
      if (match_(RE_EQ, text, p)) {
        p = RE_EQ.lastIndex;
        const q = text[p];
        if (q === '"' || q === "'") {
          const k = text.indexOf(q, p + 1);       // a quoted value may contain > and =
          const e = k < 0 ? n : k + 1;
          out.push({ s: p, e: e, cls: 'string' });
          p = e;
        } else if (match_(RE_UNQUOTED, text, p)) {
          out.push({ s: p, e: RE_UNQUOTED.lastIndex, cls: 'string' });
          p = RE_UNQUOTED.lastIndex;
        }
      }
    } else {
      p += 1;                                       // stray / or quote
    }
  }
  if (ended && !closing && !selfClosed && (name === 'script' || name === 'style')) {
    const re = new RegExp('</' + name, 'ig');       // raw text up to the closing tag
    re.lastIndex = p;
    const m = re.exec(text);
    const e = m ? m.index : n;
    if (e > p) out.push({ s: p, e: e, cls: 'embedded' });
    return e;
  }
  return p;
}

function tokenizeHtml_(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === '<') {
      const e = scanMarkup_(text, i, out);
      i = e > i ? e : i + 1;
    } else if (text[i] === '&' && match_(RE_ENTITY, text, i)) {
      out.push({ s: i, e: RE_ENTITY.lastIndex, cls: 'entity' });
      i = RE_ENTITY.lastIndex;
    } else {
      i += 1;
    }
  }
  return out;
}

function tokenizeMd_(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let bol = true;                                   // at the start of a line
  let lm;
  while (i < n) {
    if (bol) {
      bol = false;
      const nl = text.indexOf('\n', i);
      const le = nl < 0 ? n : nl;
      const line = text.slice(i, le);
      let m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) {                                      // fenced code: everything to the closing fence
        const mark = m[1][0] === '`' ? '`' : '~';
        const close = new RegExp('^ {0,3}' + mark + '{' + m[1].length + ',}[ \\t]*$');
        let end = n;
        let p = le;
        while (p < n) {
          const s2 = p + 1;
          const nl2 = text.indexOf('\n', s2);
          const e2 = nl2 < 0 ? n : nl2;
          if (close.test(text.slice(s2, e2))) {
            end = e2;
            break;
          }
          p = e2;
        }
        out.push({ s: i, e: end, cls: 'code' });
        i = end;
        continue;
      }
      if (/^ {0,3}#{1,6}[ \t]+/.test(line)) {
        out.push({ s: i, e: le, cls: 'heading' });
        i = le;
        continue;
      }
      if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line) ||
          (line.includes('|') &&
           /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line))) {
        out.push({ s: i, e: le, cls: 'marker' });  // rule or table separator
        i = le;
        continue;
      }
      if ((m = /^ {0,3}>+[ \t]?/.exec(line))) {
        out.push({ s: i, e: i + m[0].length, cls: 'quote' });
        i += m[0].length;
      } else if ((m = /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t])/.exec(line))) {
        const s = i + m[1].length;
        out.push({ s: s, e: s + m[2].length, cls: 'marker' });
        i = s + m[2].length;
      }
      if (i >= n) break;
    }
    const c = text[i];
    if (c === '\n') {
      bol = true;
      i += 1;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      let k = i;
      while (text[k] === '`') k += 1;
      const run = k - i;
      let end = -1;
      for (let j = k; (j = text.indexOf('`', j)) >= 0;) {
        let e = j;
        while (text[e] === '`') e += 1;
        if (e - j === run) {
          end = e;
          break;
        }
        j = e;
      }
      if (end > 0 && !text.slice(i, end).includes('\n\n')) {
        out.push({ s: i, e: end, cls: 'code' });
        i = end;
      } else {
        i = k;
      }
    } else if (c === '<') {
      if (match_(RE_AUTOLINK, text, i)) {
        out.push({ s: i, e: RE_AUTOLINK.lastIndex, cls: 'string' });
        i = RE_AUTOLINK.lastIndex;
      } else {
        const e = scanMarkup_(text, i, out);
        i = e > i ? e : i + 1;
      }
    } else if ((c === '[' || c === '!') && (lm = match_(RE_MD_LINK, text, i))) {
      const label = (c === '!' ? 1 : 0) + lm[1].length + 2;     // ![text] or [text]
      out.push({ s: i, e: i + label, cls: 'link' });
      out.push({ s: i + label, e: RE_MD_LINK.lastIndex, cls: 'string' });
      i = RE_MD_LINK.lastIndex;
    } else if ((c === '*' || c === '_') && !(c === '_' && /\w/.test(text[i - 1] || ''))) {
      if (match_(RE_MD_BOLD, text, i)) {
        out.push({ s: i, e: RE_MD_BOLD.lastIndex, cls: 'bold' });
        i = RE_MD_BOLD.lastIndex;
      } else if (match_(RE_MD_EM, text, i)) {
        out.push({ s: i, e: RE_MD_EM.lastIndex, cls: 'em' });
        i = RE_MD_EM.lastIndex;
      } else {
        i += 1;
      }
    } else if (c === '&' && match_(RE_ENTITY, text, i)) {
      out.push({ s: i, e: RE_ENTITY.lastIndex, cls: 'entity' });
      i = RE_ENTITY.lastIndex;
    } else {
      i += 1;
    }
  }
  return out;
}

function tokenize_(text, kind) {
  if (kind === 'html' || kind === 'svg' || kind === 'live') return tokenizeHtml_(text);
  if (kind === 'md') return tokenizeMd_(text);
  return [];
}

// Tokens of a whole cell, sorted: each tab by its own type (offsets shifted into the cell)
// and the marker lines as meta. Without a marker it is tokenize_(text, kind).
function tokenizeCard_(text, kind) {
  const out = [];
  for (const m of text.matchAll(TAB_MARKER)) {
    out.push({ s: m.index, e: m.index + m[0].length, cls: 'meta' });
  }
  splitTabs(text, kind).forEach(t => {
    tokenize_(t.content, t.type).forEach(k => {
      out.push({ s: k.s + t.start, e: k.e + t.start, cls: k.cls });
    });
  });
  return out.sort((a, b) => a.s - b.s);
}

// ─── Sheets adapters ───────────────────────────────────────────────────────

function textStyle_(spec) {
  const b = SpreadsheetApp.newTextStyle();
  if (spec.color) b.setForegroundColor(spec.color);
  if (spec.bold) b.setBold(true);
  if (spec.italic) b.setItalic(true);
  return b.build();
}

function richText_(text, kind) {
  const builder = SpreadsheetApp.newRichTextValue().setText(text);
  const styles = {};
  tokenizeCard_(text, kind).forEach(t => {
    styles[t.cls] = styles[t.cls] || textStyle_(HL_STYLES[t.cls]);
    builder.setTextStyle(t.s, t.e, styles[t.cls]);
  });
  return builder.build();
}

// The =IMAGE formula of a card that is one hosted picture, <img src="https://...">, or ''.
// Sheets fetches the URL itself, so the picture must be readable for the sheet's owner.
function imageFormula_(html) {
  const m = /^\s*<img\b[^>]*?\ssrc\s*=\s*(["'])(https:\/\/[^"'\s]+)\1[^>]*>\s*$/i.exec(String(html));
  const url = m ? m[2].replace(/&amp;/g, '&') : '';
  return url && url.length <= THUMB_MAX_URL ? '=IMAGE("' + url + '")' : '';
}

// The thumbnail of a card: that of its first tab that is html and one hosted picture (a
// card without a marker is one tab), else ''.
function thumbFor_(kind, text) {
  for (const t of splitTabs(String(text), kind)) {
    const formula = t.type === 'html' ? imageFormula_(t.content) : '';
    if (formula) return formula;
  }
  return '';
}

// What the back_tabs column shows: the type of each tab, "html · svg · img" (an html tab
// that is one <img> reads img); '' for a card with fewer than two tabs.
const TABS_SUMMARY_MAX = 6;
function tabsSummary_(kind, text) {
  const tabs = splitTabs(String(text), kind);
  if (tabs.length < 2) return '';
  const names = tabs.slice(0, TABS_SUMMARY_MAX).map(t =>
    t.type === 'html' && /^\s*<img\b[^>]*>\s*$/i.test(t.content) ? 'img' : t.type);
  if (tabs.length > TABS_SUMMARY_MAX) names.push('+' + (tabs.length - TABS_SUMMARY_MAX));
  return names.join(' · ');
}

// 1-based columns of the sheet's tool columns; 0 when a column is missing.
function toolColumns_(sheet) {
  const headers = readHeaders_(sheet);
  const col = name => headers.indexOf(name) + 1;
  return { content: col('back_content'), type: col('back_type'), thumb: col(THUMB_HEADER),
           tabs: col(TABS_HEADER) };
}

// Restyles `count` rows from `row`: rich text, a sniffed back_type where it is blank,
// thumbnails, the tab summary. One read and one write per kind. Formulas, numbers, dates and blank
// cells are left alone (rewriting them as rich text would replace the value).
function updateRows_(sheet, row, count, cols) {
  const done = { styled: 0, typed: 0, thumbs: 0 };
  if (!cols.content || count < 1) return done;
  const contentRange = sheet.getRange(row, cols.content, count, 1);
  const texts = contentRange.getValues();
  const formulas = contentRange.getFormulas();
  const types = cols.type ? sheet.getRange(row, cols.type, count, 1).getValues() : null;
  const typed = types ? types.map(r => [r[0]]) : null;
  const rich = [];
  const thumbs = [];
  const summaries = [];
  const heights = [];
  texts.forEach((cell, i) => {
    const text = typeof cell[0] === 'string' ? cell[0] : '';
    let type = types ? String(types[i][0]).toLowerCase().trim() : '';
    if (types && !type && text.trim()) {
      type = sniffCard_(text);
      typed[i][0] = type;
      done.typed += 1;
    }
    const kind = type || sniffCard_(text);
    const skip = formulas[i][0] !== '' || typeof cell[0] !== 'string' || text === '';
    rich.push(skip ? null : richText_(text, kind));
    const thumb = thumbFor_(kind, text);
    thumbs.push([thumb]);
    summaries.push([tabsSummary_(kind, text)]);
    if (thumb) heights.push(row + i);
  });
  if (done.typed) sheet.getRange(row, cols.type, count, 1).setValues(typed);
  for (let start = 0; start < count;) {              // consecutive rows to restyle
    if (!rich[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < count && rich[end]) end += 1;
    sheet.getRange(row + start, cols.content, end - start, 1)
      .setRichTextValues(rich.slice(start, end).map(v => [v]));
    done.styled += end - start;
    start = end;
  }
  if (cols.thumb) {
    sheet.getRange(row, cols.thumb, count, 1).setFormulas(thumbs);
    heights.forEach(r => sheet.setRowHeight(r, THUMB_ROW_HEIGHT));
    done.thumbs = heights.length;
  }
  if (cols.tabs) {
    sheet.getRange(row, cols.tabs, count, 1).setValues(summaries);
    done.tabs = summaries.filter(r => r[0]).length;
  }
  return done;
}

// Simple trigger: restyles the rows of an edit in back_content or back_type.
function onEdit(e) {
  try {
    const range = e && e.range;
    if (!range || range.getSheet().getName() !== SHEET_NAME) return;
    const cols = toolColumns_(range.getSheet());
    const c1 = range.getColumn();
    const c2 = c1 + range.getNumColumns() - 1;
    const hit = c => c && c >= c1 && c <= c2;
    if (!hit(cols.content) && !hit(cols.type)) return;
    const first = Math.max(range.getRow(), 2);
    const last = Math.min(range.getRow() + range.getNumRows() - 1, first + EDIT_ROW_CAP - 1);
    if (last >= first) updateRows_(range.getSheet(), first, last - first + 1, cols);
  } catch (err) {
    console.error('highlight failed: ' + err);       // an edit must never fail
  }
}

// Flash menu: every card row, in chunks.
function highlightAll() {
  const sheet = getSheet_();
  const cols = toolColumns_(sheet);
  const total = { styled: 0, typed: 0, thumbs: 0 };
  const last = sheet.getLastRow();
  for (let row = 2; row <= last; row += HIGHLIGHT_CHUNK) {
    const done = updateRows_(sheet, row, Math.min(HIGHLIGHT_CHUNK, last - row + 1), cols);
    Object.keys(done).forEach(k => { total[k] = (total[k] || 0) + done[k]; });
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(
    total.styled + ' cells styled, ' + total.typed + ' back_type filled' +
    (cols.thumb ? ', ' + total.thumbs + ' thumbnails' : '') +
    (cols.tabs ? ', ' + (total.tabs || 0) + ' with tabs' : ''), 'Flash', 6);
  return total;
}

// Adds a tool column header after the last column, unless the sheet has it.
function addToolColumn_(sheet, header, width) {
  if (readHeaders_(sheet).indexOf(header) >= 0) return;
  const col = Math.max(sheet.getLastColumn(), 1) + 1;
  sheet.getRange(1, col).setValue(header)
    .setBackground('#7C3AFF').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setColumnWidth(col, width);
}

// Flash menu: adds the back_thumb column (once) and fills it.
function addThumbnailColumn() {
  addToolColumn_(getSheet_(), THUMB_HEADER, 120);
  return highlightAll();
}

// Flash menu: adds the back_tabs column (once) and fills it.
function addTabsColumn() {
  addToolColumn_(getSheet_(), TABS_HEADER, 150);
  return highlightAll();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Flash')
    .addItem('Preview card (sidebar)', 'showPreviewSidebar')
    .addItem('Preview card (window)', 'showPreviewWindow')
    .addSeparator()
    .addItem('Highlight all back_content', 'highlightAll')
    .addItem('Add picture thumbnail column', 'addThumbnailColumn')
    .addItem('Add tabs column', 'addTabsColumn')
    .addItem('Rebuild recall history', 'rebuildHorizonsMenu')
    .addItem('Check sheet tools', 'checkSheetTools')
    .addToUi();
}

// Flash menu: the two things only the real Sheets service can confirm. Writes the
// sheet "_flash_check": A1 is styled with offsets after an emoji, B1 reports what
// Sheets stored; A2 should show the Sheets logo (an IMAGE formula with an https URL,
// what the back_thumb column uses).
function checkSheetTools() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('_flash_check') || ss.insertSheet('_flash_check');
  sheet.clear();
  const text = '😀 😀 <b>x</b>';
  sheet.getRange('A1').setRichTextValues([[richText_(text, 'html')]]);
  const runs = sheet.getRange('A1').getRichTextValue().getRuns();
  const bad = tokenize_(text, 'html').filter(t => {
    const want = text.slice(t.s, t.e);
    return !runs.some(r => r.getText() === want &&
      r.getTextStyle().getForegroundColor() === HL_STYLES[t.cls].color);
  });
  sheet.getRange('B1').setValue(bad.length
    ? 'OFFSET MISMATCH after emoji: ' + bad.map(t => text.slice(t.s, t.e)).join(' ')
    : 'ok: styled runs match the JS offsets');
  sheet.getRange('A2').setFormula(imageFormula_(
    '<img src="https://www.gstatic.com/images/branding/product/1x/sheets_48dp.png">'));
  sheet.setRowHeight(2, THUMB_ROW_HEIGHT);
  sheet.getRange('B2').setValue('A2 should show the Sheets logo; if it is empty or an error, ' +
    'IMAGE does not load https pictures here (thumbnails of <img> cards)');
  SpreadsheetApp.getUi().alert('Sheet "_flash_check" written. Read B1 and look at A2; ' +
    'delete the sheet afterwards.');
  return { offsetMismatches: bad.length };
}
