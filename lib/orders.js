'use strict';
const crypto = require('crypto');
const store = require('./store');

// A work order is the unit an agent executes and the unit the board watches.
// This module owns the record and its lifecycle only: it knows nothing about
// git, nothing about spawning, and never touches a filesystem outside `root`.
//
// Known limits:
// - The verdict fields are written by recordVerdict ONLY, and that is the one
//   writer allowed to touch a SETTLED order. It accepts nothing outside
//   VERDICT_FIELDS, so "a rejected order is never mutated except for its
//   verdict fields" (spec 12) is a property of this module rather than of every
//   caller's care. Records written before plan 2d carry none of those keys;
//   every reader here and in lib/chains reads an absent one as null (and
//   verdictRuns as 0), so a 2c store needs no migration.
// - `supersedes` is set at creation and never again. supersededBy is NOT
//   stored anywhere: it is derived by lib/chains from the records that point
//   back, so adding an attempt never writes to the attempt it replaces.
// - acceptance defaults to '' rather than null, because it is validated free
//   text the caller may legitimately omit, not an id or a judgement that is
//   absent until something sets it.
// - Same cross-process race as lib/projects: each order is its own file, so
//   two writers collide only on the same order, not on the whole collection.
//   That is strictly better than projects.json but still unlocked.
// - list() opens every order file on every call, and countToday() goes through
//   list(). Measured at 2000 orders: list() 41ms, countToday() 38ms, all
//   synchronous and therefore blocking the event loop inside an HTTP handler.
//   Fine at tens. The board in plan 3 polls, and that is where an index
//   belongs - recorded here so it does not have to be rediscovered.
// - `error` on disk carries two shapes: the sentinel 'timeout', and free prose
//   such as 'worktree: dirty tree'. A reader matches 'timeout' exactly and
//   treats anything else as prose. There is no separate reason code.
//
//   'cancelled' is NOT one of them, despite being a runner-level error value.
//   dispatch consumes it as a branch condition and calls markCancelled, which
//   sets status and finishedAt only - so a cancelled order reads
//   `status=cancelled error=null` on disk. That is deliberate: status already
//   carries the fact, and a second field repeating it is one more thing that
//   can disagree. Match on STATUS for cancellation, not on error.

const SUB = 'orders';
// lib/pm.js validates plan text against this same number and says so; if the
// two drift, extractPlan accepts text create() then throws on - inside
// plan.js's uncaught map, after earlier orders of the plan are on disk.
const MAX_PROMPT = 100000; // a prompt carrying an injected Skill body is large
const MAX_TITLE = 200;

// Terminal states. A settled order is never rewritten: a late close event from
// a process we already timed out would otherwise erase why it really ended.
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

// A bare randomUUID carries no creation order, and Date.now() collides: two
// orders created back to back land in the same millisecond ~78% of the time,
// leaving "newest first" to fall through to the random UUID and come out
// backwards on a third of pairs. Prefix the id with the timestamp plus a
// per-process tick so creation order is recorded in the id itself and the
// lexicographic contract store.list() already promises becomes meaningful.
// Zero-padded so string comparison matches numeric order.
//
// The tick resets on restart, so two orders created in the same millisecond by
// two different processes can still tie - unreachable for a localhost tool
// that creates orders from a human clicking, and strictly better than random.
let lastMs = 0;
let tick = 0;

function newId() {
  const now = Date.now();
  if (now === lastMs) tick++;
  else { lastMs = now; tick = 0; }
  return 'ord-' + String(now).padStart(14, '0') + String(tick).padStart(4, '0')
    + '-' + crypto.randomUUID();
}

function rel(id) {
  return `${SUB}/${id}.json`;
}

// Rejects rather than truncates. A truncated prompt is not a smaller version
// of the same instruction, it is a different instruction that still looks
// plausible - the agent runs it, exits 0, and the order reads as succeeded.
// Optional, but validated rather than truncated when present. acceptance is the
// criterion a verdict is judged against in plan 2b, so a silently shortened one
// is the same failure as a shortened prompt - plausible, wrong, and it passes -
// except that by then the original is gone from disk.
function optionalText(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const s = value.trim();
  if (s.length > max) throw new Error(`${label} is too long (${s.length} > ${max})`);
  return s;
}

