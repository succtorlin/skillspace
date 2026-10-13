'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The console's scripts are CLASSIC scripts sharing one global scope. Two of
// them declaring the same top-level const is a SyntaxError that kills the
// second file at load - the board would simply be absent, with one line in a
// console nobody has open. Function redeclarations are worse: the later one
// silently wins.
const FILES = ['auth.js', 'pure.js', 'icons.js', 'board.js', 'order-drawer.js', 'goal-panel.js', 'app.js'];
const DECL = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

test('no two console scripts declare the same top-level name', () => {
  const owner = new Map();
  const clashes = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    for (const m of src.matchAll(DECL)) {
      const name = m[1];
      if (owner.has(name) && owner.get(name) !== f) clashes.push(`${name}: ${owner.get(name)} and ${f}`);
      else owner.set(name, f);
    }
  }
  assert.deepStrictEqual(clashes, []);
});
