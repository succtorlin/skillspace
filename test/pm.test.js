'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const pm = require('../lib/pm');

test('the prompt states the goal, the project, and the required output shape', () => {
  const p = pm.buildPrompt({ text: 'make the tests green', projectPath: '/tmp/repo', maxOrders: 12 });
  assert.match(p, /make the tests green/);
  assert.match(p, /\/tmp\/repo/);
  assert.match(p, /12/, 'the cap must be stated, or the PM cannot respect it');
  assert.match(p, /title/);
  assert.match(p, /acceptance/);
  // The prose further down also says "acceptance criteria", so matching the
  // bare word does not prove the SHAPE was shown. Pin the skeleton keys.
  for (const key of ['"title":', '"prompt":', '"acceptance":']) {
    assert.ok(p.includes(key), `the output shape must show ${key}`);
  }
});

test('a bare JSON array is extracted', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"do a","acceptance":"a is done"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].title, 'a');
});

test('a fenced block is extracted', () => {
  const out = 'Here is the plan:\n\n```json\n[{"title":"a","prompt":"p","acceptance":"x"}]\n```\n\nHope that helps!';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
});

test('prose on both sides of a bare array is tolerated', () => {
  const out = 'I looked at the repo.\n[{"title":"a","prompt":"p","acceptance":"x"}]\nLet me know.';
  assert.strictEqual(pm.extractPlan(out).orders.length, 1);
});

test('the LAST plausible array wins', () => {
  // Agents commonly show a draft and then a corrected final answer. The last
  // one is the one they meant.
  const out = '[{"title":"draft","prompt":"p","acceptance":"x"}]\n\nOn reflection:\n' +
              '[{"title":"final","prompt":"p","acceptance":"x"}]';
  assert.strictEqual(pm.extractPlan(out).orders[0].title, 'final');
});

test('an array containing a brace inside a string is parsed correctly', () => {
  // Naive brace counting breaks here, and prompts are exactly the field most
  // likely to contain one.
  const out = '[{"title":"a","prompt":"run `if (x) { y }` and report","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.match(r.orders[0].prompt, /\{ y \}/);
});

test('no JSON at all is an error, not an empty plan', () => {
  const r = pm.extractPlan('I would start by reading the README, then run the tests.');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /no JSON plan/);
});

// Renamed from "...naming the problem": the assertion is that it is refused,
// not that the syntax error is described. The parse error is deliberately not
// surfaced - rawPlan carries the text a human needs.
test('malformed JSON is refused, not treated as an empty plan', () => {
  const r = pm.extractPlan('[{"title":"a",]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /no JSON plan/);
});

test('an entry missing a prompt is rejected, not defaulted', () => {
  // An order with no prompt would dispatch an agent with nothing to do, and
  // record it as succeeded when it exits 0.
  const r = pm.extractPlan('[{"title":"a","acceptance":"x"}]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0.*prompt/);
});

test('a non-array JSON value is rejected', () => {
  assert.match(pm.extractPlan('{"title":"a","prompt":"p"}').error, /no JSON plan/);
});

test('an empty array is rejected as not a plan', () => {
  assert.match(pm.extractPlan('[]').error, /empty/);
});

test('extra fields are dropped, not stored', () => {
  // The PM is an agent; whatever else it invents must not reach the record.
  const r = pm.extractPlan('[{"title":"a","prompt":"p","acceptance":"x","cwd":"/etc","agent":"rm"}]');
  assert.deepStrictEqual(Object.keys(r.orders[0]).sort(), ['acceptance', 'prompt', 'title']);
});

test('acceptance is optional and defaults to empty', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"p"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].acceptance, '');
});

// --- Beyond the plan -------------------------------------------------------
// The plan's "brace inside a string" test does not pin what it claims to:
// arraySpans counts BRACKETS, so a '{' inside a string never touched the scan
// and the naive-counting mutant survived it. These two do pin it.

test('a bracket inside a prompt does not truncate the span', () => {
  const out = '[{"title":"a","prompt":"close the block with ] and report","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.match(r.orders[0].prompt, /with \] and/);
});

test('an unbalanced open bracket inside a prompt does not swallow the plan', () => {
  const out = '[{"title":"a","prompt":"an array starts with [ like so","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.match(r.orders[0].prompt, /with \[ like/);
});

test('an escaped quote inside a prompt does not end the string early', () => {
  // Exactly ONE escaped quote before the bracket, deliberately. With a pair of
  // them the string re-opens and the bracket lands back inside it, so parity
  // hides a scanner that ignores escapes entirely - which is how the first
  // version of this test let that mutant live.
  const out = '[{"title":"a","prompt":"say \\" then ] and stop","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].prompt, 'say " then ] and stop');
});

