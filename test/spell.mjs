// Run: node test/spell.mjs   (no dependencies)
// Checks the pure spell-matching block of index.html (@spell-begin/@spell-end).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const block = html.match(/\/\/ @spell-begin([\s\S]*?)\/\/ @spell-end/)[1];
const { spellKey, spellThreshold, levenClose, spellScore } = vm.runInNewContext(
  `${block}\n({ spellKey, spellThreshold, levenClose, spellScore })`,
  { Array, Math, Infinity },
);

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
const is = (typed, target, want) => {
  assert.equal(spellScore(typed, target), want, `${typed} ~ ${target}`);
};

test('threshold scales with length; CJK is exact', () => {
  assert.equal(spellThreshold('go'), 0);
  assert.equal(spellThreshold('cat'), 0);
  assert.equal(spellThreshold('cats'), 1);
  assert.equal(spellThreshold('kitten'), 1);
  assert.equal(spellThreshold('Zelle'), 1);
  assert.equal(spellThreshold('mitochondria'), 2);
  assert.equal(spellThreshold('东京'), 0);
  assert.equal(spellThreshold('東京大学'), 0);
  assert.equal(spellThreshold('한국어'), 0);
  assert.equal(spellThreshold('ひらがな'), 0);
});
test('short words no longer match anything within 2 edits (was: to~go, ab~xy)', () => {
  is('to', 'go', Infinity);
  is('ab', 'xy', Infinity);
  is('cat', 'at', Infinity);
  is('cat', 'cat', 0);
});
test('CJK: different ideograph is not a typo', () => {
  is('东京', '北京', Infinity);
  is('东京', '大阪', Infinity);
  is('东京', '东京', 0);
});
test('typos within the length-scaled budget still match', () => {
  is('Zellen', 'Zelle', 1);
  is('mitochondrion', 'mitochondria', 1);
  is('mitocondria', 'mitochondria', 1);
  is('kittan', 'kitten', 1);
  is('uber', 'über', 1);
  assert.equal(spellScore('kitten', 'sitting'), Infinity);   // 3 edits, budget 2
});
test('case, outer and inner whitespace are normalised', () => {
  is('  Hello   World ', 'hello world', 0);
});
test('NFC/NFD forms are equal', () => {
  is('u\u0308ber', '\u00fcber', 0);
  is('\u1112\u1161\u11ab', '한', 0);
});
test('edit distance counts code points, not UTF-16 units', () => {
  assert.equal(levenClose('😀😀😀😀😀', '😀😀😀😀x', 1), true);
  is('𠮷野家', '𠮷野家', 0);
});
test('levenClose basics (threshold 0..2)', () => {
  assert.equal(levenClose('abc', 'abc', 0), true);
  assert.equal(levenClose('abc', 'abd', 0), false);
  assert.equal(levenClose('abcdef', 'abXdeY', 2), true);
  assert.equal(levenClose('abcdef', 'aXXdeY', 2), false);
  assert.equal(levenClose('', 'ab', 2), true);
  assert.equal(levenClose('', 'abc', 2), false);
});
test('spellKey', () => {
  assert.equal(spellKey('  A\tB  C '), 'a b c');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
