// Run: node test/ui/render.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Card content goes through DOMPurify (html, md, svg); nothing active survives.
import assert from 'node:assert/strict';
import { boot, card, sleep } from './harness.mjs';

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
}

// Shows the back of one card and returns the #back-content element.
async function back(content, type, options = {}) {
  const env = boot({ cards: [card('1', 'a;b;c', { back_content: content, back_type: type })],
                     realMarkdown: true, ...options });
  await env.start();
  env.w.flipCard();
  await sleep(5);
  return { el: env.$('back-content'), env };
}

const unsafe = (el) => {
  const bad = [];
  for (const node of el.querySelectorAll('*')) {
    if (/^(script|iframe|object|embed|meta|style|link|base|form)$/i.test(node.nodeName)) {
      bad.push('<' + node.nodeName + '>');
    }
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name)) {
        bad.push(attr.name);
      }
      if (/^(href|src|xlink:href|action|formaction)$/i.test(attr.name) &&
          /^\s*(javascript|vbscript|data:text)/i.test(attr.value)) {
        bad.push(attr.name + '=' + attr.value);
      }
    }
  }
  return bad;
};

const PAYLOADS = {
  script: '<p>x</p><script>window.__xss = 1</script>',
  'img onerror': '<img src=x onerror="window.__xss = 1">',
  'onclick/onmouseover': '<p onclick="window.__xss = 1" onmouseover="window.__xss = 1">hi</p>',
  'javascript: link': '<a href="javascript:window.__xss = 1">go</a>',
  iframe: '<iframe src="https://www.youtube.com/embed/x"></iframe>',
  'object/embed': '<object data="x.swf"></object><embed src="x.swf">',
  'meta refresh': '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  'style block': '<style>body { display: none }</style><p>hi</p>',
  'svg onload': '<svg onload="window.__xss = 1"><circle r="5"/></svg>',
  'svg script': '<svg><script>window.__xss = 1</script><rect width="5" height="5"/></svg>',
  'svg a javascript': '<svg><a xlink:href="javascript:window.__xss = 1"><text>x</text></a></svg>',
  'form action':
    '<form action="https://evil.test"><button formaction="javascript:1">x</button></form>',
  'data: html link': '<a href="data:text/html,<script>window.__xss=1</script>">x</a>',
  'noscript mXSS': '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">',
  'math mXSS': '<math><mtext><table><mglyph><style><img src=x onerror=window.__xss=1>',
};

for (const type of ['html', 'svg']) {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    await test(`${type}: ${name} is neutralized`, async () => {
      const { el, env } = await back(payload, type);
      assert.deepEqual(unsafe(el), [], el.innerHTML);
      assert.equal(env.w.__xss, undefined);
    });
  }
}

await test('md: raw html and javascript: links are neutralized', async () => {
  const md = '# Title\n\n[x](javascript:window.__xss=1)\n\n' +
    '<img src=x onerror="window.__xss=1">\n\n<script>window.__xss=1</script>\n\n**bold**';
  const { el } = await back(md, 'md');
  assert.deepEqual(unsafe(el), [], el.innerHTML);
  assert.equal(el.querySelector('h1').textContent, 'Title');
  assert.equal(el.querySelector('strong').textContent, 'bold');
});

await test('html: formatting, style attr, media, tables, details, data: images stay', async () => {
  const html = '<h2>桜</h2><p style="color:red"><em>a</em> <strong>b</strong></p>' +
    '<img src="https://drive.google.com/thumbnail?id=X&sz=w1000" style="max-width:100%">' +
    '<img src="data:image/png;base64,iVBORw0KGgo=">' +
    '<table><tr><td>1</td></tr></table><details><summary>s</summary>d</details>' +
    '<ruby>漢<rt>kan</rt></ruby><video src="https://example.test/v.mp4" controls></video>' +
    '<audio src="https://example.test/a.mp3" controls></audio>';
  const { el } = await back(html, 'html');
  assert.equal(el.querySelector('p').getAttribute('style'), 'color:red');
  assert.match(el.querySelector('img').getAttribute('src'), /^https:\/\/drive\.google\.com/);
  assert.match(el.querySelectorAll('img')[1].getAttribute('src'), /^data:image\/png/);
  for (const tag of ['table', 'details', 'summary', 'ruby', 'rt', 'video', 'audio', 'h2']) {
    assert.ok(el.querySelector(tag), `<${tag}> kept`);
  }
});

await test('svg: shapes, viewBox and internal references stay; style blocks go', async () => {
  const svg = '<svg viewBox="0 0 10 10" style="max-width:100%"><style>rect{fill:red}</style>' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
    '<rect width="4" height="4" fill="url(#g)"/><circle cx="5" cy="5" r="2"/>' +
    '<path d="M0 0L5 5"/><text x="1" y="9">hi</text></svg>';
  const { el } = await back(svg, 'svg');
  const root = el.querySelector('svg');
  assert.equal(root.getAttribute('viewBox'), '0 0 10 10');
  for (const tag of ['rect', 'circle', 'path', 'text', 'linearGradient']) {
    assert.ok(el.querySelector(tag), `<${tag}> kept`);
  }
  assert.equal(el.querySelector('style'), null);
  assert.equal(el.querySelector('#back-type-badge'), null);
});

await test('links open in a new tab with noopener; links without href are untouched', async () => {
  const { el } = await back('<a href="https://example.test">x</a><a name="n">y</a>', 'html');
  const [a, b] = el.querySelectorAll('a');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(b.getAttribute('target'), null);
  const md = await back('[x](https://example.test)', 'md');
  assert.equal(md.el.querySelector('a').getAttribute('target'), '_blank');
});

await test('text and unknown types are escaped, never parsed', async () => {
  for (const type of ['text', 'whatever', '', undefined]) {
    const { el } = await back('<b onclick="1">x</b> & <script>1</script>', type);
    assert.equal(el.querySelector('b'), null);
    assert.equal(el.querySelector('script'), null);
    assert.match(el.textContent, /<b onclick="1">x<\/b> & <script>1<\/script>/);
  }
});

await test('type badge shows the type; svg is its own type', async () => {
  const { env } = await back('<svg><circle r="1"/></svg>', 'SVG ');
  assert.equal(env.txt('back-type-badge'), 'svg');
});

await test('no sanitizer: html, md and svg show their source with a notice', async () => {
  for (const type of ['html', 'md', 'svg']) {
    const source = '<img src=x onerror="window.__xss=1">';
    const { el, env } = await back(source, type, { noSanitizer: true });
    assert.equal(el.querySelector('img'), null, type);
    assert.match(el.querySelector('.back-note').textContent, /Sanitizer not loaded/);
    assert.match(el.textContent, /<img src=x onerror/);
    assert.equal(env.w.__xss, undefined);
  }
});

await test('no markdown renderer: md shows its source with a notice', async () => {
  const env = boot({ cards: [card('1')] });
  await env.start();
  env.w.marked = undefined;
  env.w.renderBack({ back_type: 'md', back_content: '**x**' });
  assert.match(env.$('back-content').textContent, /Markdown renderer not loaded[\s\S]*\*\*x\*\*/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
