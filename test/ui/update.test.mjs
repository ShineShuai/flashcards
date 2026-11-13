// Run: node test/ui/update.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Version display and self-update: when the server reports another version the app
// reloads (top window) once it is idle, else shows a Reload bar; no reload loops. The
// frame itself is never reloaded: its address is not a page, so that is a blank page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, card, sleep, until } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const NEWER = '2099.01.01.1';
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

// A booted app on Home whose top-window navigation is recorded instead of performed.
async function onHome(options = {}) {
  const env = boot({ cards: [card('1')], ...options });
  await until(() => env.shown('s-home'));
  await until(() => env.ver.calls >= 1);           // the check made when Home opened ...
  await sleep(10);                                 // ... and its answer, before the test acts
  env.w.eval('window.__nav = []; navigateTop = (u) => { window.__nav.push(u); }');
  env.w.eval('updateBannerDelayMs = 25');
  env.nav = () => Array.from(env.w.__nav);
  env.banner = () => env.shown('update-banner');
  // the server now runs another version; ask again
  env.deploy = async (version) => {
    env.ver.version = version;
    env.w.eval('versionCheckedAt = 0');
    env.w.maybeCheckVersion();
    await sleep(10);
  };
  env.checks = () => env.ver.calls;
  return env;
}

await test('the version is shown at the bottom of Home', async () => {
  const env = await onHome();
  assert.match(env.txt('app-version'), /^v\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

await test('same version: no bar, no reload, and the loop guard is cleared', async () => {
  const env = await onHome({ storage: { 'fc-update-tried': NEWER } });
  await sleep(40);
  assert.equal(env.banner(), false);
  assert.deepEqual(env.nav(), []);
  assert.equal(env.w.localStorage.getItem('fc-update-tried'), '');
});

await test('idle on Home: reloads the top window once, with the bar as a fallback', async () => {
  const env = await onHome();
  env.w.eval('updateBannerDelayMs = 400');           // long against the 10 ms the check takes
  await env.deploy(NEWER);
  assert.deepEqual(env.nav(), ['https://script.google.test/macros/s/ID/exec']);
  assert.equal(env.w.localStorage.getItem('fc-update-tried'), NEWER);
  assert.equal(env.banner(), false, 'not yet: the reload may still succeed');
  await sleep(450);
  assert.equal(env.banner(), true, 'still here after the delay: navigation was blocked');
  assert.equal(env.txt('update-version'), NEWER);
  assert.equal(env.shown('update-hint'), true, 'and it says to reload the tab by hand');
});

await test('one automatic try per version: a mismatch that survives a reload: bar', async () => {
  const env = await onHome({
    versionServer: { version: NEWER }, storage: { 'fc-update-tried': NEWER },
  });
  await sleep(20);
  assert.deepEqual(env.nav(), []);
  assert.equal(env.banner(), true);
});

await test('during a review: no reload, the bar shows at once; the button reloads', async () => {
  const env = await onHome();
  env.w.startSession();
  await until(() => env.shown('s-session'));
  await env.deploy(NEWER);
  assert.deepEqual(env.nav(), []);
  assert.equal(env.banner(), true);
  assert.equal(env.shown('update-hint'), false, 'no hint before the button was tried');
  env.$('update-btn').click();
  assert.deepEqual(env.nav(), ['https://script.google.test/macros/s/ID/exec']);
  assert.equal(env.shown('update-hint'), true, 'if the tap did not navigate, the hint is there');
});

await test('back on Home after a review: the waiting update is applied', async () => {
  const env = await onHome();
  env.w.startSession();
  await until(() => env.shown('s-session'));
  await env.deploy(NEWER);
  assert.deepEqual(env.nav(), []);
  env.w.showHome();
  await until(() => env.shown('s-home'));
  await sleep(10);
  assert.equal(env.nav().length, 1);
});

await test('ratings waiting to be saved, or the docs open: bar only', async () => {
  const env = await onHome();
  env.w.eval("saveQueue.push({ id: 'x', fsrs: {}, meta: {} })");
  await env.deploy(NEWER);
  assert.deepEqual(env.nav(), []);
  assert.equal(env.banner(), true);
  const env2 = await onHome();
  env2.w.openDocs();
  await until(() => env2.shown('docs-modal'));
  await env2.deploy(NEWER);
  assert.deepEqual(env2.nav(), []);
  assert.equal(env2.banner(), true);
});

await test('an unreachable server is ignored; nothing is shown', async () => {
  const env = await onHome();
  env.ver.fail = true;
  env.w.eval('versionCheckedAt = 0');
  env.w.maybeCheckVersion();
  await sleep(30);
  assert.equal(env.banner(), false);
  assert.deepEqual(env.nav(), []);
});

await test('checks: on Home, on tab return (max once a minute), never when hidden', async () => {
  const env = await onHome();
  await sleep(10);
  assert.equal(env.checks(), 1, 'Home opened');
  const back = async () => {
    env.w.document.dispatchEvent(new env.w.Event('visibilitychange'));
    await sleep(10);                                // the call is dispatched a tick later
  };
  await back();
  assert.equal(env.checks(), 1, 'checked a moment ago');
  env.w.eval('versionCheckedAt = Date.now() - 61000');
  await back();
  assert.equal(env.checks(), 2);
  env.w.eval('versionCheckedAt = 0');
  Object.defineProperty(env.w.document, 'hidden', { get: () => true });
  await back();
  assert.equal(env.checks(), 2, 'a hidden tab does not check');
});

await test('the server URL is used; without one nothing is navigated and the hint shows', async () => {
  const env = await onHome({ versionServer: { url: '' } });
  env.w.eval('updateBannerDelayMs = 400');
  await env.deploy(NEWER);
  assert.deepEqual(env.nav(), [], 'no address to go to, and never a reload of the frame');
  assert.equal(env.shown('update-hint'), true);
  await sleep(450);
  assert.equal(env.banner(), true);
  env.$('update-btn').click();
  assert.deepEqual(env.nav(), []);
  assert.equal(env.banner(), true, 'the bar stays: the person reloads the tab');
});

await test('the page never reloads its own frame (the code has no location.reload)', async () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.equal(/location\.reload\s*\(/.test(src), false);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
