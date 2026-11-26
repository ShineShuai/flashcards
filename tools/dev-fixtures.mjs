// Sample cards of the local dev server (tools/dev.mjs). One card per feature worth looking
// at; deterministic, so a run is reproducible. Add a card here, then start with --reset.

const para = (i, j) => `Section ${i}, paragraph ${j}: ` +
  'The quick brown fox jumps over the lazy dog. '.repeat(6).trim();
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

const longMd = '# A long markdown answer\n\n' + range(12).map((i) =>
  `## Section ${i}\n\n${para(i, 1)}\n\n${para(i, 2)}\n\n- point ${i}.1\n- point ${i}.2\n`
).join('\n');

const longHtml = '<h1>A long html answer</h1>' + range(12).map((i) =>
  `<h2>Section ${i}</h2><p>${para(i, 1)}</p><p>${para(i, 2)}</p>`
).join('');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="240">' +
  '<rect width="120" height="60" rx="8" fill="#7C3AFF"/>' +
  '<circle cx="30" cy="30" r="14" fill="#fff"/>' +
  '<text x="52" y="36" font-size="16" fill="#fff" font-family="sans-serif">SVG</text></svg>';
const svgUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

const tabs = [
  '<!-- tab md: Summary -->',
  '## Summary\n\nTabs of one card: **markdown**, html, svg and text.',
  '<!-- tab html: Table -->',
  '<table border="1" cellpadding="6"><tr><th>a</th><th>b</th></tr>' +
    '<tr><td>1</td><td>2</td></tr></table>',
  '<!-- tab svg: Picture -->',
  svg,
  '<!-- tab text: Notes -->',
  'Plain text, <b>not</b> html.',
].join('\n');

const live = '<button id="b" style="font-size:18px;padding:8px 16px">Clicked 0</button>' +
  '<script>let n = 0; document.getElementById("b").onclick = function () {' +
  ' this.textContent = "Clicked " + (++n); };</script>';

const rows = [
  ['Plain text', 'text', 'Just a short answer.\nSecond line.'],
  ['Markdown with a table', 'md',
    '## Table\n\n| key | value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\n- item\n- `code`'],
  ['Html with a style block', 'html',
    '<head><style>h3{color:#7C3AFF}.box{border:2px solid #7C3AFF;padding:8px}</style></head>' +
    '<h3>Styled</h3><div class="box">A box from the card\'s own stylesheet.</div>'],
  ['Html with a picture', 'html', `<p>A picture:</p><img src="${svgUri}" alt="sample">`],
  ['Svg', 'svg', svg],
  ['Long markdown (pages)', 'md', longMd],
  ['Long html (pages)', 'html', longHtml],
  ['Several tabs', 'html', tabs],
  ['Live frame', 'live', live],
];

// Cards as sheet rows: id, title, keywords, back_content, back_type; the schedule columns
// stay blank, so every card is new.
export const fixtureCards = () => rows.map(([title, type, content], i) => ({
  id: String(i + 1),
  title,
  keywords: 'alpha;beta;gamma',
  back_content: content,
  back_type: type,
}));
