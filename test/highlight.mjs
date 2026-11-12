// Run: node test/highlight.mjs   (no dependencies)
// The tokenizer and the type sniffer of Highlight.gs, without any Sheets model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'Highlight.gs'), 'utf8');
const { tokenize_, sniffType_, HL_STYLES } = vm.runInContext(
  `${src}\n({ tokenize_, sniffType_, HL_STYLES })`, vm.createContext({}));

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
// [[class, text], ...]
// (Array.from: arrays made inside the vm context would not deep-equal ours)
const toks = (text, kind) =>
  Array.from(tokenize_(text, kind), (t) => [t.cls, text.slice(t.s, t.e)]);

// ── html / svg ──────────────────────────────────────────────────────────────
test('html: tags, attributes, values, entities', () => {
  assert.deepEqual(toks('<div class="a b" id=x>Hi &amp; <b>bold</b></div>', 'html'), [
    ['tag', '<div'], ['attr', 'class'], ['string', '"a b"'], ['attr', 'id'], ['string', 'x'],
    ['tag', '>'], ['entity', '&amp;'], ['tag', '<b'], ['tag', '>'], ['tag', '</b'], ['tag', '>'],
    ['tag', '</div'], ['tag', '>'],
  ]);
});
test('html: a quoted value with > and = is one string, nothing inside it is repainted', () => {
  assert.deepEqual(toks('<a href="x?a=b>c" title=\'q "r"\'>y</a>', 'html'), [
    ['tag', '<a'], ['attr', 'href'], ['string', '"x?a=b>c"'], ['attr', 'title'],
    ['string', '\'q "r"\''], ['tag', '>'], ['tag', '</a'], ['tag', '>'],
  ]);
});
test('html: a comment hides the tags inside it', () => {
  assert.deepEqual(toks('a<!-- <b>x</b> -->b', 'html'), [['comment', '<!-- <b>x</b> -->']]);
});
test('html: doctype, xml declaration and CDATA are meta', () => {
  const text = '<!DOCTYPE html><?xml version="1.0"?><![CDATA[a<b>]]>';
  assert.deepEqual(toks(text, 'html'), [
    ['meta', '<!DOCTYPE html>'], ['meta', '<?xml version="1.0"?>'], ['meta', '<![CDATA[a<b>]]>'],
  ]);
});
test('html: style/script bodies are embedded; the closing tag matches in any case', () => {
  assert.deepEqual(toks('<style>a>b{c:d}</STYLE><script>if(a<b){}</script>', 'html'), [
    ['tag', '<style'], ['tag', '>'], ['embedded', 'a>b{c:d}'], ['tag', '</STYLE'], ['tag', '>'],
    ['tag', '<script'], ['tag', '>'], ['embedded', 'if(a<b){}'], ['tag', '</script'], ['tag', '>'],
  ]);
});
test('html: unterminated tag, string, comment, style: no throw, end at the end', () => {
  for (const text of ['<div class="a', '<div class=', '<!-- x', '<style>a{', '<a href=\'x', '<']) {
    const t = tokenize_(text, 'html');
    assert.ok(t.every((x) => x.e <= text.length && x.s < x.e), text);
  }
  assert.deepEqual(toks('<!-- x', 'html'), [['comment', '<!-- x']]);
  assert.deepEqual(toks('<style>a{', 'html'),
    [['tag', '<style'], ['tag', '>'], ['embedded', 'a{']]);
});
test('html: a lone < or > in text is not markup', () => {
  for (const text of ['a < b > c', '1<2', '<3 love', 'x <- y', 'a&b', '& amp;']) {
    assert.deepEqual(toks(text, 'html'), [], text);
  }
});
test('svg: self-closing tags, dashed and namespaced attributes', () => {
  assert.deepEqual(toks('<path d="M0 0L5 5" stroke-width="2" xlink:href="#a"/>', 'svg'), [
    ['tag', '<path'], ['attr', 'd'], ['string', '"M0 0L5 5"'], ['attr', 'stroke-width'],
    ['string', '"2"'], ['attr', 'xlink:href'], ['string', '"#a"'], ['tag', '/>'],
  ]);
});
test('live cards are highlighted like html; sniffing never picks live', () => {
  const text = '<div class="a">x</div><script>if (a < b) {}</script>';
  assert.deepEqual(toks(text, 'live'), toks(text, 'html'));
  assert.ok(toks(text, 'live').length > 5);
  for (const sample of [text, '<script>1</script>', '<iframe src="x"></iframe>', '<svg/>']) {
    assert.notEqual(sniffType_(sample), 'live', sample);
  }
});
test('astral characters keep JS offsets (emoji before a tag)', () => {
  const text = '😀 😀 <b>x</b>';
  const [first] = tokenize_(text, 'html');
  assert.equal(text.slice(first.s, first.e), '<b');
  assert.equal(first.s, 6);
});

