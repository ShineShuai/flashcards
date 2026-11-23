// Run: node test/ui/clock.test.mjs   (needs: npm install --no-save jsdom dompurify marked)
// The harness clock: the page sees NOW (or `now`), not the wall clock, so no test depends on
// the hour of the day or on a DST change. Plus a tripwire: a test that makes fixtures from the
// wall clock fails here, not at 02:30 on some CI run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, NOW, sleep, until } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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
const near = (a, b, ms = 3000) => Math.abs(a - b) < ms;

await test('the page starts at NOW and its clock runs on', async () => {
  const env = boot({});
  assert.ok(near(env.w.eval('Date.now()'), NOW.getTime()));
  assert.ok(near(env.w.eval('new Date().getTime()'), NOW.getTime()));
  const before = env.w.eval('Date.now()');
  await sleep(40);
  const after = env.w.eval('Date.now()');
  assert.ok(after - before >= 30 && after - before < 1000, `ticked ${after - before} ms`);
  assert.equal(typeof env.w.eval('Date()'), 'string');
  assert.ok(near(new Date(env.w.eval('Date()')).getTime(), NOW.getTime()));
});

await test('Date otherwise behaves: arguments, instanceof, parse, UTC, subclasses', async () => {
  const { w } = boot({});
  assert.equal(w.eval('new Date(2020, 0, 5, 10).getDate()'), 5);
  assert.equal(w.eval('new Date("2020-01-01T00:00:00Z").getTime()'), 1577836800000);
  assert.equal(w.eval('new Date(0).getTime()'), 0, 'zero is an argument, not "no argument"');
  assert.equal(w.eval('Date.parse("2020-01-01T00:00:00Z")'), 1577836800000);
  assert.equal(w.eval('Date.UTC(2020, 0, 1)'), 1577836800000);
  assert.equal(w.eval('new Date() instanceof Date'), true);
  assert.equal(w.eval('Object.getPrototypeOf(new Date()) === Date.prototype'), true);
  assert.deepEqual(Array.from(w.eval('class X extends Date {}; const x = new X(1000), y = new X(); [x instanceof X, x instanceof Date, x.getTime(), Math.abs(y.getTime() - Date.now()) < 3000]')),
    [true, true, 1000, true]);
  assert.equal(w.eval('JSON.stringify(new Date(86400000))'), '"1970-01-02T00:00:00.000Z"');
});

await test('boot({ now }) takes a Date, a string or a number; env.clock reads and moves it', async () => {
  const at = (v) => boot({ now: v }).w.eval('Date.now()');
  const target = new Date(2026, 6, 1, 3, 15).getTime();
  assert.ok(near(at(new Date(target)), target));
  assert.ok(near(at(target), target));
  assert.ok(near(at(new Date(target).toISOString()), target));
  const env = boot({});
  env.clock.set(new Date(2030, 0, 1));
  assert.ok(near(env.w.eval('Date.now()'), new Date(2030, 0, 1).getTime()));
  env.clock.advance(3600000);
  assert.ok(near(env.w.eval('Date.now()'), new Date(2030, 0, 1).getTime() + 3600000));
  assert.ok(near(env.clock.now().getTime(), env.w.eval('Date.now()'), 50));
});

await test('two pages have two clocks', async () => {
  const a = boot({ now: new Date(2020, 0, 1) });
  const b = boot({ now: new Date(2040, 0, 1) });
  assert.ok(a.w.eval('Date.now()') < b.w.eval('Date.now()'));
  a.clock.advance(1e12);
  assert.ok(near(b.w.eval('Date.now()'), new Date(2040, 0, 1).getTime()));
});

await test('the app reads the pinned clock: the date on the home screen, the study day', async () => {
  const env = boot({ now: new Date(2026, 0, 5, 10, 0) });
  await until(() => env.shown('s-home'));
  env.w.showHome();
  assert.match(env.txt('home-date'), /Monday|January|2026/);
  const day = (h, m = 0, d = 5) => env.w.studyDay(new env.w.Date(2026, 0, d, h, m));
  assert.equal(day(3, 59), day(12, 0, 4), '03:59 is still yesterday');
  assert.equal(day(4, 0), day(12, 0, 5), 'the new day starts at 04:00');
  env.clock.set(new Date(2026, 0, 5, 3, 0));
  assert.equal(env.w.studyDay(new env.w.Date()), day(12, 0, 4), 'the page now, 03:00 on the 5th');
  env.clock.set(new Date(2026, 0, 5, 4, 30));
  assert.equal(env.w.studyDay(new env.w.Date()), day(12, 0, 5));
});

await test('FC_NOW moves NOW (local time); a value that is no date is an error', async () => {
  const run = (value) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { NOW } from ${JSON.stringify('file://' + path.join(here, 'harness.mjs'))}; console.log(NOW.toISOString());`],
  { env: { ...process.env, TZ: 'UTC', FC_NOW: value }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(run('2026-11-23T02:30:00').trim(), '2026-11-23T02:30:00.000Z');
  assert.throws(() => run('tomorrow-ish'), /FC_NOW is not a date/);
});

await test('tripwire: no UI test makes fixtures from the wall clock', async () => {
  const bad = [];
  for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs'))) {
    if (file === 'clock.test.mjs') {
      continue;
    }
    fs.readFileSync(path.join(here, file), 'utf8').split('\n').forEach((line, i) => {
      const wall = /\bDate\.now\(\)|new Date\(\)/.test(line);
      const inPage = /\.eval\(/.test(line);                      // runs in the page: its clock
      if (wall && !inPage && !/wall clock ok/.test(line)) {
        bad.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, [], 'use NOW (or new Date(NOW)) from harness.mjs, or say "wall clock ok" where real time is meant');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
