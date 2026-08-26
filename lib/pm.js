'use strict';

// The PM prompt, and getting a plan out of whatever the agent actually
// printed. Pure: no spawning, no store, no filesystem - so it can be
// table-tested against real transcripts, including the malformed ones, which
// is the half that matters. lib/plan.js drives it.
//
// Known limits:
// - arraySpans() finds only BALANCED, top-level [...] spans. An unmatched '['
//   or an odd number of '"' in the prose BEFORE the plan therefore hides the
//   plan: the scanner is still inside that bracket or that string when the
//   real array goes by, and extraction reports "no JSON plan". Two tests pin
//   this so the limit is known rather than assumed. It is not chased because
//   the recovery - rescanning past each unmatched opener, or collecting nested
//   spans as well - turns a linear scan into a quadratic one on deeply nested
//   input, and the failure it would fix is both rare and already visible: the
//   goal keeps the PM's raw output, so a human sees exactly what came back.
// - "The last plausible array wins" means the last array that is SHAPED like a
//   plan (non-empty, all objects). An array that parses but is not plan-shaped
//   - '[1,2,3]' or '[]' in a closing sentence - is remembered as the reason
//   and skipped, so trailing prose cannot mask a real plan printed above it.
//   The cost: a PM that prints a plan and then retracts it with a literal '[]'
//   has its retraction ignored. Prose brackets are common and deliberate
//   retractions are not, so that trade is taken knowingly.
// - Nothing here caps the NUMBER of orders. goals.withinBudget owns that
//   decision, and it needs the real count to report "N orders, over the limit
//   of M" - so a plan that is too long must arrive intact, not pre-truncated.
// - Lengths are validated, never truncated, for everything an agent will
//   actually execute or be judged against. See rejects() below. The one
//   exception is `title`, which is truncated: it is a label on a board, not
//   an instruction and not a criterion. lib/orders splits them the same way.
// - A non-string title or acceptance is read as absent, not stringified. An
//   acceptance of "[object Object]" is not a criterion, and a reviewer would
//   be judging the order against it.
// - The scan is one linear pass and the spans are disjoint, so the total
//   parsing work is bounded by the length of the transcript. plan.js caps
//   what it captures at 10MB, and there is no second cap here: measured, 20MB
//   of prose around one plan extracts in ~70ms, and a million empty arrays -
//   the worst span count 3MB can hold - in ~97ms. Synchronous either way, so
//   a caller inside an HTTP handler blocks for it.

// Matches lib/orders' MAX_PROMPT exactly. Not imported: this module is
// deliberately free of every dependency so it can be tested as pure string
// work. If they drift, orders.create() throws on text extractPlan accepted -
// inside plan.js's entries.map(), which has no catch, after earlier orders in
// the same plan are already persisted. Keep them equal.
const MAX_TEXT = 100000;
const MAX_TITLE = 200;

function buildPrompt({ text, projectPath, maxOrders }) {
  // Refused, not defaulted. A prompt reading "AT MOST undefined work orders"
  // is a cap that has silently stopped being a cap - the exact failure
  // goals.withinBudget refuses to make - and it costs a full credentialed
  // agent run to discover. lib/plan.js validates the cap before it ever gets
  // here, so this only fires on a programming error, which is when a loud
  // throw is worth most.
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('projectPath is required');
  }
  if (typeof maxOrders !== 'number' || !Number.isFinite(maxOrders) || maxOrders < 1) {
    throw new Error(`maxOrders must be a finite number >= 1, got ${JSON.stringify(maxOrders)}`);
  }
  // Floored, because goals.withinBudget accepts `count <= cap`: with a cap of
  // 2.5 the largest plan that passes is 2, so 2 is the number the PM must be
  // told. Asking for "at most 2.5" and then refusing 3 is a cap the PM was
  // never given a chance to respect.
  const cap = Math.floor(maxOrders);
  return [
    `You are planning work for a software project at: ${projectPath}`,
    '',
    'READ the project to understand it. Do NOT modify any files - this is a',
    'planning pass only.',
    '',
    'The goal:',
    text,
    '',
    `Break this into AT MOST ${cap} independent work orders. Fewer is`,
    'better. Each order will be executed by a separate agent that sees only',
    'that order, in its own copy of the repository, with no memory of the',
    'others - so each prompt must stand completely alone.',
    '',
    'Reply with ONLY a JSON array, no commentary before or after:',
    '',
    '[',
    '  {',
    '    "title": "short label",',
    '    "prompt": "the complete instruction for one agent, self-contained",',
    '    "acceptance": "how a reviewer will judge whether this order was done"',
    '  }',
    ']',
    '',
    'The acceptance criteria matter: another agent will later judge the result',
    'against them, and will not take the worker\'s own claim of success at',
    'face value. Make them checkable.',
  ].join('\n');
}