// ── markdown ────────────────────────────────────────────────────────────────
test('md: heading, list markers, emphasis, code span, link', () => {
  assert.deepEqual(toks('# Title\n- item **b** and *i* `c<b>` [l](http://u "t")\n1. one', 'md'), [
    ['heading', '# Title'], ['marker', '-'], ['bold', '**b**'], ['em', '*i*'],
    ['code', '`c<b>`'], ['link', '[l]'], ['string', '(http://u "t")'], ['marker', '1.'],
  ]);
});
test('md: fenced code is one token; tags inside it are not markup', () => {
  assert.deepEqual(toks('```js\n<b>x</b>\n```\nafter <i>', 'md'), [
    ['code', '```js\n<b>x</b>\n```'], ['tag', '<i'], ['tag', '>'],
  ]);
  assert.deepEqual(toks('~~~\nopen <b>', 'md'), [['code', '~~~\nopen <b>']]);
});
test('md: rule, table separator, quote', () => {
  assert.deepEqual(toks('---\n|a|b|\n|---|:-:|\n|1|2|\n> q', 'md'), [
    ['marker', '---'], ['marker', '|---|:-:|'], ['quote', '> '],
  ]);
});
test('md: image, autolink, entity, embedded html and comment', () => {
  assert.deepEqual(toks('![alt](u.png) <https://x.y/z> &copy; <br> <!-- c -->', 'md'), [
    ['link', '![alt]'], ['string', '(u.png)'], ['string', '<https://x.y/z>'],
    ['entity', '&copy;'], ['tag', '<br'], ['tag', '>'], ['comment', '<!-- c -->'],
  ]);
});
test('md: snake_case, escapes and unterminated markers are plain', () => {
  const plain = ['snake_case_word', '\\*not em\\*', '**bold', '`code', '[x](y', '2 * 3 * 4',
    'a * b'];
  for (const text of plain) {
    assert.deepEqual(toks(text, 'md'), [], text);
  }
});
test('text and unknown kinds have no tokens', () => {
  for (const kind of ['text', '', undefined, 'whatever']) {
    assert.equal(tokenize_('<b>x</b> **y**', kind).length, 0);
  }
});

// ── invariants ──────────────────────────────────────────────────────────────
test('fuzz: tokens are sorted, non-empty, inside the text and never overlap', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const alphabet = ['<', '>', '/', '!', '-', '=', '"', "'", ' ', '&', ';', '#', 'a', 'b', '1',
    '\n',
    '*', '_', '`', '[', ']', '(', ')', '\\', '|', ':', '😀', '<b>', '</b>', '<!--', '-->',
    '```'];
  for (const kind of ['html', 'svg', 'md']) {
    for (let n = 0; n < 700; n++) {
      let text = '';
      for (let k = rnd() * 40; k > 0; k--) {
        text += alphabet[Math.floor(rnd() * alphabet.length)];
      }
      let at = 0;
      for (const t of tokenize_(text, kind)) {
        const where = `${kind}: ${JSON.stringify(text)}`;
        assert.ok(t.s >= at && t.s < t.e && t.e <= text.length, where);
        assert.ok(HL_STYLES[t.cls], `style for ${t.cls}`);
        at = t.e;
      }
    }
  }
});
test('a 45 000 character cell is tokenized in well under a second', () => {
  const text = '<p class="a">x &amp; <b>y</b></p>\n'.repeat(1400);
  const t0 = Date.now();
  assert.ok(tokenize_(text, 'html').length > 10000);
  assert.ok(tokenize_(text, 'md').length > 10000);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

// ── sniffing ────────────────────────────────────────────────────────────────
test('sniffType_', () => {
  const cases = [
    ['<svg viewBox="0 0 1 1"></svg>', 'svg'],
    ['<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="x"/>', 'svg'],
    ['<!DOCTYPE html><p>x</p>', 'html'], ['<p>x</p>', 'html'], ['<br>', 'html'],
    ['text with <b>bold</b>', 'html'], ['<!-- c --> x', 'html'],
    ['# Title', 'md'], ['- a\n- b', 'md'], ['1. a', 'md'], ['**b**', 'md'],
    ['[x](http://y)', 'md'], ['```\ncode\n```', 'md'], ['> q', 'md'], ['|a|b|', 'md'],
    ['use `x`', 'md'],
    ['plain words', 'text'], ['a < b and c > d', 'text'], ['<3 love', 'text'], ['', 'text'],
    ['  ', 'text'], ['price: 3 - 4', 'text'],
  ];
  for (const [text, want] of cases) {
    assert.equal(sniffType_(text), want, JSON.stringify(text));
  }
});

// ── palette ─────────────────────────────────────────────────────────────────
test('every highlight color has at least 4.5:1 contrast on white', () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const [cls, st] of Object.entries(HL_STYLES)) {
    if (st.color) {
      const ratio = 1.05 / (lum(st.color) + 0.05);
      assert.ok(ratio >= 4.5, `${cls} ${st.color}: ${ratio.toFixed(2)}`);
    }
  }
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
