// Run: node test/sri.mjs   (needs network: runs `npm pack marked@<version>`)
// The marked <script> in index.html must be pinned to an exact version and its
// integrity hash must match the file in that npm package (jsdelivr serves npm
// files byte for byte).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const tag = html.match(/<script[^>]*cdn\.jsdelivr\.net\/npm\/marked@[^>]*><\/script>/);
assert.ok(tag, 'pinned marked <script> not found');
const src = tag[0].match(/src="([^"]+)"/)[1];
const integrity = tag[0].match(/integrity="([^"]+)"/)?.[1];
const m = src.match(/npm\/marked@(\d+\.\d+\.\d+)\/(.+)$/);
assert.ok(m, `marked must be pinned to an exact version: ${src}`);
assert.ok(integrity?.startsWith('sha384-'), 'integrity attribute missing');
assert.match(tag[0], /crossorigin="anonymous"/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-'));
try {
  execFileSync('npm', ['pack', `marked@${m[1]}`, '--silent'], { cwd: tmp, stdio: 'pipe' });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  execFileSync('tar', ['xzf', tgz, `package/${m[2]}`], { cwd: tmp });
  const bytes = fs.readFileSync(path.join(tmp, 'package', m[2]));
  const digest = 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');
  assert.equal(integrity, digest, `integrity of ${src}`);
  console.log(`ok   marked@${m[1]}/${m[2]} matches ${integrity}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