// Scan for balanced brackets while respecting string literals and escapes, so
// a brace or bracket inside a prompt does not break the extraction - and the
// prompt is exactly the field most likely to carry one. Returns every
// balanced, top-level [...] span in the text, in the order they close.
function arraySpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      // Order matters: a backslash that is itself escaped ("\\\\" in the
      // transcript, one literal backslash) must not escape the quote after it.
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        // A stray ']' in prose. Reset rather than going negative, so the next
        // real '[' still opens a span.
        depth = 0;
        start = -1;
      }
    }
  }
  return spans;
}

// Array.from iterates by code point, so a cut never lands between the halves
// of a surrogate pair and leaves a broken glyph in the UI. lib/orders.truncate
// learned this; a plain slice(0, n) here would hand orders.create a title
// already broken at the boundary, and its own code-point truncate would then
// preserve the lone surrogate rather than repair it.
function truncateTitle(value) {
  return Array.from(value.trim()).slice(0, MAX_TITLE).join('');
}

// Rejected rather than truncated, exactly as lib/orders does for prompt and
// acceptance: a truncated prompt is not a shorter version of the same
// instruction, it is a different instruction that still looks plausible - the
// agent runs it, exits 0, and the order reads as succeeded. A truncated
// acceptance is the same failure one step later, at the verdict.
//
// This must also refuse everything orders.create would throw on, because
// plan.js creates orders in an uncaught .map(): a throw there aborts the goal
// halfway with some orders already on disk, while an error returned from here
// fails the goal cleanly with the PM's raw output kept.
function rejects(value, index, label) {
  return value.length > MAX_TEXT
    ? `entry ${index} ${label} is too long (${value.length} > ${MAX_TEXT})`
    : null;
}

function cleanEntry(entry, index) {
  // notAPlan() has already screened this at the call site below. Kept so
  // cleanEntry is safe to call on its own; a mutation sweep will report it
  // as an equivalent mutant, and that is what it is.
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: `entry ${index} is not an object` };
  }
  // A non-string prompt is a missing prompt, not something to stringify: an
  // order carrying "[object Object]" still dispatches a real agent.
  const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
  if (!prompt) return { error: `entry ${index} has no prompt` };
  const tooLong = rejects(prompt, index, 'prompt');
  if (tooLong) return { error: tooLong };
  const acceptance = typeof entry.acceptance === 'string' ? entry.acceptance.trim() : '';
  const acceptanceTooLong = rejects(acceptance, index, 'acceptance');
  if (acceptanceTooLong) return { error: acceptanceTooLong };
  const title = typeof entry.title === 'string' ? truncateTitle(entry.title) : '';
  // Exactly three fields reach the caller, built fresh rather than spread from
  // the entry. The PM is an agent, and anything else it invents - a cwd, an
  // agent id, a status - must not reach an order record.
  return { order: { title, prompt, acceptance } };
}

// Why a parsed array is not a plan, or null if it is one. Shape only; the
// contents are cleanEntry's job.
function notAPlan(parsed) {
  if (parsed.length === 0) return 'the PM returned an empty plan';
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `entry ${i} is not an object`;
  }
  return null;
}

// Returns { orders, error } - orders null on failure, error null on success.
// Never throws: unparseable output is an outcome to record, and the caller
// keeps the raw text either way. That is why every input, including null,
// undefined, a number and a ten-megabyte transcript, has to come back as a
// value.
function extractPlan(output) {
  const text = typeof output === 'string' ? output : '';
  const spans = arraySpans(text);
  // Why the last array is remembered rather than the first: agents commonly
  // show a draft and then a corrected final answer, and the last one is the
  // one they meant.
  let rejection = null;
  for (let i = spans.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(spans[i]);
    } catch (_) {
      continue;
    }
    // Unreachable in practice - a span starts with '[' and ends with ']', so
    // JSON.parse either returns an array or throws - and kept only so the
    // Array assumption below is stated rather than assumed.
    if (!Array.isArray(parsed)) continue;
    const wrongShape = notAPlan(parsed);
    if (wrongShape) {
      // Keep looking. A '[1,2,3]' or '[]' in a closing sentence sits after the
      // real plan, and taking it would throw away the plan printed above it.
      // The first such reason found - the latest in the text - is what gets
      // reported if no plan turns up at all.
      if (!rejection) rejection = wrongShape;
      continue;
    }
    const orders = [];
    for (let n = 0; n < parsed.length; n++) {
      const r = cleanEntry(parsed[n], n);
      // A plan-shaped array with a bad entry is refused outright, not skipped:
      // it IS the PM's final answer, and falling back to an earlier draft
      // would execute a plan the PM had already replaced.
      if (r.error) return { orders: null, error: r.error };
      orders.push(r.order);
    }
    return { orders, error: null };
  }
  return { orders: null, error: rejection || 'the PM returned no JSON plan' };
}

module.exports = { buildPrompt, extractPlan, arraySpans };
