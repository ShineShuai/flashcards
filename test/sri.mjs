// Run: node test/sri.mjs   (needs network: runs `npm pack <package>@<version>`)
// Every jsdelivr <script> in index.html (marked, DOMPurify) must be pinned to an
// exact version, and its integrity hash must match the file in that npm package
// (jsdelivr serves npm files byte for byte).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const tags = html.match(/<script[^>]*cdn\.jsdelivr\.net\/npm\/[^>]*><\/script>/g) || [];
const pkgs = tags.map((t) => t.match(/npm\/(@?[^@/]+)@/)?.[1]);
for (const need of ['marked', 'dompurify']) {
  assert.ok(pkgs.includes(need), `pinned ${need} <script> not found`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-'));
try {
  for (const tag of tags) {
    const src = tag.match(/src="([^"]+)"/)[1];
    const integrity = tag.match(/integrity="([^"]+)"/)?.[1];
    const m = src.match(/npm\/(@?[^@/]+)@(\d+\.\d+\.\d+)\/(.+)$/);
    assert.ok(m, `must be pinned to an exact version: ${src}`);
    assert.ok(integrity?.startsWith('sha384-'), `integrity attribute missing: ${src}`);
    assert.match(tag, /crossorigin="anonymous"/, src);
    const [, name, version, file] = m;
    const dir = fs.mkdtempSync(path.join(tmp, name + '-'));
    execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: dir, stdio: 'pipe' });
    const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    execFileSync('tar', ['xzf', tgz, `package/${file}`], { cwd: dir });
    const bytes = fs.readFileSync(path.join(dir, 'package', file));
    const digest = 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');
    assert.equal(integrity, digest, `integrity of ${src}`);
    console.log(`ok   ${name}@${version}/${file} matches ${integrity}`);
  }
  console.log('\nall passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