// Array.from iterates by code point, so a cut never lands between the halves of
// a surrogate pair and leaves a broken glyph in the UI.
function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, max).join('');
}

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const s = value.trim();
  if (s.length > max) throw new Error(`${label} is too long (${s.length} > ${max})`);
  return s;
}

// Every field a verdict may write, and the only ones recordVerdict accepts.
// `retryRefused` is here because it is the verdict's CONSEQUENCE, written once
// when lib/attempts decides a rejection will not be retried - and because
// lib/chains needs it on disk to tell "rejected, retry coming" from "rejected,
// final" across a restart.
const VERDICT_FIELDS = new Set([
  'verdict', 'verdictReason', 'verdictState', 'verdictError', 'verdictRaw',
  'verdictAgent', 'verdictLog', 'verdictRuns', 'verdictStartedAt', 'verdictAt',
  'retryRefused',
]);
// null: not attempted. judging: a judge has claimed it (persisted so a restart
// can see one was interrupted). judged: `verdict` is set and is permanent.
// error: the judge produced no usable verdict; verdictError says why.
const VERDICT_STATES = new Set([null, 'judging', 'judged', 'error']);
// Exactly two verdicts. A judge that could not decide has not given a third
// one; it has given none, and that is verdictState 'error' with verdict null.
const VERDICTS = new Set([null, 'verified', 'rejected']);
// Same rule lib/worktrees applies to the id it turns into a branch: no leading
// dash, no path separators. A `supersedes` is followed by readers, and a '../'
// reaching store.abs() throws inside a GET.
const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function optionalId(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TITLE || !PLAIN_ID.test(value)) {
    throw new Error(`${label} must be an order id, got ${JSON.stringify(value)}`);
  }
  return value;
}

// The prompt becomes one argv element of the agent CLI, and the CLI parses its
// own arguments: "--dangerously-skip-permissions" as a whole prompt is that
// flag, not text. server.js ends option parsing with "--" for the CLIs known
// to honour it; this covers the ones that could not be confirmed, and every
// order - human, PM-planned or retry - is made here.
function assertNotOptionLike(prompt) {
  if (prompt.startsWith('-')) {
    throw new Error('prompt must not start with "-" (an agent CLI would read it as an option)');
  }
}

function create(root, input) {
  const src = input && typeof input === 'object' ? input : {};
  const projectId = requiredText(src.projectId, 'projectId', MAX_TITLE);
  const prompt = requiredText(src.prompt, 'prompt', MAX_PROMPT);
  assertNotOptionLike(prompt);

  const order = {
    id: newId(),
    projectId,
    goalId: null,
    seq: null,
    title: truncate(src.title, MAX_TITLE),
    prompt,
    acceptance: optionalText(src.acceptance, 'acceptance', MAX_PROMPT),
    agent: null,
    cwd: null,
    status: 'queued',
    exitCode: null,
    verdict: null,
    verdictReason: null,
    verdictState: null,
    verdictError: null,
    // The judge's raw output, ONLY when it could not be read as a verdict, and
    // only its last 16000 characters - the full transcript is in verdictLog.
    // Truncated because it is a diagnostic copy, not an instruction or a
    // criterion; every list() call opens this record.
    verdictRaw: null,
    verdictAgent: null,
    verdictLog: null,
    verdictRuns: 0,
    verdictStartedAt: null,
    verdictAt: null,
    retryRefused: null,
    error: null,
    supersedes: optionalId(src.supersedes, 'supersedes'),
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  store.writeJson(root, rel(order.id), order);
  return order;
}

function get(root, id) {
  return store.readJson(root, rel(id), null);
}

// store.js deliberately quarantines unparseable records so one bad file cannot
// stop the app booting. A record that parses but has the wrong shape defeats
// that: it reaches the sort and throws, and reconcile() is the boot path.
// Drop it here instead - loudly enough to debug, quietly enough to start.
function usable(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (typeof o.id !== 'string' || typeof o.createdAt !== 'string') return false;
  return true;
}

// Once per id, not once per call: list() runs on every board poll, and a single
// malformed file would otherwise bury the log it is trying to surface.
const warned = new Set();

function warnMalformed(id) {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn('[orders] skipping malformed record: ' + id);
}

function list(root, filter) {
  const f = filter || {};
  // Carry the filename id alongside the record: a malformed record may have no
  // usable id of its own, and the warning has to name something findable.
  const all = store
    .list(root, SUB)
    .map((id) => ({ id, rec: get(root, id) }))
    .filter(({ id, rec }) => {
      if (usable(rec)) return true;
      if (rec !== null) warnMalformed(id); // absent is normal; wrong-shape is not
      return false;
    })
    .map(({ rec }) => rec);
  const picked = f.projectId ? all.filter((o) => o.projectId === f.projectId) : all;
  // Newest first: the board reads top-down and the newest order is the one a
  // human just created. createdAt is only millisecond-resolution and orders
  // routinely share one, so the id breaks the tie - it embeds the monotonic
  // tick from newId(), which is the only record of order within a millisecond.
  // Without that fallback the tie falls through to store.list()'s
  // lexicographic-by-UUID order, which is arbitrary.
  return picked.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  );
}

