// Run: node test/devpush.mjs   (no dependencies)
// tools/dev-push.mjs with a fake clasp that records what it is asked and what folder it sees:
// the files pushed, the dev stamp in the copy only, the target and its confirmation, failures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headUrl, parseClaspignore, stampVersion } from '../tools/dev-push.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'dev-push.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-push-'));
const log = path.join(tmp, 'calls.jsonl');
const out = path.join(tmp, 'build');
const fake = path.join(tmp, 'clasp');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const text = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
const arg = process.argv[2];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.').sort(),
  clasp: JSON.parse(text('.clasp.json') || 'null'),
  version: (text('Version.gs').match(/APP_VERSION = '([^']*)'/) || [])[1],
}) + '\\n');
if (arg === 'deployments') {
  console.log('2 Deployments.\\n- AKfycbxHEADHEADHEADHEAD00 @HEAD' +
    '\\n- AKfycbxPRODPRODPRODPROD11 @17 - x');
}
process.exit(arg === 'push' && process.env.FAKE_FAIL ? 3 : 0);
`);
fs.chmodSync(fake, 0o755);
const devConfig = path.join(tmp, 'dev.json');
const prodConfig = path.join(tmp, 'prod.json');
fs.writeFileSync(devConfig, '{"scriptId": "DEV-SCRIPT"}');
fs.writeFileSync(prodConfig, '{"scriptId": "PROD-SCRIPT", "rootDir": "."}');

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)) : []);
function run(args, env = {}) {
  fs.rmSync(log, { force: true });
  const r = spawnSync(process.execPath, [tool, ...args, '--out', out], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    env: { ...process.env, CLASP: fake, FAKE_LOG: log, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: calls() };
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message.split('\n').join('\n     '));
  }
}

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pushed = parseClaspignore(read('.claspignore'));
const before = Object.fromEntries(pushed.map((f) => [f, read(f)]));

test('parseClaspignore lists the whitelisted files', () => {
  assert.deepEqual(parseClaspignore('# c\n**/**\n!Code.gs\n!index.html\n.clasp.json\n'),
    ['Code.gs', 'index.html']);
  assert.ok(pushed.includes('Code.gs') && pushed.includes('index.html'));
  assert.ok(!pushed.includes('.clasp.json'));
});

test('stampVersion changes both version lines, and only those', () => {
  const files = { 'Version.gs': "// c\nconst APP_VERSION = '1.2';\nconst H = 'x';\n",
    'index.html': "a\nconst APP_VERSION = '1.2';\nb", 'Code.gs': 'x' };
  const out2 = stampVersion(files, '260101000000');
  const line = "const APP_VERSION = '1.2-dev.260101000000';";
  assert.equal(out2['Version.gs'], `// c\n${line}\nconst H = 'x';\n`);
  assert.equal(out2['index.html'], `a\n${line}\nb`);
  assert.equal(out2['Code.gs'], 'x');
  assert.throws(() => stampVersion({ ...files, 'index.html': "const APP_VERSION = '1.3';" }, 's'),
    /differ/);
  assert.throws(() => stampVersion({ ...files, 'Version.gs': '' }, 's'), /not found/);
});

test('headUrl reads the @HEAD deployment', () => {
  assert.equal(headUrl('- AKfycbxHEADHEADHEADHEAD00 @HEAD\n- AKfycbxPRODPRODPRODPROD11 @17'),
    'https://script.google.com/macros/s/AKfycbxHEADHEADHEADHEAD00/dev');
  assert.equal(headUrl('- AKfycbxPRODPRODPRODPROD11 @17'), '');
});

test('dev target: pushes a stamped copy of the whitelisted files, repo untouched', () => {
  const r = run(['--config', devConfig]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.map((c) => c.args), [['push', '--force'], ['deployments']]);
  const [push] = r.calls;
  assert.equal(push.cwd, fs.realpathSync(out));
  assert.deepEqual(push.clasp, { scriptId: 'DEV-SCRIPT', rootDir: '.' });
  assert.deepEqual(push.files, [...pushed, '.clasp.json', '.claspignore'].sort());
  assert.match(push.version, /^[\d.]+-dev\.\d{12}$/);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(html.includes(`const APP_VERSION = '${push.version}';`), 'same stamp in index.html');
  assert.equal(fs.readFileSync(path.join(out, 'Code.gs'), 'utf8'), before['Code.gs']);
  pushed.forEach((f) => assert.equal(read(f), before[f], `${f} in the repo is unchanged`));
  assert.match(r.out, /dev script HEAD/);
  assert.match(r.out, /macros\/s\/AKfycbxHEADHEADHEADHEAD00\/dev/);
});

test('--restore pushes the files exactly as in the repo', () => {
  const r = run(['--config', devConfig, '--restore']);
  assert.equal(r.code, 0, r.err);
  pushed.forEach((f) => {
    assert.equal(fs.readFileSync(path.join(out, f), 'utf8'), before[f], f);
  });
  assert.ok(!/-dev\./.test(r.calls[0].version));
});

test('prod target: asks first; without a terminal it needs --yes and pushes nothing', () => {
  const r = run(['--target', 'prod', '--config', prodConfig]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--yes/);
  assert.equal(r.calls.length, 0);
});

test('prod target with --yes pushes to the script of .clasp.json', () => {
  const r = run(['--target', 'prod', '--config', prodConfig, '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.calls[0].clasp.scriptId, 'PROD-SCRIPT');
  assert.match(r.out, /prod script HEAD/);
});

test('a missing config says how to make one', () => {
  const r = run(['--config', path.join(tmp, 'none.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Make a copy/);
  assert.equal(r.calls.length, 0);
  assert.equal(run(['--target', 'x']).code, 1);
});

test('a failing push passes its status on and does not look for the URL', () => {
  const r = run(['--config', devConfig], { FAKE_FAIL: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.args[0]), ['push']);
});

test('clasp not installed: says so', () => {
  const r = run(['--config', devConfig], { CLASP: path.join(tmp, 'no-such-clasp') });
  assert.equal(r.code, 1);
  assert.match(r.err, /could not run/);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
