#!/usr/bin/env node
// Push the working tree to the HEAD of an Apps Script project, so that its web app's /dev URL
// and the Flash menu run the code, without creating a version or touching a deployment.
//   node tools/dev-push.mjs [--target dev|prod] [--restore] [--yes]
//
//   dev (default)  the script in .clasp.dev.json, {"scriptId": "..."}: the bound script of a
//                  copy of your spreadsheet (File > Make a copy copies the script too). Rating
//                  cards there does not touch your real data.
//   prod           the script in .clasp.json (the real sheet). HEAD changes, the /exec version
//                  does not, but rating a card in /dev writes real data. Asks first (--yes).
//   --restore      push the files exactly as in the repo, e.g. to leave prod HEAD clean.
//   --config F / --out DIR   the script-id file / the build folder (.dev/build)
//
// What is pushed is a copy: the files whitelisted in .claspignore, with "-dev.<time>" added
// to APP_VERSION in Version.gs and index.html. The repo is untouched. An open /dev tab sees
// the new version and updates itself, which also tests that flow; without the stamp an
// uncommitted push keeps the old version and nothing reloads. The environment is passed on to
// clasp (HTTPS_PROXY for a VPN). CLASP=/path/to/clasp overrides the binary.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_LINE = /^const APP_VERSION = '([^']*)';/m;

// The files clasp pushes: the "!name" lines of .claspignore
export const parseClaspignore = (text) => text.split('\n').map((l) => l.trim())
  .filter((l) => l.startsWith('!')).map((l) => l.slice(1));

// files: { name: text }. Returns a copy with the dev stamp in both version lines.
export function stampVersion(files, stamp) {
  const bases = ['Version.gs', 'index.html'].map((name) => {
    const m = VERSION_LINE.exec(files[name] ?? '');
    if (!m) {
      throw new Error(`${name}: the APP_VERSION line was not found`);
    }
    return m[1];
  });
  if (bases[0] !== bases[1]) {
    throw new Error(`Version.gs (${bases[0]}) and index.html (${bases[1]}) differ: commit first`);
  }
  const line = `const APP_VERSION = '${bases[0]}-dev.${stamp}';`;
  return {
    ...files,
    'Version.gs': files['Version.gs'].replace(VERSION_LINE, line),
    'index.html': files['index.html'].replace(VERSION_LINE, line),
  };
}

// The /dev URL out of `clasp deployments` ("- <id> @HEAD"), or ''
export function headUrl(text) {
  const m = /([\w-]{20,})\s+@HEAD/.exec(text);
  return m ? `https://script.google.com/macros/s/${m[1]}/dev` : '';
}

const fail = (message) => {
  console.error('error: ' + message);
  return 1;
};

export async function main(argv, env = process.env) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? fallback : argv[at + 1];
  };
  const target = value('target', 'dev');
  if (!['dev', 'prod'].includes(target)) {
    return fail(`--target is dev or prod, not "${target}"`);
  }
  const config = value('config',
    path.join(root, target === 'dev' ? '.clasp.dev.json' : '.clasp.json'));
  if (!fs.existsSync(config)) {
    return fail(target === 'dev'
      ? `${config} is missing. Make a copy of the spreadsheet (File > Make a copy), open its\n` +
        'Extensions > Apps Script > Project Settings, and save {"scriptId": "<Script ID>"} there.'
      : `${config} is missing: it is the file clasp clone/create wrote.`);
  }
  const scriptId = JSON.parse(fs.readFileSync(config, 'utf8')).scriptId;
  if (!scriptId) {
    return fail(`${config} has no scriptId`);
  }
  if (target === 'prod' && !flag('yes')) {
    if (!process.stdin.isTTY) {
      return fail('prod needs --yes when not run in a terminal');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Push to the PRODUCTION script HEAD (real sheet)? [prod]: ');
    rl.close();
    if (answer.trim() !== 'prod') {
      return fail('cancelled');
    }
  }

  let files = {};
  for (const name of parseClaspignore(fs.readFileSync(path.join(root, '.claspignore'), 'utf8'))) {
    files[name] = fs.readFileSync(path.join(root, name), 'utf8');
  }
  let version = VERSION_LINE.exec(files['Version.gs'])?.[1] ?? '?';
  if (!flag('restore')) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);   // YYMMDDHHMMSS UTC
    files = stampVersion(files, stamp);
    version = VERSION_LINE.exec(files['Version.gs'])[1];
  }
  const out = value('out', path.join(root, '.dev', 'build'));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), text);
  }
  fs.copyFileSync(path.join(root, '.claspignore'), path.join(out, '.claspignore'));
  fs.writeFileSync(path.join(out, '.clasp.json'), JSON.stringify({ scriptId, rootDir: '.' }));

  const clasp = env.CLASP || 'clasp';
  const run = (args, extra = {}) => spawnSync(clasp, args, { cwd: out, env, ...extra });
  const push = run(['push', '--force'], { stdio: 'inherit' });
  if (push.error) {
    return fail(`could not run ${clasp}: ${push.error.message} (npm i -g @google/clasp)`);
  }
  if (push.status !== 0) {
    return push.status || 1;
  }
  const url = headUrl(run(['deployments'], { encoding: 'utf8' }).stdout || '');
  console.log(`pushed ${Object.keys(files).length} files to the ${target} script HEAD, ` +
    `version ${version}`);
  console.log(url ? `web app (HEAD): ${url}`
    : 'web app (HEAD): editor > Deploy > Test deployments (the @HEAD id was not found)');
  console.log('Flash menu: reload the sheet; the sidebar or window runs the new code when ' +
    'reopened');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