// Every transition out of a live state goes through here so the settled-state
// rule cannot be forgotten at one call site. reconcile() is the one deliberate
// exception and says why at its own definition.
function patch(root, id, changes) {
  const o = get(root, id);
  if (!o) return null;
  if (SETTLED.has(o.status)) return o;
  const next = { ...o, ...changes };
  store.writeJson(root, rel(id), next);
  return next;
}

// goalId and seq were reserved when the record shape was fixed, so that adding
// goals later would not change it under an already-persisted store. This is the
// writer that fills them; it runs once, immediately after create, before
// anything can settle the order.
//
// Validated rather than coerced. String(goalId) on a nullish id writes the
// literal "null", and Number(seq) on anything unparseable writes NaN - which
// JSON.stringify turns into `null` on disk, the exact value that means "not
// attached". Either one leaves an order that reads as belonging to a goal it
// cannot be found under, or as attached with no position in the plan. Throwing
// is safe here: lib/plan.js records each order id BEFORE calling this, inside a
// try that cancels every id it recorded - so a throw from here fails the goal
// and takes the order it was attaching down with it, rather than persisting
// half a plan.
function attachToGoal(root, id, goalId, seq) {
  if (typeof goalId !== 'string' || !goalId.trim()) {
    throw new Error(`goalId is required, got ${JSON.stringify(goalId)}`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`seq must be a non-negative integer, got ${JSON.stringify(seq)}`);
  }
  return patch(root, id, { goalId: goalId.trim(), seq });
}

function markRunning(root, id, { cwd, agent }) {
  return patch(root, id, {
    status: 'running',
    cwd: cwd || null,
    agent: agent || null,
    startedAt: new Date().toISOString(),
  });
}

// exitCode 0 is the ONLY success. Note this records that the process exited
// zero, not that it did the right thing - that judgement is the PM verdict in
// plan 2b, and collapsing the two is the most common multi-agent failure.
function markFinished(root, id, { exitCode = null, error = null }) {
  const timedOutOrKilled = error !== null;
  return patch(root, id, {
    status: !timedOutOrKilled && exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: timedOutOrKilled ? null : exitCode,
    error,
    finishedAt: new Date().toISOString(),
  });
}

// A failure before anything started - a worktree that could not be created,
// an agent binary that is not installed. startedAt stays null so the board can
// tell "never ran" from "ran and failed".
function markFailed(root, id, error) {
  // error is this record's only diagnosis, so a nullish argument must not land
  // on disk as an error literally named "undefined".
  const message = error === undefined || error === null
    ? 'unspecified failure'
    : String(error);
  return patch(root, id, {
    status: 'failed',
    error: message,
    startedAt: null,   // nothing ever ran; the comment above says so, so enforce it
    finishedAt: new Date().toISOString(),
  });
}

function markCancelled(root, id) {
  return patch(root, id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
  });
}

