// Run: node test/ui/render.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Card content goes through DOMPurify (html, md, svg); nothing active survives. An html
// or svg card with its own <style> is mounted in a shadow root: its CSS is scoped.
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

// What must not be in a card: active content anywhere, and <style> anywhere but in a
// shadow root (a card's own CSS must never reach the app document).
const unsafe = (el) => {
  const bad = [];
  const scan = (root, shadow) => {
    for (const node of root.querySelectorAll('*')) {
      const tag = node.nodeName;
      if (/^(script|iframe|object|embed|meta|link|base|form)$/i.test(tag) ||
          (!shadow && /^style$/i.test(tag))) {
        bad.push('<' + tag + '>');
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
      if (node.shadowRoot) {
        scan(node.shadowRoot, true);
      }
    }
  };
  scan(el, false);
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

const STYLE_PAYLOADS = {
  'style then script': '<style>a{}</style><script>window.__xss = 1</script>',
  'style then img onerror': '<style>p{color:red}</style><img src=x onerror="window.__xss = 1">',
  'style comment trick': '<style><!--</style><img src=x onerror=window.__xss=1>-->',
  'svg style mXSS': '<svg><style><a id="</style><img src=x onerror=window.__xss=1>"></style></svg>',
  'svg foreignObject': '<style>a{}</style><svg><foreignObject><img src=x onerror=window.__xss=1>' +
    '</foreignObject></svg>',
  'style in desc': '<svg><desc><style>a{}</style><img src=x onerror=window.__xss=1></desc></svg>',
};
for (const type of ['html', 'svg']) {
  for (const [name, payload] of Object.entries(STYLE_PAYLOADS)) {
    await test(`${type}: with a style block, ${name} is neutralized`, async () => {
      const { el, env } = await back(payload, type);
      assert.deepEqual(unsafe(el), []);
      const host = el.querySelector('.fc-styled');
      const html = host ? host.shadowRoot.innerHTML : el.innerHTML;
      assert.equal(/onerror|onload/i.test(html), false, html);
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

await test('svg: shapes, viewBox and internal references stay; its style block is scoped', async () => {
  const svg = '<svg viewBox="0 0 10 10" style="max-width:100%"><style>rect{fill:red}</style>' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
    '<rect width="4" height="4" fill="url(#g)"/><circle cx="5" cy="5" r="2"/>' +
    '<path d="M0 0L5 5"/><text x="1" y="9">hi</text></svg>';
  const { el } = await back(svg, 'svg');
  const shadow = el.querySelector('.fc-styled').shadowRoot;
  const root = shadow.querySelector('svg');
  assert.equal(root.getAttribute('viewBox'), '0 0 10 10');
  for (const tag of ['rect', 'circle', 'path', 'text', 'linearGradient']) {
    assert.ok(shadow.querySelector(tag), `<${tag}> kept`);
  }
  assert.equal(el.querySelector('style'), null, 'not in the app document');
  assert.match(shadow.querySelector('svg style').textContent, /rect\s*\{\s*fill:\s*red/);
  assert.equal(el.querySelector('#back-type-badge'), null);
});

// The html card of the sample sheet (an LLM-made page: <head><style>, body rules)
const STYLED = '<head><style>\nbody{font-family:sans-serif;max-width:800px;margin:2rem auto;' +
  'background-color:#f9f9f9}\n.text-container{background-color:#fff;padding:1.5rem}\n' +
  'mark{background-color:#fbf7c2;color:#1e3c5c}\n@media (min-width:1px){html body p{margin:0}}\n' +
  '</style></head>\n<body><div class="text-container"><p>The <mark>flood</mark> came.</p></div></body>';

await test('html with <style>: a shadow root holds card and CSS; body rules become the card root', async () => {
  const { el } = await back(STYLED, 'html');
  const host = el.querySelector('.fc-styled');
  assert.ok(host && host.shadowRoot, 'a shadow root');
  assert.equal(el.children.length, 1);
  assert.equal(el.querySelector('style'), null, 'no style in the app document');
  assert.equal(el.querySelector('mark'), null, 'no card markup in the app document');
  const shadow = host.shadowRoot;
  assert.equal(shadow.querySelector('mark').textContent, 'flood');
  assert.ok(shadow.querySelector('.fc-root .text-container p'), 'inside the card root');
  const css = Array.from(shadow.querySelectorAll('style')).map((s) => s.textContent).join('\n');
  assert.match(css, /\.fc-root\s*\{\s*font-family:sans-serif;max-width:800px/, 'body{} -> root');
  assert.match(css, /\.text-container\s*\{/);
  assert.match(css, /mark\s*\{\s*background-color:#fbf7c2/);
  assert.match(css, /@media \(min-width:1px\)\s*\{\s*\.fc-root p\s*\{/, 'html body p -> root p');
  assert.equal(/(^|\})\s*(html|body)[\s,{>]/.test(css), false, 'no html/body selector left');
});

await test('an image that fails to load gets a notice under it, once; Drive gets the sharing hint', async () => {
  const html = '<p><img src="https://drive.google.com/thumbnail?id=X&sz=w780" alt="d"></p>' +
    '<img src="https://e.test/a.png"><img src="data:image/png;base64,AA">';
  const { el, env } = await back(html, 'html');
  const [drive, other, inline] = el.querySelectorAll('img');
  const fail = (img) => img.dispatchEvent(new env.w.Event('error'));   // does not bubble
  assert.equal(el.querySelector('.back-note'), null, 'nothing while images load');
  fail(drive);
  fail(drive);                                                        // once per image
  fail(other);
  fail(inline);
  assert.equal(el.querySelectorAll('.back-note').length, 3);
  assert.match(drive.nextElementSibling.textContent,
    /^Image did not load: drive\.google\.com\/thumbnail\?id=X&sz=w780 \(.*"Anyone with the link".*private window/);
  assert.match(other.nextElementSibling.textContent,
    /^Image did not load: e\.test\/a\.png \(check the address/);
  assert.match(inline.nextElementSibling.textContent, /^Image did not load: a data: address/);
  env.w.renderBack({ back_type: 'html', back_content: '<img src="https://e.test/b.png">' });
  fail(el.querySelector('img'));                                      // a later card: one listener
  assert.equal(el.querySelectorAll('.back-note').length, 1);
});

await test('the same notice in a styled card (inside its shadow root)', async () => {
  const { el, env } = await back('<style>p{color:red}</style><img src="https://e.test/a.png">', 'html');
  const root = el.querySelector('.fc-styled').shadowRoot;
  root.querySelector('img').dispatchEvent(new env.w.Event('error'));
  assert.match(root.querySelector('.back-note').textContent, /^Image did not load: e\.test\/a\.png/);
  assert.equal(el.querySelector('.back-note'), null, 'not in the app document');
});

await test('html without <style> stays in the app document as before', async () => {
  const { el } = await back('<p>x <mark>y</mark></p>', 'html');
  assert.equal(el.querySelector('.fc-styled'), null);
  assert.equal(el.querySelector('mark').textContent, 'y');
});

await test('styled cards: no sanitizer shows the source; the next card replaces the host', async () => {
  const none = await back(STYLED, 'html', { noSanitizer: true });
  assert.equal(none.el.querySelector('.fc-styled'), null);
  assert.match(none.el.querySelector('.back-note').textContent, /Sanitizer not loaded/);
  const { el, env } = await back(STYLED, 'html');
  env.w.renderBack({ back_type: 'text', back_content: 'plain' });
  assert.equal(el.querySelector('.fc-styled'), null);
  assert.equal(el.textContent.trim(), 'plain');
});

await test('scopeCss: only rule preludes change; names that merely contain body stay', async () => {
  const { env } = await back('x', 'text');
  const css = env.w.scopeCss.bind(env.w);
  const cases = [
    ['body{a:b}', '.r{a:b}'], ['html,body{m:0}', '.r,.r{m:0}'], ['html body p{x:y}', '.r p{x:y}'],
    [':root{--a:1}', '.r{--a:1}'], ['html > body > div{x:y}', '.r > div{x:y}'],
    ['body .x, .y body{a:b}', '.r .x, .y .r{a:b}'],
    ['@media (min-width:1px){body p{a:b}}', '@media (min-width:1px){.r p{a:b}}'],
    ['.body{a:b} #html{c:d} bodyx{e:f} a-body{g:h}', '.body{a:b} #html{c:d} bodyx{e:f} a-body{g:h}'],
    ['body::before{content:"body"}', '.r::before{content:"body"}'],
    ['.a{background:url(body.png)}', '.a{background:url(body.png)}'],
    ['@keyframes k{from{a:b}to{a:c}}', '@keyframes k{from{a:b}to{a:c}}'],
  ];
  for (const [input, want] of cases) {
    assert.equal(css(input, '.r'), want, input);
  }
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
