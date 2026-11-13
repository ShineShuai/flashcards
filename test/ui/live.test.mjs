// Run: node test/ui/live.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// back_type "live": scripts and iframes run in an isolated, sandboxed frame.
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

const CONTENT = '<h2 id="t">Title</h2><style>h2{color:red}</style>' +
  '<script>document.getElementById("t").textContent = "run"; var s = "</s" + "cript>";</script>' +
  '<iframe src="https://www.youtube.com/embed/x"></iframe> "quotes" & <entities> \'single\'';

async function back(content, extra = {}) {
  const env = boot({ cards: [card('1', 'a;b;c', { back_content: content, back_type: 'live' })],
    ...extra });
  await env.start();
  env.w.flipCard();
  await sleep(5);
  const frame = () => env.w.document.querySelector('iframe.live-frame');
  return { env, el: env.$('back-content'), frame };
}
const message = (env, frame, data, source) => env.w.dispatchEvent(
  new env.w.MessageEvent('message', { data, source: source || frame.contentWindow }));

await test('a live card is one sandboxed iframe: scripts yes, the app no', async () => {
  const { el, frame } = await back(CONTENT);
  assert.equal(el.children.length, 1);
  const f = frame();
  assert.ok(f);
  const flags = f.getAttribute('sandbox').split(/\s+/).sort();
  assert.deepEqual(flags, ['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts']);
  assert.equal(f.getAttribute('title'), 'Card content');
});

await test('the card is not sanitized, and nothing of it is in the app document', async () => {
  const { env, el, frame } = await back(CONTENT);
  const doc = frame().getAttribute('srcdoc');
  assert.ok(doc.includes(CONTENT), 'content verbatim: script, style and iframe kept');
  assert.equal(el.querySelectorAll('script, style').length, 0);
  assert.equal(el.querySelectorAll('iframe').length, 1, 'only the sandbox frame');
  assert.equal(env.w.__xss, undefined);
});

await test('frame document: CSP and height reporter first, the card last', async () => {
  const { env, frame } = await back(CONTENT);
  const doc = frame().getAttribute('srcdoc');
  assert.equal(doc, env.w.liveDocument(CONTENT));
  const csp = doc.indexOf('Content-Security-Policy');
  const reporter = doc.indexOf('fcLive');
  assert.ok(csp > 0 && csp < reporter && reporter < doc.indexOf('<h2 id="t">'));
  assert.ok(doc.indexOf('<h2 id="t">') < doc.indexOf('</body>'));
  for (const rule of ["connect-src 'none'", "form-action 'none'", "base-uri 'none'",
    "default-src 'none'", 'frame-src https:', 'img-src https: data: blob:']) {
    assert.ok(doc.includes(rule), rule);
  }
  assert.equal(/connect-src[^;]*https/.test(doc), false, 'no network calls for the card');
});

await test('escaping: quotes and "</script>" in the card can not break out', async () => {
  const evil = '"><script>window.__xss = 1</script><iframe srcdoc="x" sandbox="';
  const { env, el, frame } = await back(evil);
  assert.equal(el.children.length, 1);
  assert.equal(el.querySelectorAll('script').length, 0);
  assert.equal(frame().getAttribute('sandbox').includes('allow-same-origin'), false);
  assert.ok(frame().getAttribute('srcdoc').includes(evil));
  assert.equal(env.w.__xss, undefined);
});

await test('height: the frame follows its own report, clamped; others are ignored', async () => {
  const { env, frame } = await back(CONTENT);
  const f = frame();
  message(env, f, { fcLive: true, h: 512.2 });
  assert.equal(f.style.height, '513px');
  message(env, f, { fcLive: true, h: 3 });
  assert.equal(f.style.height, '40px');
  message(env, f, { fcLive: true, h: 99999 });
  assert.equal(f.style.height, '4000px');
  message(env, f, { fcLive: true, h: 300 });
  const ignored = [
    [{ fcLive: true, h: 700 }, env.w],                 // not from the frame
    [{ h: 700 }, null], [{ fcLive: false, h: 700 }, null], [{ fcLive: true, h: '700' }, null],
    [{ fcLive: true, h: NaN }, null], [{ fcLive: true, h: Infinity }, null], ['700', null],
    [null, null], [{ fcLive: true }, null],
  ];
  for (const [data, source] of ignored) {
    message(env, f, data, source);
    assert.equal(f.style.height, '300px', JSON.stringify(data));
  }
});

await test('a report from one frame does not resize another', async () => {
  const { env, el, frame } = await back(CONTENT);
  const first = frame();
  const other = env.w.document.createElement('iframe');
  other.className = 'live-frame';
  el.appendChild(other);
  other.style.height = '111px';
  message(env, first, { fcLive: true, h: 400 });
  assert.equal(first.style.height, '400px');
  assert.equal(other.style.height, '111px');
});

await test('a live frame that stays silent gets a notice; one that reports does not', async () => {
  const silent = await back(CONTENT);
  silent.env.w.eval('liveWaitMs = 30');
  silent.env.w.renderBack({ back_type: 'live', back_content: CONTENT });   // again, short wait
  await sleep(5);
  assert.equal(silent.el.querySelector('.back-note'), null, 'not yet');
  await sleep(60);
  assert.match(silent.el.querySelector('.back-note').textContent, /did not start/);
  const live = await back(CONTENT);
  live.env.w.eval('liveWaitMs = 30');
  live.env.w.renderBack({ back_type: 'live', back_content: CONTENT });
  message(live.env, live.frame(), { fcLive: true, h: 200 });
  await sleep(60);
  assert.equal(live.el.querySelector('.back-note'), null, 'a frame that reported is fine');
  const gone = await back(CONTENT);
  gone.env.w.eval('liveWaitMs = 30');
  gone.env.w.renderBack({ back_type: 'live', back_content: CONTENT });
  gone.env.w.renderBack({ back_type: 'text', back_content: 'next' });   // the frame is gone
  await sleep(60);
  assert.equal(gone.el.querySelector('.back-note'), null, 'no notice for a removed frame');
});

await test('live needs neither the sanitizer nor the markdown renderer', async () => {
  const { frame } = await back(CONTENT, { noSanitizer: true });
  assert.ok(frame());
  assert.ok(frame().getAttribute('srcdoc').includes(CONTENT));
});

await test('the type badge says live; html cards still lose their scripts', async () => {
  const { env } = await back(CONTENT);
  assert.equal(env.txt('back-type-badge'), 'live');
  const html = boot({ cards: [card('2', 'a;b;c', { back_content: '<p>x</p><script>1</script>',
    back_type: 'html' })] });
  await html.start();
  html.w.flipCard();
  await sleep(5);
  assert.equal(html.$('back-content').querySelector('script'), null);
  assert.equal(html.$('back-content').querySelector('iframe'), null);
});

await test('an empty live card still gets a frame of the default height', async () => {
  const { frame } = await back('');
  assert.ok(frame());
  assert.equal(frame().style.height, '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
