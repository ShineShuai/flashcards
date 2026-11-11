// Stamps the app version when the deployed files change.
//   node tools/bump-version.mjs           update Version.gs and index.html if needed
//   node tools/bump-version.mjs --check   exit 1 when the stamp is out of date (CI)
// Deployed files are the "!name" lines of .claspignore, except Version.gs itself.
// Version = YYYY.MM.DD.N (UTC date, N counts the stamps of that day, never goes
// back). The stored hash covers the deployed files with line endings normalized
// and the version line of index.html blanked, so stamping never changes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML_LINE = /^const APP_VERSION = '([^']*)';/m;
const GS_VERSION = /^const APP_VERSION = '([^']*)';/m;
const GS_HASH = /^const APP_VERSION_HASH = '([^']*)';/m;
const FORMAT = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/;

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

export function deployedFiles(root) {
  return read(root, '.claspignore').split('\n')
    .filter((line) => line.startsWith('!'))
    .map((line) => line.slice(1).trim())
    .filter((file) => file && file !== 'Version.gs' && fs.existsSync(path.join(root, file)))
    .sort();
}

export function hashDeployed(root) {
  const h = crypto.createHash('sha256');
  for (const file of deployedFiles(root)) {
    let text = read(root, file);
    if (file === 'index.html') {
      text = text.replace(HTML_LINE, "const APP_VERSION = '';");
    }
    h.update(`${file}\0${text}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

export function readStamp(root) {
  if (!fs.existsSync(path.join(root, 'Version.gs'))) {
    return null;
  }
  const gs = read(root, 'Version.gs');
  return { version: (gs.match(GS_VERSION) || [])[1], hash: (gs.match(GS_HASH) || [])[1] };
}

export function nextVersion(current, now) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '.');
  const m = FORMAT.exec(current || '');
  if (!m || day > m[1]) {
    return `${day}.1`;
  }
  return `${m[1]}.${Number(m[2]) + 1}`;               // same day, or the clock went back
}

const versionGs = (version, hash) =>
  '// Written by tools/bump-version.mjs (pre-commit); do not edit.\n' +
  '// The app compares APP_VERSION with the one in index.html to learn that a newer\n' +
  '// deployment is live. The hash covers the deployed files at this version.\n' +
  `const APP_VERSION = '${version}';\n` +
  `const APP_VERSION_HASH = '${hash}';\n`;

export function stamp(root, now = new Date()) {
  const hash = hashDeployed(root);
  const html = read(root, 'index.html');
  const inHtml = (html.match(HTML_LINE) || [])[1];
  if (inHtml === undefined) {
    throw new Error("index.html has no line: const APP_VERSION = '...';");
  }
  const cur = readStamp(root);
  const same = cur && cur.hash === hash;
  if (same && cur.version === inHtml) {
    return { changed: false, version: cur.version, hash };
  }
  const version = same ? cur.version : nextVersion(cur && cur.version, now);
  fs.writeFileSync(path.join(root, 'Version.gs'), versionGs(version, hash));
  fs.writeFileSync(path.join(root, 'index.html'),
    html.replace(HTML_LINE, `const APP_VERSION = '${version}';`));
  return { changed: true, version, hash };
}

// A list of problems, empty when the stamp is current.
export function check(root) {
  const cur = readStamp(root);
  if (!cur) {
    return ['Version.gs is missing'];
  }
  const problems = [];
  const inHtml = (read(root, 'index.html').match(HTML_LINE) || [])[1];
  if (!FORMAT.test(cur.version || '')) {
    problems.push(`Version.gs: bad version ${cur.version}`);
  }
  if (inHtml !== cur.version) {
    problems.push(`index.html has version ${inHtml}, Version.gs has ${cur.version}`);
  }
  if (cur.hash !== hashDeployed(root)) {
    problems.push(`deployed files changed since version ${cur.version}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const problems = check(root);
    problems.forEach((p) => console.error('version: ' + p));
    if (problems.length) {
      console.error('run: node tools/bump-version.mjs');
    }
    process.exit(problems.length ? 1 : 0);
  }
  const res = stamp(root);
  console.log(`version ${res.version} ${res.changed ? 'written' : 'is current'}`);
}