test('an escaped backslash before a quote still closes the string', () => {
  // "C:\\" is a string ENDING in one backslash. If the escape flag is not
  // cleared, the closing quote reads as escaped and the scan runs on.
  const out = '[{"title":"a","prompt":"cd C:\\\\","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].prompt, 'cd C:\\');
});

test('a nested array inside an entry does not become the plan', () => {
  const out = '[{"title":"a","prompt":"p","acceptance":"x","steps":["one","two"]}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
  assert.deepStrictEqual(Object.keys(r.orders[0]).sort(), ['acceptance', 'prompt', 'title']);
});

test('a fence inside a fence is tolerated', () => {
  const out = 'Plan:\n```json\n[{"title":"a","prompt":"write ```sh\\nls\\n``` in the README",' +
              '"acceptance":"x"}]\n```\ndone';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.match(r.orders[0].prompt, /```sh/);
});

test('trailing prose brackets do not mask the plan above them', () => {
  // "the last plausible array wins" means the last PLAN-SHAPED one. A list of
  // numbers in a closing sentence is not a plan, and taking it would discard
  // the real one.
  const out = '[{"title":"real","prompt":"p","acceptance":"x"}]\n\nRun them in order [1,2,3].';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].title, 'real');
});

test('a trailing empty array does not mask the plan above it', () => {
  const out = '[{"title":"real","prompt":"p","acceptance":"x"}]\n\nNo blockers: [].';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].title, 'real');
});

test('an array of strings is refused, naming the entry', () => {
  const r = pm.extractPlan('["do a","do b"]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 is not an object/);
});

test('a null entry is refused, not skipped', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"p"},null]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 1 is not an object/);
});

test('a plan-shaped array with a bad entry is refused, not replaced by an earlier draft', () => {
  // The last plan-shaped array IS the PM's answer. Falling back to the draft
  // above it would execute a plan the PM had already replaced.
  const out = '[{"title":"draft","prompt":"p","acceptance":"x"}]\n\nOn reflection:\n' +
              '[{"title":"final","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 has no prompt/);
});

test('a documented limit: an unmatched bracket in the prose hides the plan', () => {
  // Pinned, not endorsed - see Known limits in lib/pm.js. The goal keeps the
  // PM's raw output, so this surfaces to a human rather than silently.
  const out = 'Step [1 of 2\n[{"title":"a","prompt":"p","acceptance":"x"}]';
  assert.match(pm.extractPlan(out).error, /no JSON plan/);
});

test('a documented limit: an unmatched quote in the prose hides the plan', () => {
  const out = 'The goal says "make it green\n[{"title":"a","prompt":"p","acceptance":"x"}]';
  assert.match(pm.extractPlan(out).error, /no JSON plan/);
});

test('extractPlan answers rather than throws for input that is not a string', () => {
  // Object.create(null) is in the list because String() THROWS on it: a
  // stringify-instead-of-empty shortcut passes every other case here.
  const cases = [null, undefined, 0, 42, NaN, true, {}, [], () => {}, Symbol('x'),
    Object.create(null), new Date(), 10n];
  for (const bad of cases) {
    const r = pm.extractPlan(bad);
    assert.strictEqual(r.orders, null, `orders for ${typeof bad}`);
    assert.match(r.error, /no JSON plan/);
  }
});

test('a whitespace-only prompt is refused, not defaulted', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"   \\n  ","acceptance":"x"}]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 has no prompt/);
});

test('a non-string prompt is refused, not stringified', () => {
  // An order whose prompt is "[object Object]" still dispatches a real agent.
  for (const bad of ['{"a":1}', '42', 'true', 'null', '["p"]']) {
    const r = pm.extractPlan(`[{"title":"a","prompt":${bad}}]`);
    assert.strictEqual(r.orders, null, bad);
    assert.match(r.error, /entry 0 has no prompt/);
  }
});

test('a title is cut by code point, so an emoji is not split in half', () => {
  const title = 'a'.repeat(199) + '\u{1F600}';
  const r = pm.extractPlan(JSON.stringify([{ title, prompt: 'p' }]));
  assert.strictEqual(r.error, null);
  const t = r.orders[0].title;
  assert.strictEqual(Array.from(t).length, 200);
  assert.ok(t.endsWith('\u{1F600}'), 'the last code point survived whole');
  assert.ok(!/[\uD800-\uDBFF]$/.test(t), 'no lone high surrogate at the cut');
});

test('an over-long prompt is refused, not truncated', () => {
  // A truncated prompt is a different instruction that still looks plausible:
  // the agent runs it, exits 0, and the order reads as succeeded.
  const r = pm.extractPlan(JSON.stringify([{ title: 'a', prompt: 'x'.repeat(100001) }]));
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 prompt is too long/);
});

test('an over-long acceptance is refused, not silently shortened', () => {
  // orders.create throws on this, inside plan.js's uncaught .map() - after
  // earlier orders of the same plan are already on disk.
  const r = pm.extractPlan(
    JSON.stringify([{ title: 'a', prompt: 'p', acceptance: 'x'.repeat(100001) }])
  );
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 acceptance is too long/);
});

test('a prompt of exactly the maximum length is accepted', () => {
  const r = pm.extractPlan(JSON.stringify([{ title: 'a', prompt: 'x'.repeat(100000) }]));
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].prompt.length, 100000);
});

test('the entry is rebuilt, so a __proto__ key cannot ride along', () => {
  const r = pm.extractPlan('[{"title":"a","prompt":"p","__proto__":{"polluted":true}}]');
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(Object.keys(r.orders[0]).sort(), ['acceptance', 'prompt', 'title']);
  assert.strictEqual({}.polluted, undefined);
});

test('a ten-megabyte transcript is answered, not thrown', () => {
  const noise = 'the quick brown fox. '.repeat(500000); // ~10MB
  const started = Date.now();
  const r = pm.extractPlan(noise + '\n[{"title":"a","prompt":"p","acceptance":"x"}]\n' + noise);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].title, 'a');
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started}ms`);
});

