const { test } = require('node:test');
const assert = require('node:assert');

// Requiring this is the whole point of the split: public/app.js ends in a bare
// boot() call, so it cannot be required without running the app.
const pure = require('../public/pure');

// ---------- escaping ----------
// Assertions are PROPERTIES, not equalities. An equality test pins the current
// regexes and gets edited away the first time someone rewrites the internals;
// a property assertion survives a move to replaceAll, a lookup map, or a
// DOM-based implementation, and still catches the regression that matters.

test('esc neutralises the payload that would execute', () => {
  const out = pure.esc('<img src=x onerror="document.title=1">');
  assert.ok(!out.includes('<'), 'raw < survived');
  assert.ok(!out.includes('>'), 'raw > survived');
});

test('esc neutralises the ampersand that would start an entity', () => {
  assert.ok(!pure.esc('a & b').includes('& '), 'raw & survived');
});

test('escAttr neutralises a quote that would break out of an attribute', () => {
  const out = pure.escAttr('/tmp/a" onmouseover=alert(1) x="');
  assert.ok(!out.includes('"'), 'raw " survived — it would close the attribute');
});

test('escAttr neutralises a single quote too', () => {
  assert.ok(!pure.escAttr("it's").includes("'"), "raw ' survived");
});

test('escAttr is a strict superset of esc', () => {
  // escAttr is DEFINED in terms of esc; the plausible regression is someone
  // "simplifying" it to handle only quotes.
  const input = '<a href="x">&</a>';
  const out = pure.escAttr(input);
  for (const raw of ['<', '>', '"']) {
    assert.ok(!out.includes(raw), `escAttr let a raw ${raw} through`);
  }
});

test('escAttr escapes & before " — order is load-bearing', () => {
  // If the quote replacement ran BEFORE the & replacement, " would become
  // &amp;quot; and render on the page as a literal &quot;.
  assert.ok(!pure.escAttr('"').includes('&amp;quot;'));
});

// CHARACTERIZATION, not specification. esc uses String(s || ''), so falsy input
// is swallowed; app.js already works around it with String(s.count) where a
// count of 0 must still render. This test exists so 22 call sites do not change
// behaviour by accident. If someone fixes esc properly, this test is SUPPOSED
// to fail — that is the signal to audit the call sites, not to restore the quirk.
test('esc swallows falsy input (known quirk, see the String(s.count) call site)', () => {
  assert.strictEqual(pure.esc(0), '');
  assert.strictEqual(pure.esc(false), '');
  assert.strictEqual(pure.esc(null), '');
});

// ---------- railState ----------
// The MEDIUM-2 pin: a structured error from a well-behaved server must not be
// classified as "empty", because the empty state tells the user to add projects
// they already have and the API accepts the same path twice.
test('railState classifies every response shape', () => {
  const cases = [
    ['500 with a structured error', [false, { error: 'store file is corrupt' }], 'error'],
    ['200 whose body carries an error', [true, { error: 'boom' }], 'error'],
    ['no body at all (network)', [false, null], 'error'],
    ['200 with a non-array projects', [true, { projects: 'nope' }], 'error'],
    ['non-ok despite a usable body', [false, { projects: [{ id: 'a' }] }], 'error'],
    ['200 with no projects', [true, { projects: [] }], 'empty'],
    ['200 with projects', [true, { projects: [{ id: 'a' }] }], 'list'],
    // The only shape that isolates the data.error clause: ok, and a usable
    // array, so neither of the other two guards can fire. Without this case,
    // deleting `data.error ||` from railState passes the whole suite.
    ['200 carrying an error alongside a list', [true, { error: 'boom', projects: [{ id: 'a' }] }], 'error'],
  ];
  for (const [name, args, kind] of cases) {
    assert.strictEqual(pure.railState(...args).kind, kind, name);
  }
});

test('railState only carries projects through on the list branch', () => {
  // The renderer reads .projects unconditionally, so a non-list kind must not
  // hand it something to render.
  assert.deepStrictEqual(pure.railState(false, { error: 'x' }).projects, []);
  // Must be an error body that actually HAS projects, or a mutation that
  // forwards data.projects on the error branch goes unnoticed.
  assert.deepStrictEqual(pure.railState(false, { error: 'x', projects: [{ id: 'a' }] }).projects, []);
  assert.deepStrictEqual(pure.railState(true, { projects: [] }).projects, []);
  assert.deepStrictEqual(pure.railState(true, { projects: [{ id: 'a' }] }).projects, [{ id: 'a' }]);
});

// ---------- deleteOutcome ----------
test('deleteOutcome reconciles the view on a 404 but not on a dead server', () => {
  // A 404 means the record is already gone: the view is stale and must
  // re-render or the phantom row 404s again on every retry.
  const gone = pure.deleteOutcome({ error: 'no such project' });
  assert.strictEqual(gone.ok, false);
  assert.strictEqual(gone.shouldReload, true, 'a 404 must reconcile the stale view');

  // An unreachable server says nothing about whether the record exists, so
  // re-rendering would only trade a good list for an error box.
  const dead = pure.deleteOutcome(null);
  assert.strictEqual(dead.ok, false);
  assert.strictEqual(dead.shouldReload, false, 'a dead server must not blow away the list');
});

test('deleteOutcome reports a dead server in the UI language', () => {
  // The raw rejection reads "Failed to fetch" — untranslated English in a
  // Chinese console.
  const msg = pure.deleteOutcome(null).message;
  assert.ok(!/[a-z]{4,}/.test(msg), `leaked an English message: ${msg}`);
});

test('deleteOutcome only reports success on an explicit ok', () => {
  assert.strictEqual(pure.deleteOutcome({ ok: true, filesKept: true }).ok, true);
  // A body that merely lacks an error is not a success.
  assert.strictEqual(pure.deleteOutcome({ filesKept: true }).ok, false);
  assert.strictEqual(pure.deleteOutcome({}).ok, false);
});

test('deleteOutcome surfaces the server error text rather than inventing one', () => {
  assert.ok(pure.deleteOutcome({ error: 'no such project' }).message.includes('no such project'));
});
