// Run: node test/config.mjs   (no dependencies)
// Config.gs DEFAULTS must equal the FSRS block of index.html and the py-fsrs
// reference, and must pass their own validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fsrs-golden.json'), 'utf8'));

const cfg = vm.runInContext(
  `${read('Config.gs')}\n({ DEFAULTS, LIMITS, checkSetting_ })`, vm.createContext({}));
const block = read('index.html').match(/\/\/ @fsrs-begin([\s\S]*?)\/\/ @fsrs-end/)[1];
const app = vm.runInContext(
  `${block}\n({ W, DESIRED_RETENTION, MAX_INTERVAL })`, vm.createContext({ Math }));

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
};
const plain = (x) => JSON.parse(JSON.stringify(x));

test('DEFAULTS equal the FSRS block of index.html', () => {
  assert.deepEqual(plain(cfg.DEFAULTS.w), plain(app.W));
  assert.equal(cfg.DEFAULTS.retention, app.DESIRED_RETENTION);
  assert.equal(cfg.DEFAULTS.max_interval, app.MAX_INTERVAL);
});

test('DEFAULTS.w equals the py-fsrs defaults of the golden vectors', () => {
  assert.deepEqual(plain(cfg.DEFAULTS.w), golden.sets[0].parameters);
});

test('LIMITS.w equal the py-fsrs parameter bounds', () => {
  assert.deepEqual(plain(cfg.LIMITS.w_lo), golden.bounds.lo);
  assert.deepEqual(plain(cfg.LIMITS.w_hi), golden.bounds.hi);
});

test('DEFAULTS pass their own validation', () => {
  for (const key of Object.keys(cfg.DEFAULTS)) {
    assert.equal(cfg.checkSetting_(key, plain(cfg.DEFAULTS[key])), '', key);
  }
  assert.equal(cfg.LIMITS.w_lo.length, cfg.DEFAULTS.w.length);
  assert.equal(cfg.LIMITS.w_hi.length, cfg.DEFAULTS.w.length);
});

test('index.html has the same scheduling defaults and limits as Config.gs', () => {
  const html = read('index.html');
  const limits = vm.runInContext(
    '(' + html.match(/const SETTING_LIMITS = (\{[\s\S]*?\});/)[1] + ')', vm.createContext({}));
  assert.deepEqual(plain(limits), {
    retention: plain(cfg.LIMITS.retention), max_interval: plain(cfg.LIMITS.max_interval),
    new_per_day: plain(cfg.LIMITS.new_per_day),
  });
  const dflt = Number(html.match(/const DEFAULT_NEW_PER_DAY\s*=\s*(\d+);/)[1]);
  assert.equal(dflt, cfg.DEFAULTS.new_per_day);
});

test('validation rejects NaN, strings, wrong types and lengths', () => {
  const w = plain(cfg.DEFAULTS.w);
  assert.notEqual(cfg.checkSetting_('w', w.map(String)), '');
  assert.notEqual(cfg.checkSetting_('w', [...w.slice(1), NaN]), '');
  assert.notEqual(cfg.checkSetting_('w', [...w, 1]), '');
  assert.notEqual(cfg.checkSetting_('retention', '0.9'), '');
  assert.notEqual(cfg.checkSetting_('retention', Infinity), '');
  assert.notEqual(cfg.checkSetting_('max_interval', 29), '');
  assert.equal(cfg.checkSetting_('max_interval', 3650), '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