test('deeply nested brackets are refused by shape, not by a crash', () => {
  // Named for what it actually checks. V8's JSON parser is iterative - 200,000
  // levels parse without throwing, measured - so this never reaches a stack
  // overflow; it is an array whose first element is an array, and it is
  // refused as such. Asserting the exact string keeps it from passing on some
  // other error that happens to be non-empty.
  const r = pm.extractPlan('['.repeat(20000) + ']'.repeat(20000));
  assert.strictEqual(r.orders, null);
  assert.strictEqual(r.error, 'entry 0 is not an object');
});

test('a lone surrogate does not throw', () => {
  const r = pm.extractPlan('\uD800 [{"title":"a\uD800","prompt":"p\uDC00","acceptance":"x"}]');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders.length, 1);
});

test('buildPrompt refuses a cap it cannot state', () => {
  // "AT MOST undefined work orders" is a cap that has stopped being a cap, and
  // it costs a full credentialed agent run to find out.
  const base = { text: 'g', projectPath: '/tmp/repo' };
  for (const bad of [undefined, null, NaN, 0, -1, 0.5, '12', Infinity, {}]) {
    assert.throws(
      () => pm.buildPrompt({ ...base, maxOrders: bad }),
      /maxOrders/,
      `maxOrders: ${String(bad)}`
    );
  }
});

test('buildPrompt states the floor of a fractional cap, matching withinBudget', () => {
  // goals.withinBudget accepts `count <= cap`, so a cap of 2.5 admits 2 - and
  // 2 is the number the PM has to be told, or it is refused for a limit it was
  // never given.
  const p = pm.buildPrompt({ text: 'g', projectPath: '/tmp/repo', maxOrders: 2.5 });
  assert.match(p, /AT MOST 2 /);
  assert.doesNotMatch(p, /2\.5/);
});

test('buildPrompt refuses a missing goal or project path', () => {
  assert.throws(() => pm.buildPrompt({ text: '  ', projectPath: '/p', maxOrders: 3 }), /text/);
  assert.throws(() => pm.buildPrompt({ text: 'g', projectPath: '', maxOrders: 3 }), /projectPath/);
  assert.throws(() => pm.buildPrompt({ text: 'g', maxOrders: 3 }), /projectPath/);
});

test('the goal text is stated verbatim, brackets and all', () => {
  const p = pm.buildPrompt({
    text: 'fix the [flaky] test in "runner"', projectPath: '/tmp/r', maxOrders: 4,
  });
  assert.match(p, /fix the \[flaky\] test in "runner"/);
});

test('a stray closing bracket in the prose does not hide the plan', () => {
  // Without the depth reset the scanner goes negative and never opens a span
  // again, so one loose ']' anywhere above the plan loses it.
  const out = 'see footnote] then\n[{"title":"a","prompt":"p","acceptance":"x"}]';
  const r = pm.extractPlan(out);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].title, 'a');
});

