// Run: node test/ui/config.test.mjs   (needs: npm install --no-save jsdom)
// The config sent with bootstrap replaces the built-in FSRS constants.
import assert from 'node:assert/strict';
import { boot, card, until } from './harness.mjs';

const homeReady = (env) => until(() => env.shown('s-home'));
const defaults = (env) => ({
  w: env.w.eval('W').slice(),
  retention: env.w.eval('DESIRED_RETENTION'),
  max_interval: env.w.eval('MAX_INTERVAL'),
});

// no config (older server): built-in values stay
{
  const env = boot({ cards: [card('1')] });
  await homeReady(env);
  assert.equal(env.w.eval('DESIRED_RETENTION'), 0.94);
  assert.equal(env.w.eval('MAX_INTERVAL'), 365);
  assert.equal(env.w.eval('W.length'), 19);
}

// a valid config applies: lower retention and a cap change the intervals
{
  const probe = boot({ cards: [card('1')] });
  await homeReady(probe);
  const base = defaults(probe);
  const long94 = probe.w.eval('intervalDays(200)');
  const env = boot({
    cards: [card('1')],
    config: { ...base, retention: 0.9, max_interval: 60, overridden: [], rejected: [] },
  });
  await homeReady(env);
  assert.equal(env.w.eval('DESIRED_RETENTION'), 0.9);
  assert.equal(env.w.eval('MAX_INTERVAL'), 60);
  assert.ok(env.w.eval('intervalDays(200)') <= 60);
  assert.ok(long94 > 60, 'the default interval for S=200 exceeds the cap');
  const [low, high] = [env, probe].map((e) => e.w.eval('intervalDays(20)'));
  assert.ok(low > high, 'lower retention, longer interval');
}

// malformed values are ignored one by one
{
  const base = defaults(boot({ cards: [card('1')] }));
  const env = boot({
    cards: [card('1')],
    config: { w: base.w.slice(1), retention: 'high', max_interval: NaN, rejected: [] },
  });
  await homeReady(env);
  assert.equal(env.w.eval('W.length'), 19);
  assert.equal(env.w.eval('DESIRED_RETENTION'), 0.94);
  assert.equal(env.w.eval('MAX_INTERVAL'), 365);
  // weights of the right length apply
  const w = base.w.map((v, i) => (i === 0 ? 0.5 : v));
  const env2 = boot({ cards: [card('1')], config: { w } });
  await homeReady(env2);
  assert.equal(env2.w.eval('W[0]'), 0.5);
  assert.equal(env2.w.eval('initS(1)'), 0.5);
}

console.log('config ui ok');
process.exit(0);
