// Run: node test/contrast.mjs   (no dependencies)
// WCAG 2 contrast (>= 4.5:1) of the colour pairs defined in index.html's CSS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

function declarations(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([-\w]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}
function rule(selector) {
  const escaped = selector.replace(/[.[\]"$^*+?()|{}\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `rule not found: ${selector}`);
  return declarations(m[1]);
}
const rootVars = rule(':root');
const darkVars = { ...rootVars, ...rule('[data-theme="dark"]') };

function resolve(value, vars) {
  const m = value.match(/^var\((--[\w-]+)\)$/);
  return m ? resolve(vars[m[1]], vars) : value;
}
function hexes(value, vars) {
  const text = value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(`var(${name})`, vars));
  return [...text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) =>
    (m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]));
}
function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + err.message);
  }
}
function check(label, fg, bgs, min = 4.5) {
  for (const bg of bgs) {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${label}: #${fg} on #${bg} = ${r.toFixed(2)} (< ${min})`);
  }
}

test('rating, flip and primary buttons: label on every background colour', () => {
  const base = rule('.btn-rate').color;
  for (const name of ['again', 'recap', 'hard', 'good', 'easy']) {
    const decl = rule(`.btn-${name}`);
    const fg = hexes(decl.color || base, rootVars)[0];
    check(`.btn-${name}`, fg, hexes(decl.background, rootVars));
  }
  for (const name of ['flip', 'primary']) {
    const decl = rule(`.btn-${name}`);
    check(`.btn-${name}`, hexes(decl.color, rootVars)[0], hexes(decl.background, rootVars));
  }
});

for (const [theme, vars] of [['light', rootVars], ['dark', darkVars]]) {
  test(`${theme}: text tokens on surface and --bg2`, () => {
    const surfaces = ['--surface', '--bg2'].map((n) => hexes(vars[n], vars)[0]);
    const tokens = [
      '--text', '--text2', '--mint-t', '--blue-t', '--amber-t', '--pink-t', '--purple-t',
    ];
    for (const token of tokens) {
      check(`${theme} ${token}`, hexes(`var(${token})`, vars)[0], surfaces);
    }
    check(`${theme} --purple-t`, hexes('var(--purple-t)', vars)[0], surfaces);
  });
}

// Spell pills: a translucent tint over the card; text >= 4.5:1, glyph (a graphic) >= 3:1.
function over(value, bgHex) {
  const m = value.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  assert.ok(m, `not an rgba() tint: ${value}`);
  const alpha = Number(m[4]);
  return [1, 2, 3]
    .map((i, k) => {
      const bg = parseInt(bgHex.slice(k * 2, k * 2 + 2), 16);
      const mixed = Math.round(Number(m[i]) * alpha + bg * (1 - alpha));
      return mixed.toString(16).padStart(2, '0');
    })
    .join('');
}
for (const [theme, vars, prefix] of [
  ['light', rootVars, ''],
  ['dark', darkVars, '[data-theme="dark"] '],
]) {
  test(`${theme}: spell pill text and glyph on each result tint`, () => {
    const slot = rule('.kw-pill.spell-slot');
    const states = [
      ['exact', '.kw-pill.spell-slot.correct', '--mint-t'],
      ['close', '.kw-pill.spell-slot.close', '--amber-t'],
      ['wrong', '.kw-pill.spell-slot.wrong', '--pink-t'],
    ];
    for (const [name, selector, glyphToken] of states) {
      const light = rule(selector);
      let themed = {};
      try {
        themed = rule(prefix + selector);
      } catch {
        themed = {};
      }
      const decl = prefix && themed['-webkit-text-fill-color'] ? themed : { ...slot, ...light };
      const textVar = decl['-webkit-text-fill-color'] || slot['-webkit-text-fill-color'];
      const text = hexes(textVar, vars)[0];
      const glyph = hexes(`var(${glyphToken})`, vars)[0];
      for (const surface of ['--surface', '--surface2', '--bg2']) {
        const under = hexes(vars[surface], vars)[0];
        const bg = over(light.background, under);
        check(`${theme} ${name} text on ${surface}`, text, [bg]);
        check(`${theme} ${name} glyph on ${surface}`, glyph, [bg], 3);   // WCAG 1.4.11
      }
    }
  });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