// The one writer allowed on a SETTLED order, and it may write verdict fields
// only. Three rules, each pinned in test/orders.test.js:
//
//  - Only on a settled order. A verdict on live work judges work still being
//    done; the record comes back unchanged, as patch() does for the opposite
//    case.
//  - A JUDGED verdict is permanent. Re-judging would overwrite the only
//    evidence of what the PM decided, which spec 12 says is the thing worth
//    keeping. The one later write is retryRefused.
//  - retryRefused is written ALONE, ONCE, and only after a rejection. It is the
//    record of a final refusal to retry; a second write would rewrite why.
//
// Validated, not coerced, like every writer here: a verdict of 'pass' is not a
// third verdict, it is a caller fault.
function recordVerdict(root, id, changes) {
  const src = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  const keys = Object.keys(src);
  const stray = keys.filter((k) => !VERDICT_FIELDS.has(k));
  if (stray.length) throw new Error(`not verdict fields: ${stray.join(', ')}`);
  if ('verdictState' in src && !VERDICT_STATES.has(src.verdictState)) {
    throw new Error(`verdictState must be judging, judged, error or null, got ${JSON.stringify(src.verdictState)}`);
  }
  if ('verdict' in src && !VERDICTS.has(src.verdict)) {
    throw new Error(`verdict must be "verified", "rejected" or null, got ${JSON.stringify(src.verdict)}`);
  }
  if ('retryRefused' in src && keys.length !== 1) {
    throw new Error('retryRefused is written on its own, after the verdict it follows');
  }

  const o = get(root, id);
  if (!o) return null;
  if (!SETTLED.has(o.status)) return o;

  if ('retryRefused' in src) {
    if (o.verdictState !== 'judged' || o.verdict !== 'rejected' || o.retryRefused) return o;
    const message = src.retryRefused === undefined || src.retryRefused === null
      ? 'unspecified refusal'
      : String(src.retryRefused);
    const next = { ...o, retryRefused: message };
    store.writeJson(root, rel(id), next);
    return next;
  }
  if (o.verdictState === 'judged') return o;
  const next = { ...o, ...src };
  store.writeJson(root, rel(id), next);
  return next;
}

// Local date, not UTC. This is a single-user tool on the user's own machine,
// and a cap that resets at 7pm because the host is UTC-5 is a bug the user
// experiences as "my limit cleared early".
function localDay(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Counted from persisted records rather than an in-memory tally, so the limit
// survives a restart.
function countToday(root, projectId) {
  const today = localDay(new Date());
  return list(root, { projectId }).filter((o) => localDay(o.createdAt) === today).length;
}

// On boot, any order still marked running lost its child process when the
// previous server died. It is never assumed to have succeeded.
//
// This is the one transition that bypasses patch(), deliberately: patch()
// refuses to move a settled order, and 'interrupted' IS settled, so routing
// this through it would make reconcile a no-op the moment it mattered. Every
// order it touches is by definition still live, so the rule patch() enforces
// is not in question here.
function reconcile(root) {
  let n = 0;
  for (const o of list(root)) {
    if (o.status !== 'running') continue;
    store.writeJson(root, rel(o.id), {
      ...o,
      status: 'interrupted',
      error: 'interrupted',
      finishedAt: new Date().toISOString(),
    });
    n++;
  }
  return n;
}

// On boot, a verdict still `judging` lost its judge with the process. It is
// recorded as an error, NOT reset to null for the loop to pick up again: that
// would be the first silent automatic re-run in this codebase, and it mirrors
// lib/goals failing a `planning` goal on boot rather than replanning it. The
// human's door is POST /api/orders/:id/verdict/retry.
//
// BOOT-ONLY, like reconcile() above, and for the same reason: mid-run it would
// overwrite a judgement that is genuinely in flight. server.js calls it after
// reconcile() and BEFORE scheduler.start() - the scheduler's first tick reads
// an unclaimed `judging` as "awaiting a verdict" and would stall the goal at
// `planned` with nothing ever going to finish it.
//
// Through recordVerdict rather than a direct write: these orders are settled
// and not judged, so recordVerdict's rules permit exactly this, and one writer
// means one place the verdict-field rule lives.
function reconcileVerdicts(root) {
  let n = 0;
  for (const o of list(root)) {
    if (o.verdictState !== 'judging') continue;
    recordInterrupted(root, o.id);
    n++;
  }
  return n;
}

function recordInterrupted(root, id) {
  return recordVerdict(root, id, {
    verdictState: 'error',
    verdictError: 'interrupted while judging',
    verdictAt: new Date().toISOString(),
  });
}

module.exports = {
  create, get, list, attachToGoal, markRunning, markFinished, markFailed,
  markCancelled, countToday, reconcile, newId, SETTLED,
  recordVerdict, reconcileVerdicts, VERDICT_FIELDS, MAX_PROMPT,
};
