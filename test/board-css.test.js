'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// fantastic-ui's consistency gate, made mechanical: the board extends the
// console's token system, it does not run a second one beside it.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('board.css carries no colour literals and no ID selectors', () => {
  const css = strip(read('board.css'));
  // `#` at all, not just hex: an ID selector like `#add-project` contains a
  // valid hex run ("add") and would slip past a hex-only pattern. Classes only.
  assert.doesNotMatch(css, /#/, 'a hex literal or an ID selector');
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|oklch|lab)\(/, 'a colour function literal');
});

test('every token board.css reads is defined in style.css', () => {
  const defined = new Set([...read('style.css').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...strip(read('board.css')).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  // A typo like --ground-4 resolves to nothing and the element silently
  // inherits whatever is behind it - which is how text lands on a ground step
  // nobody measured.
  assert.deepStrictEqual([...used].filter((t) => !defined.has(t)), []);
});