test('the LATEST array that is not a plan supplies the reason', () => {
  // Same rule as which plan wins: the last thing the PM printed is what it
  // meant, so it is what the human is told about.
  const r = pm.extractPlan('Nothing to do: []\n\nOn reflection: [1,2,3]');
  assert.strictEqual(r.orders, null);
  assert.match(r.error, /entry 0 is not an object/);
  assert.doesNotMatch(r.error, /empty/);
});

test('a title over the cap is cut to it', () => {
  const r = pm.extractPlan(JSON.stringify([{ title: 'a'.repeat(250), prompt: 'p' }]));
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].title.length, 200);
});

test('a non-string acceptance is emptied, not stringified', () => {
  // "[object Object]" is not a criterion, and a reviewer would be judging the
  // order against it.
  for (const bad of ['{"a":1}', '42', 'true', 'null', '["x"]']) {
    const r = pm.extractPlan(`[{"title":"a","prompt":"p","acceptance":${bad}}]`);
    assert.strictEqual(r.error, null, bad);
    assert.strictEqual(r.orders[0].acceptance, '', bad);
  }
});

test('the prompt echoed back is refused, not executed as a plan', () => {
  // A PM that cannot comply commonly repeats the format it was given. With a
  // placeholder sentence in "prompt" that echo IS a valid plan: one plausible
  // order, persisted, goal running, and the "order" is the instructions
  // talking back.
  const p = pm.buildPrompt({ text: 'g', projectPath: '/tmp/repo', maxOrders: 5 });
  for (const echo of [p, 'Confirm the format:\n' + p.slice(p.indexOf('[\n')), p + '\n\nI cannot comply.']) {
    const r = pm.extractPlan(echo);
    assert.strictEqual(r.orders, null);
    assert.match(r.error, /entry 0 has no prompt/);
  }
});

test('the skeleton with its placeholders filled in is a plan', () => {
  // The other half of the rule above: only the blank template is refused. A PM
  // that used the shape and did the work is indistinguishable from one that
  // wrote a plan freehand, and should be.
  const p = pm.buildPrompt({ text: 'g', projectPath: '/tmp/repo', maxOrders: 5 });
  const filled = p.replace('"prompt": ""', '"prompt": "port the parser"');
  const r = pm.extractPlan(filled);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.orders[0].prompt, 'port the parser');
});

test('a non-string title is emptied, not stringified', () => {
  // Cosmetic - a title is a board label, never judged - but lib/orders does
  // not backstop it: optionalText rejects non-strings and passes a stringified
  // one straight through.
  for (const bad of ['42', '{"a":1}', 'true', '["x"]']) {
    const r = pm.extractPlan(`[{"title":${bad},"prompt":"p"}]`);
    assert.strictEqual(r.error, null, bad);
    assert.strictEqual(r.orders[0].title, '', bad);
  }
});

test('arraySpans finds balanced top-level spans and nothing else', () => {
  // Exported for this test rather than for callers: it holds the subtle rules,
  // and pinning it directly says which layer broke when extraction goes wrong.
  assert.deepStrictEqual(pm.arraySpans('prose [1] more'), ['[1]']);
  assert.deepStrictEqual(pm.arraySpans('["a ] b"]'), ['["a ] b"]']);
  assert.deepStrictEqual(pm.arraySpans('["a [ b"]'), ['["a [ b"]']);
  assert.deepStrictEqual(pm.arraySpans('[1] then [2]'), ['[1]', '[2]']);
  assert.deepStrictEqual(pm.arraySpans('[[1],[2]]'), ['[[1],[2]]'], 'top level only');
  assert.deepStrictEqual(pm.arraySpans('stray ] then [1]'), ['[1]'], 'recovers');
  assert.deepStrictEqual(pm.arraySpans('[1 unclosed'), []);
  assert.deepStrictEqual(pm.arraySpans(''), []);
});

test('extractPlan does NOT strip ANSI - that is plan.js\'s job, and only its job', () => {
  // The split is deliberate and both halves need pinning. Without this, pm.js
  // could start stripping, after which removing lib/plan's stripAnsi leaves
  // every test green while goal.rawPlan silently carries escape codes - the
  // evidence a human reads when a plan goes wrong. If this test ever fails,
  // the fix is to decide which layer owns stripping, not to make both do it.
  const coloured = '\u001B[32mHere is the plan:\u001B[0m\n'
    + '[{"title":"one","prompt":"do one","acceptance":"a"}]';
  const { orders, error } = pm.extractPlan(coloured);
  assert.strictEqual(orders, null);
  assert.match(error, /no JSON plan/, 'pm.js has started stripping ANSI itself');
});
