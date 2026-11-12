// Run: node test/ui/settings.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// Scheduling form on the settings screen, and the new-card limit on Home.
import assert from 'node:assert/strict';
import { boot, card, sleep, until } from './harness.mjs';

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
const plain = (x) => JSON.parse(JSON.stringify(x));
const BASE_W = plain(boot({ cards: [] }).w.eval('W.slice()'));
const DEFAULTS = { retention: 0.94, max_interval: 365, new_per_day: 0 };

// A server that keeps the settings in `cfg`, like Config.gs: null removes an override.
function server(start = {}) {
  const cfg = { w: BASE_W, ...DEFAULTS, overridden: [], rejected: [], ...start };
  return {
    cfg,
    save(patch) {
      for (const [key, value] of Object.entries(plain(patch))) {
        cfg[key] = value === null ? DEFAULTS[key] : value;
        const rest = cfg.overridden.filter((k) => k !== key);
        cfg.overridden = value === null ? rest : rest.concat(key);
      }
      return { ok: true, config: plain(cfg) };
    },
  };
}
async function open(start, extra = {}) {
  const srv = server(start);
  const env = boot({ cards: [card('1')], config: () => plain(srv.cfg), saveSettings: srv.save,
    ...extra });
  await until(() => env.shown('s-home'));
  env.$('weightsBtn').click();
  await until(() => env.shown('s-weights'));
  env.srv_ = srv;
  return env;
}
const form = (env) => ({ retention: env.$('set-retention').value, max: env.$('set-max').value,
  fresh: env.$('set-new').value });
const fill = (env, retention, max, fresh) => {
  env.$('set-retention').value = String(retention);
  env.$('set-max').value = String(max);
  env.$('set-new').value = String(fresh);
};
const save = async (env) => {
  env.$('set-save').click();
  await sleep(10);
};
const calls = (env) => plain(env.srv.settingsCalls.map((c) => c.patch));

await test('the form shows the settings in force', async () => {
  const env = await open({ retention: 0.9, max_interval: 180, new_per_day: 15,
    overridden: ['retention', 'max_interval', 'new_per_day'] });
  assert.deepEqual(form(env), { retention: '0.9', max: '180', fresh: '15' });
  const plainEnv = await open();
  assert.deepEqual(form(plainEnv), { retention: '0.94', max: '365', fresh: '0' });
});

await test('Save sends only what changed; the app uses it at once', async () => {
  const env = await open();
  fill(env, 0.9, 365, 20);
  await save(env);
  assert.deepEqual(calls(env), [{ retention: 0.9, new_per_day: 20 }]);
  assert.equal(env.srv.settingsCalls[0].meta.source, 'app');
  assert.match(env.txt('set-result'), /^Saved\./);
  assert.equal(env.w.eval('DESIRED_RETENTION'), 0.9);
  assert.equal(env.w.eval('MAX_INTERVAL'), 365);
  assert.deepEqual(form(env), { retention: '0.9', max: '365', fresh: '20' });
  assert.equal(env.$('set-save').disabled, false);
  assert.ok(env.w.eval('intervalDays(20)') === 20, 'at 0.90 the interval equals the stability');
});

await test('a value equal to the default is sent as null (no override is stored)', async () => {
  const env = await open({ retention: 0.9, overridden: ['retention'] });
  fill(env, 0.94, 365, 0);
  await save(env);
  assert.deepEqual(calls(env), [{ retention: null }]);
  assert.equal(env.w.eval('DESIRED_RETENTION'), 0.94);
  const fresh = await open();
  fill(fresh, 365 > 0 ? 0.94 : 0, 365, 0);
  await save(fresh);
  assert.equal(fresh.srv.settingsCalls.length, 0, 'default over default: nothing to save');
  assert.equal(fresh.txt('set-result'), 'Nothing changed.');
});

