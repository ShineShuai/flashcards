// Run: node test/version.mjs   (no dependencies)
// The version stamp is current, and tools/bump-version.mjs behaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, deployedFiles, hashDeployed, nextVersion, readStamp, stamp }
  from '../tools/bump-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
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

// A copy of the deployed files in a temp dir, to change freely.
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ver-'));
  for (const f of ['.claspignore', 'Version.gs', ...deployedFiles(repo)]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(repo, f), path.join(dir, f));
  }
  return dir;
}
const day = (s) => new Date(s + 'T12:00:00Z');
const touch = (dir, file, extra = '\n// changed\n') =>
  fs.appendFileSync(path.join(dir, file), extra);

test('the stamp in the repository is current (else: node tools/bump-version.mjs)', () => {
  assert.deepEqual(check(repo), []);
});

test('index.html and Version.gs carry the same well-formed version', () => {
  const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8')
    .match(/^const APP_VERSION = '([^']*)';/m)[1];
  assert.equal(html, readStamp(repo).version);
  assert.match(html, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

test('deployed files are the whitelist of .claspignore, without Version.gs', () => {
  const files = deployedFiles(repo);
  for (const f of ['Code.gs', 'Config.gs', 'Highlight.gs', 'Preview.gs', 'Sidebar.html',
    'index.html', 'docs.html']) {
    assert.ok(files.includes(f), f);
  }
  assert.equal(files.includes('Version.gs'), false);
  assert.equal(files.some((f) => f.startsWith('test/') || f.startsWith('tools/')), false);
});

test('the pre-commit hook watches every deployed file and nothing else', () => {
  const cfg = fs.readFileSync(path.join(repo, '.pre-commit-config.yaml'), 'utf8');
  assert.match(cfg, /id: bump-version/);
  assert.match(cfg, /entry: node tools\/bump-version\.mjs/);
  const re = new RegExp(cfg.match(/^\s*files: (.+)$/m)[1]);
  for (const f of [...deployedFiles(repo), 'Version.gs']) {
    assert.ok(re.test(f), `${f} is not watched`);
  }
  for (const f of ['test/code.mjs', 'tools/bump-version.mjs', 'README.md', '.claspignore']) {
    assert.equal(re.test(f), false, `${f} should not trigger it`);
  }
});

test('nextVersion: new day starts at 1, same day counts up, an old clock never goes back', () => {
  assert.equal(nextVersion(undefined, day('2026-11-10')), '2026.11.10.1');
  assert.equal(nextVersion('2026.11.09.4', day('2026-11-10')), '2026.11.10.1');
  assert.equal(nextVersion('2026.11.10.1', day('2026-11-10')), '2026.11.10.2');
  assert.equal(nextVersion('2026.11.10.9', day('2026-11-10')), '2026.11.10.10');
  assert.equal(nextVersion('2026.11.12.2', day('2026-11-10')), '2026.11.12.3');
  assert.equal(nextVersion('garbage', day('2026-11-10')), '2026.11.10.1');
});

test('stamping: no change is a no-op; a change bumps; stamping twice is stable', () => {
  const dir = copyRepo();
  const before = readStamp(dir).version;
  assert.equal(stamp(dir, day('2026-12-01')).changed, false);
  assert.equal(readStamp(dir).version, before);
  touch(dir, 'Code.gs');
  assert.ok(check(dir).some((p) => /changed since/.test(p)));
  const bumped = stamp(dir, day('2026-12-01'));
  assert.equal(bumped.changed, true);
  assert.equal(bumped.version, '2026.12.01.1');
  assert.deepEqual(check(dir), []);
  assert.equal(stamp(dir, day('2026-12-01')).changed, false);
  touch(dir, 'index.html', '\n<!-- x -->\n');
  assert.equal(stamp(dir, day('2026-12-01')).version, '2026.12.01.2');
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'),
    /^const APP_VERSION = '2026\.12\.01\.2';$/m);
});

test('every kind of deployed file triggers a bump', () => {
  for (const f of deployedFiles(repo)) {
    const dir = copyRepo();
    touch(dir, f, f.endsWith('.html') ? '\n<!-- x -->\n' : '\n// x\n');
    assert.equal(stamp(dir, day('2026-12-01')).changed, true, f);
  }
});

test('files that are not deployed do not matter; neither do line endings', () => {
  const dir = copyRepo();
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'x.mjs'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
  assert.equal(stamp(dir, day('2026-12-01')).changed, false);
  const code = path.join(dir, 'Code.gs');
  fs.writeFileSync(code, fs.readFileSync(code, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(hashDeployed(dir), hashDeployed(repo));
  assert.equal(stamp(dir, day('2026-12-01')).changed, false);
});

test('a version out of step between the two files is repaired without a bump', () => {
  const dir = copyRepo();
  const html = path.join(dir, 'index.html');
  const want = readStamp(dir).version;
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8')
    .replace(/^const APP_VERSION = '[^']*';/m, "const APP_VERSION = '1999.01.01.1';"));
  assert.ok(check(dir).some((p) => /index\.html has version/.test(p)));
  assert.equal(stamp(dir, day('2026-12-01')).version, want);
  assert.deepEqual(check(dir), []);
});

test('a missing Version.gs is created; index.html without the line is an error', () => {
  const dir = copyRepo();
  fs.rmSync(path.join(dir, 'Version.gs'));
  assert.deepEqual(check(dir), ['Version.gs is missing']);
  assert.equal(stamp(dir, day('2026-12-01')).version, '2026.12.01.1');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  assert.throws(() => stamp(dir), /no line/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