await test('bad input is explained field by field and nothing is sent', async () => {
  const env = await open();
  const bad = [
    [['', 365, 0], /^Desired retention must be a number from 0\.8 to 0\.97\.$/],
    [[0.5, 365, 0], /Desired retention/],
    [[0.99, 365, 0], /Desired retention/],
    [[0.9, 12, 0], /^Maximum interval must be a whole number from 30 to 3650\.$/],
    [[0.9, 365.5, 0], /Maximum interval/],
    [[0.9, 5000, 0], /Maximum interval/],
    [[0.9, 365, -1], /^New cards per day must be a whole number from 0 to 999\.$/],
    [[0.9, 365, 2.5], /New cards per day/],
    [[0.9, 365, 1000], /New cards per day/],
    [['abc', 365, 0], /Desired retention/],
  ];
  for (const [[r, m, n], message] of bad) {
    fill(env, r, m, n);
    await save(env);
    assert.match(env.txt('set-result'), message, JSON.stringify([r, m, n]));
  }
  assert.equal(env.srv.settingsCalls.length, 0);
});

await test('Back to the defaults clears only the overrides that exist', async () => {
  const env = await open({ retention: 0.9, new_per_day: 10,
    overridden: ['retention', 'new_per_day'] });
  env.$('set-reset').click();
  await sleep(10);
  assert.deepEqual(calls(env), [{ retention: null, new_per_day: null }]);
  assert.deepEqual(form(env), { retention: '0.94', max: '365', fresh: '0' });
  env.$('set-reset').click();
  await sleep(10);
  assert.equal(env.srv.settingsCalls.length, 1);
  assert.equal(env.txt('set-result'), 'Already the defaults.');
});

await test('a rejection or a failure is shown; the button works again', async () => {
  const reject = () => ({ ok: false, errors: { retention: 'no' } });
  const rejecting = await open({}, { saveSettings: reject });
  fill(rejecting, 0.9, 365, 0);
  await save(rejecting);
  assert.match(rejecting.txt('set-result'), /^Rejected: .*retention/);
  assert.equal(rejecting.w.eval('DESIRED_RETENTION'), 0.94);
  assert.equal(rejecting.$('set-save').disabled, false);
  const failing = await open({}, { saveSettings: () => new Error('quota') });
  fill(failing, 0.9, 365, 0);
  await save(failing);
  assert.equal(failing.txt('set-result'), 'Could not save: quota');
  assert.equal(failing.$('set-save').disabled, false);
});

await test('re-entering the screen shows the saved values and no old message', async () => {
  const env = await open();
  fill(env, 0.9, 200, 5);
  await save(env);
  env.w.showHome();
  await until(() => env.shown('s-home'));
  env.$('weightsBtn').click();
  await until(() => env.shown('s-weights'));
  assert.deepEqual(form(env), { retention: '0.9', max: '200', fresh: '5' });
  assert.equal(env.txt('set-result'), '');
});

await test('Home: "New · 3/20 today" with a limit, plain "New" without one', async () => {
  const label = async (newLimit) => {
    const env = boot({ cards: [card('1')], newLimit });
    await until(() => env.shown('s-home'));
    return env.txt('stat-new-label');
  };
  assert.equal(await label({ limit: 20, introduced: 3, remaining: 17 }), 'New · 3/20 today');
  assert.equal(await label({ limit: 5, introduced: 5, remaining: 0 }), 'New · 5/5 today');
  assert.equal(await label({ limit: 0, introduced: 0, remaining: 0 }), 'New');
  assert.equal(await label(undefined), 'New');
});

await test('Start after the cache expired asks the server again, with the offset', async () => {
  const env = boot({ cards: [card('1')] });
  await until(() => env.shown('s-home'));
  env.w.eval('homeAt = 0');
  env.w.startSession();
  await until(() => env.srv.dueArgs.length === 1);
  assert.deepEqual(plain(env.srv.dueArgs[0]), [-new Date().getTimezoneOffset()]);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
