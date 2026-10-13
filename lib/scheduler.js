'use strict';
const orders = require('./orders');
const goals = require('./goals');
const projects = require('./projects');
const dispatch = require('./dispatch');
const verdict = require('./verdict');
const attempts = require('./attempts');
const chains = require('./chains');

// Runs a goal's orders without a human dispatching each one.
//
// TWO KINDS OF CHECK LIVE HERE, and calling them all advisory - as this
// comment did until a mutation sweep showed otherwise - points the reader at
// the wrong one.
//
// The first kind SHADOWS a gate dispatch.runOrder already enforces: isClaimed
// shadows its duplicate check, projectBusy its unisolated-project check,
// atCapacity its ceiling. THOSE are purely advisory. The authority is the
// synchronous claim inside runOrder, and a caller that skips this module
// entirely is bounded exactly as well; these exist only to avoid pointless
// work. Delete one and nothing becomes unsafe - runOrder refuses, the order
// stays `queued`, the next tick tries again - so their ONLY observable is the
// refusal. That is why the tests pin them on stats().refused rather than on
// agent counts, which cannot tell a working check from a missing one.
//
// The second kind has NO counterpart in runOrder and is therefore LOAD-BEARING:
// whether the goal is settled, whether it is still being planned, whether its
// record can be read at all, the per-goal budget, and the daily cap. runOrder
// knows nothing about goals, and it answers a reached daily cap by marking the
// order FAILED rather than refusing it. Delete one of those and the damage is
// real and durable - an agent on a plan that does not exist yet, or an entire
// backlog settled `failed` in a single tick. Those are pinned on what happens,
// not on the refusal count.
//
// ONE PATTERN RUNS THROUGH MOST OF THE SECOND KIND, and it is worth naming as
// a class rather than as separate cases, because Task 5 and plan 2d both add
// callers: EVERY PLACE runOrder ANSWERS A FAULT BY SETTLING THE RECORD IS RIGHT
// PER REQUEST AND DESTRUCTIVE IN A LOOP. A human dispatching by hand burns one
// order and goes to fix the cause. A loop dispatching everything queued burns
// the whole backlog before anyone has read the first message - and `failed` is
// SETTLED, so nothing retries any of it. Four instances so far, every one
// handled here rather than there, because runOrder is right for its own caller:
//
//   the daily cap          pre-checked, so the backlog waits for tomorrow -
//                          which is also exactly how it is escaped; see below
//   an absent agent        skipped, so one missing binary does not settle every
//                          queued order in the store
//   a goal still planning  skipped, so lib/plan's rollback cannot settle a
//                          record this loop already put an agent on
//   a prepare that throws  counted per project, and the project is paused after
//                          a few in a row, so a broken repo or a full disk
//                          costs a handful of orders instead of all of them
//   a spawn that fails     the same brake, but it took a fix one module away to
//                          make it reachable - see below. Two doors led into
//                          this one and both are now shut
//
// The question to ask of the next one is not "can runOrder handle this" - it
// can - but "what does it cost when it happens five hundred times in a hundred
// milliseconds".
//
// THE FIFTH ONE IS THE INSTRUCTIVE ONE, because it could not be pre-checked and
// it defeated the brake built for the fourth. A binary renamed mid-run - an
// `npm i -g` window, a PATH change - fails asynchronously, and lib/dispatch
// wrote markRunning one line ABOVE the spawn, so the order settled `failed`
// WITH a startedAt. This module reads startedAt as "an agent existed", so every
// one of those counted as a successful start and actively cleared the project's
// failure count: twelve orders drained in two seconds with pausedProjects at 0
// and the goal reading `done`. The fix is not a gate here - you cannot know a
// spawn will fail until you try - it is in the CLASSIFICATION, and it belonged
// at the source: lib/runner now reports whether a process ever existed (Node
// emits 'spawn' or 'error', never both) and lib/dispatch calls markFailed,
// which nulls startedAt, when it did not. The rule was already written down in
// lib/orders, which names "an agent binary that is not installed" as a
// markFailed case; dispatch simply was not honouring it. Fixing it there also
// fixes the board, which reads the same field.
//
// THE SECOND DOOR WAS THE INSTRUCTIVE PART OF THE INSTRUCTIVE ONE. A
// SYNCHRONOUS runner.start throw - an unwritable logs/ is enough - reached the
// identical state by a different route, and was pinned open by a test arguing
// that the order "got as far as being marked running, so markFinished is the
// correct verb". That is a claim about which line dispatch reached, not about
// whether an agent ran. It has been overturned: no process existed there
// either, so it is markFailed too, and the two files that disagreed about what
// startedAt means now agree. Leaving it would have been worse than never having
// fixed the first door, because a reader seeing spawn failures correctly
// classified would reasonably assume the class was handled.
//
// A THIRD PATTERN, for whoever adds the fourth guard to the candidate loop:
// EVERY MISSING GUARD HERE HAS HIDDEN THE SAME WAY. Remove the check and the
// candidate throws instead - on a null record's property, on a reduce over a
// non-array - and the per-candidate catch turns that into a skip. The order
// stays queued and nothing is dispatched, so the two assertions anyone writes
// first both pass, on a loop that is failing on every tick forever. It has
// happened three times: the missing goal, the missing project, and the
// malformed orderIds. A guard's test must assert `errors === 0`, or it is
// pinning the crash rather than the guard.
//
// The git per-project concurrency bound is a third thing again, and mis-filing
// it in either box would be wrong: runOrder has no counterpart for it, so it is
// not a shadow - but exceeding it costs throughput rather than correctness,
// because the worktrees keep the agents apart. It is pinned on the count of
// agents actually alive, asserted as an equality so that both a bound that is
// too loose and one that is too tight fail.
//
// A POLL LOOP RATHER THAN AN EVENT, and the reason is specific: a settled order
// does NOT mean its project is claimable, because dispatch releases the project
// claim in a finally that runs after worktrees.cleanup - several git calls on a
// git project. Anything driven by "order settled" therefore dispatches into a
// project still held. Polling projectBusy() is what that costs.
//
// The second reason is the one lib/goals names this module for: A GOAL'S ORDERS
// CAN ALL SETTLE DURING BOOT, before this loop exists. lib/orders.reconcile
// settles a crashed goal's `running` orders to `interrupted`, then
// lib/goals.reconcile demotes the goal to `planned` - so boot can produce a
// goal claiming outstanding work with nothing outstanding, and NO FURTHER
// SETTLEMENT EVENT WILL EVER FIRE FOR IT. A purely reactive scheduler never
// fixes that goal. Reproduction is a single restart.
//
// The sweep that fixes it is not a separate startup pass. Every tick
// reconciles every live goal against its orders' real states, and start() runs
// one tick immediately rather than waiting out the first interval - so the
// startup sweep is the first tick, and a goal that goes all-settled at any
// later moment is corrected by the same code rather than by a second copy of it
// that could drift. reconcileGoals() below is that pass.
//
// It never calls goals.reconcile() or orders.reconcile(). Both are BOOT-ONLY
// and unguarded: mid-run, goals.reconcile() demotes every genuinely `running`
// goal and FAILS every `planning` goal a PM is still decomposing, silently and
// with no count to notice it by. markRunning/markPlanned/markDone are the
// per-goal, patch()-routed movers, and they are what this uses.
//
// Known limits:
// - THE TICK IS O(orders x projects-with-a-viable-candidate), NOT O(orders),
//   and an earlier version of this entry said the cheaper thing. orders.list()
//   and goals.list() open every record once per tick, which is the O(orders)
//   part - but the daily-cap gate calls orders.countToday(), which re-lists the
//   whole store AGAIN per project, memoised only within one tick. The
//   `totalOrders <= cap` skip below hides this until the store passes the cap,
//   and DEFAULT_BUDGET.maxOrdersPerDay is 100 for every project, so it stops
//   applying at 101 orders.
//
//   Measured on this machine with agentFor returning null, so only the gates
//   run: 80 orders / 4 projects 12ms; 500 / 4 74ms; 2000 / 4 499ms. That last
//   is half of the default interval, spent SYNCHRONOUSLY on the event loop this
//   module's own interval-floor note says is shared with every agent's stdout.
//   Fine at tens, which is what this tool is; recorded with real numbers
//   because Task 5's panel makes the tick's cost something a user can feel.
//   The fix is the index lib/orders already names as belonging with the board's
//   polling, or exporting its localDay() so the count can come off the snapshot
//   this tick already holds - not a second implementation of "today" here,
//   which is a second thing to get wrong by a timezone.
// - SINCE PLAN 2d, `done` MEANS EVERY ORDER CHAIN'S LATEST ATTEMPT WAS
//   VERIFIED, and this loop is what makes that true. Each tick: the retry pass
//   (lib/attempts) supersedes rejected orders, the judge pass (lib/verdict)
//   judges finished ones, the dispatch pass runs queued ones, and the goal
//   sweep settles goals from lib/chains.goalOutcome. Retry before judge before
//   dispatch, deliberately: finishing work in hand ahead of starting new work,
//   and a retry created this tick is queued for the NEXT tick's dispatch. The
//   order of judge-before-dispatch is pinned ('a verdict is judged before new
//   work is dispatched').
//
//   THE TICK IS THE ONLY AUTOMATIC TRIGGER for a verdict or a retry - there is
//   no "on completion" callback - for the poll-not-event reasons above, and
//   because a callback plus this tick would be two doors into one judge.
//
//   judgeFor IS OPTIONAL, unlike childEnv and agentFor, and the asymmetry is
//   argued: its absence leaks nothing and runs nothing anyone did not choose -
//   it means no verdicts, and every goal waits at `planned` rather than
//   finishing, which is honest and visible as stats().judging === false.
//   server.js always passes it; test/scheduler-api's deliverable test reaches
//   `done` only if it does.
// - THE GIT PER-PROJECT COUNT CAN UNDERCOUNT, and therefore admit one order
//   over project.concurrency. It counts the project's orders that
//   dispatch.isClaimed() answers true for, drawn from the tick's snapshot of
//   the store - so an in-flight order whose record was deleted mid-flight, or
//   malformed enough for orders.list to drop it, is not counted. Fail-open, and
//   accepted only because for a git project this bound is THROUGHPUT and not
//   correctness: every order still gets its own worktree, so one extra agent is
//   a slower repo, not a corrupted one. The dir branch, where one extra agent
//   would be exactly the corruption lib/worktrees exists to prevent, does not
//   use this count at all - it asks projectBusy, which reads dispatch's own
//   registry rather than a snapshot of the store.
//
//   The version of this file that shipped first asked projectBusy for BOTH
//   kinds. That serialised every git project to one order at a time, made
//   project.concurrency dead, and - not noticed until a reviewer narrowed it -
//   was the only thing holding up the per-goal budget, whose `spent` was
//   computed from the stale snapshot and so only ever saw one candidate per
//   project per tick. The two are fixed together because either alone is worse
//   than neither.
// - A RECORD IT CANNOT READ STALLS THE WORK RATHER THAN SETTLING IT. An order
//   whose project or goal record is missing or unparseable is skipped on every
//   tick, forever; a goal naming an order that no longer exists never reaches
//   `done`. Both fail closed, which is safe here only because dispatching by id
//   is still a human's door - the stalled work is reachable, just not by this.
// - A GOAL WHOSE PER-GOAL BUDGET REFUSES ITS REMAINING ORDERS STAYS `planned`
//   FOREVER. maxOrdersPerGoal bounds what this will spend, so the orders past
//   the cap are never dispatched, never settle, and the goal never reaches
//   `done`. That is the same shape as the failed-order limit above and is
//   visible in the record rather than hidden.
// - THE RE-ENTRANCY GUARD IS CURRENTLY UNREACHABLE, and this comment is not
//   claiming it protects anything today. Every call in a tick is synchronous -
//   runOrder is deliberately NOT awaited - so setInterval cannot re-enter it.
//   A mutation sweep says so rather than the reasoning alone: deleting the
//   guard leaves the whole suite green, and it is recorded here as an argued
//   equivalent rather than chased with a test that could not be written.
//   It stays because the first call in here that becomes asynchronous (an
//   indexed orders.list, a project probe) would overlap ticks silently, and
//   because that same synchrony is load-bearing for a different reason: it is
//   what keeps each advisory check atomic with respect to runOrder's claim, in
//   the way lib/dispatch and lib/plan both had to learn.
// - maxOrdersPerDay IS NOT A SPEND BOUND, AND THIS MODULE IS WHAT MAKES THAT
//   MATTER. orders.countToday counts orders CREATED today, not orders run, and
//   both this gate and runOrder's compare against it. Under plan 2a/2b a human
//   dispatched each order, so the human was the real bound; 2c removed the
//   human and left a cap that counts the wrong noun. A twelve-order goal
//   correctly blocked all day against a cap of 2 runs all twelve the moment
//   those records are no longer "today" - no restart, no config change, just a
//   date rolling over. Measured by backdating the records: twelve billed agent
//   runs on a project configured for two a day.
//
//   Not fixed here, deliberately. Counting starts instead of creations changes
//   what the cap MEANS for runOrder as well - it is the same countToday, with
//   runOrder's `>` comparison carefully cancelling the self-inclusion of an
//   order that is already persisted - so it is a change to a shared gate and
//   its arithmetic, not a scheduler decision. Recorded rather than half-fixed,
//   because a cap that is quietly not a cap is the failure lib/projects'
//   BUDGET_MAX comment already names.
// - FOR WHOEVER WIRES THIS INTO server.js, TWO ORDERING REQUIREMENTS, both
//   checked against the code rather than reasoned about:
//
//   stop() MUST BE CALLED, AND BEFORE ANYTHING THAT YIELDS. The SIGINT handler
//   calls cancelAll() synchronously and then spins a drain interval waiting for
//   agentsRunning() to reach 0. That drain is NOT unref'd, so the loop stays
//   alive - and this module's timer, unref'd or not, keeps firing inside it. A
//   tick landing there sees the orders that were just cancelled as settled,
//   picks the next queued ones, and SPAWNS FRESH CREDENTIALED AGENTS after
//   "cancelling N running agent(s)" has already printed. inFlightCount() climbs
//   instead of falling, so the drain never reaches zero and shutdown hangs to
//   the 6s hatch - which exits inside runOrder's await, leaving those new
//   worktrees on disk.
//
//   THIS ENTRY USED TO SAY "BEFORE dispatch.cancelAll(), NOT AFTER", and Task 5
//   disproved the "not after" half by measuring it. cancelAll(), reapRunning()
//   and plan.cancelAll() are all synchronous, so no tick can interleave between
//   two of those statements: moving stop() one line below them is an EQUIVALENT
//   mutant, and it survives. So does deferring it by a single timer turn, for a
//   different reason - the cancelled order holds its slot until runOrder's
//   `finally`, which runs after worktrees.cleanup, so every tick inside that
//   window is refused by the ceiling anyway.
//
//   What is measured to have teeth is DELETING the call, and DEFERRING IT PAST
//   THE POINT WHERE THAT SLOT IS RELEASED - hundreds of milliseconds later, and
//   where the free capacity a tick needs actually appears. Being first in the
//   handler is simply how there is no place left to put the await that would
//   get there. Pinned by 'the scheduler is stopped before agents are reaped at
//   SIGTERM' in test/scheduler-api.test.js, which has to hold the drain open
//   with an in-flight request to do it: without that the window is a few tens
//   of milliseconds and the test races it instead of measuring it.
//
//   start() MUST COME AFTER BOTH orders.reconcile() AND goals.reconcile(). The
//   plan gives one reason - a goal whose orders settled during boot needs the
//   sweep - and there is a second, from this module's own shape:
//   reconcileGoals derives `anyInFlight` SOLELY from dispatch.isClaimed, never
//   from a record reading `running`. A stale `running` order from a killed
//   process is claimed by nobody, so it counts as neither settled nor in
//   flight: the goal is written back to `planned` and, because nothing will
//   ever settle those orders, stalls there for good. orders.reconcile() is what
//   turns them into `interrupted` first.
//
//   IT IS THE GOAL SWEEP ALONE, and not the dispatch pass, which the plan's
//   wording invites a reader to assume. dispatchPass filters on
//   `status === 'queued'`, so a record still reading `running` from a killed
//   process is never a candidate, and a goal reading `running` rather than the
//   `planned` reconcile will demote it to is neither settled nor `planning`
//   either way - the same orders are offered on both sides of the swap.
//   Verified by moving start() above both reconciles: exactly one test fails,
//   and it is the goal's status.
// - server.js CALLS start() AT BOOT, after both reconciles, and stop() first in
//   the SIGINT/SIGTERM handler. It supplies the three things this module
//   refuses to invent: MAX_CONCURRENT_RUNS (through dispatch.setCapacity), the
//   childEnv allowlist, and agentFor over the agent registry - the last
//   resolved through routes/common.js's resolveAgent, so the loop refuses an
//   unrecognised agent exactly as both HTTP routes do rather than substituting
//   AGENTS[0].
//
//   SKILLSPACE_SCHEDULER=0 leaves it unstarted, which is a supported mode and
//   not a test hook: POST /api/orders/:id/dispatch is still the human's door,
//   and the loop is what makes using it optional. GET /api/scheduler reports
//   stats() so which way a given boot went is observable rather than guessed.
//
//   A HUMAN DISPATCHING A QUEUED ORDER BY ID NOW RACES THIS LOOP, and the loser
//   is refused rather than duplicated - runOrder's synchronous claim is the
//   authority, and both callers go through it. The order runs either way; what
//   varies is whether the route answers 200 or 409, and which agent it runs on
//   when the request named one. test/scheduler-api.test.js measures that race
//   at the shipped cadence rather than assuming a winner.
// - stop() DOES NOT CANCEL IN-FLIGHT ORDERS. It stops picking new work; orders
//   already dispatched run to completion and settle normally. Cancelling them
//   is dispatch.cancelAll(), which is the shutdown path's job, not this one's.
// - warnedOnce grows by one entry per order that is permanently unrunnable
//   (no agent, no project). Bounded by the number of such orders, not by time,
//   and it is the same trade lib/orders makes for its malformed-record warning:
//   one line per id beats one line per id per poll.

// The poll cadence. A default is fine here in a way that childEnv's would not
// be - this is a throughput knob, not a policy that can leak anything.
//
// Anything below the floor is treated as UNCONFIGURED and takes the default; it
// is not clamped up to the floor. A caller passing 0 or 1 has not made a
// considered choice about cadence, and the default is the considered one -
// whereas honouring it literally is a loop that re-reads every record in the
// store a thousand times a second and starves the event loop it shares with
// every agent's stdout.
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 10;

// The circuit breaker for the fourth instance of the class named at the top.
// A worktrees directory that is a file, a project.branch that no longer exists,
// a full disk, git missing: every one makes worktrees.prepare throw, and
// runOrder answers a throw by settling the order `failed`. Five queued orders
// were measured going from `queued` to permanently `failed` in about 100ms of
// wall clock, with stats() reporting perfect health - because a settle is not a
// refusal and nothing here was counting it.
//
// Three in a row, then the project is left alone for a minute. The counter is
// NOT reset by the pause expiring, so a project that is genuinely broken fails
// one order per minute rather than three, and a single success clears it
// outright. Per project, not global: one broken repo must not stop the others.
const FAILS_BEFORE_PAUSE = 3;
const PAUSE_MS = 60000;

let timer = null;
let config = null;
let ticking = false;
// `offered` counts dispatch ATTEMPTS, not starts, and the two genuinely differ
// - a probe once read five offers while all five orders were already `failed`.
// It was called `dispatched` for exactly as long as it took someone to render
// it in a panel. `started` is the half a reader actually wants.
// judgesOffered, retriesCreated and retriesRefused are plan 2d's: judgements
// the loop CLAIMED (a refused one is not counted), successor orders it
// created, and rejections it recorded as final (retryRefused).
const counts = {
  ticks: 0, offered: 0, started: 0, refused: 0, failedToStart: 0, errors: 0,
  skipped: 0, judgesOffered: 0, retriesCreated: 0, retriesRefused: 0,
};
let lastError = null;
let lastErrorAt = null;
let startedAtIso = null;
let lastTickAt = null;
const warnedOnce = new Set();
// projectId -> { consecutive, until }. Per-run state, cleared by start().
const trouble = new Map();
// Order ids this loop has dispatched and not yet heard back about. `started`
// cannot answer "how many agents are alive": it is incremented when runOrder
// RESOLVES, which is after worktrees.cleanup, so at the default 15-minute
// timeout a panel could read offered:4 started:0 for a quarter of an hour with
// four agents running. `started` is not renamed - routes/scheduler.js pins it
// by name and documents the lag on purpose - so the live number is added beside
// it rather than smuggled into it.
const dispatchedIds = new Set();
// Why the last candidate was passed over. `skipped` counts BLOCKED candidates -
// ones that will not run until something outside this loop changes - and NOT
// merely deferred ones (a busy project, a full ceiling, an order already in
// flight), which resolve themselves within a tick or two and would drown the
// signal. Without this, a scheduler correctly refusing to run twelve orders
// against a reached daily cap is indistinguishable from an idle one: running
// true, every counter zero, and not a line in the log, because warnOnce covers
// the unreadable records and not the caps.
let lastSkip = null;

function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn('[scheduler] ' + message);
}

// start(root, { intervalMs, childEnv, agentFor, judgeFor })
//
// childEnv is REQUIRED and deliberately not defaulted, for the third time in
// this codebase. The only sensible default is process.env, which on a
// developer's machine is every AWS, GitHub and npm token they hold, handed to
// an agent that needs its own provider key - precisely the leak the allowlist
// exists to prevent. lib/dispatch refuses per order and lib/plan refuses per
// goal; this refuses at start(), because a scheduler is configured once and a
// misconfiguration should fail at boot rather than at the first order.
//
// agentFor(order, project) is required for the same reason in a different
// currency: there is no sensible default agent, and picking one would run a
// human's prompt through a tool they did not choose. It MUST BE SYNCHRONOUS -
// see the re-entrancy note above - and returning nothing is a legal answer
// meaning "not now", not an error.
function start(root, options) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('root is required');
  }
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.childEnv !== 'function') {
    throw new Error('childEnv is required: a scheduler must not hand agents process.env');
  }
  if (typeof opts.agentFor !== 'function') {
    throw new Error('agentFor is required: there is no default agent to run a human\'s prompt through');
  }
  // Optional; see the Known limits. A present non-function is a configuration
  // fault, not a request to turn verdicts off.
  if (opts.judgeFor !== undefined && opts.judgeFor !== null && typeof opts.judgeFor !== 'function') {
    throw new Error('judgeFor must be a function when given');
  }
  // Refused rather than silently replaced. Two schedulers in one process is a
  // configuration fault, and a replace would hide it while leaking the first
  // timer - the shape that leaves a second loop dispatching against a root
  // nobody remembers configuring.
  if (timer) throw new Error('scheduler is already started');

  const raw = Number(opts.intervalMs);
  const intervalMs = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS
    ? Math.floor(raw)
    : DEFAULT_INTERVAL_MS;

  config = {
    root, childEnv: opts.childEnv, agentFor: opts.agentFor, judgeFor: opts.judgeFor || null, intervalMs,
  };
  counts.ticks = 0;
  counts.offered = 0;
  counts.started = 0;
  counts.refused = 0;
  counts.failedToStart = 0;
  counts.errors = 0;
  counts.skipped = 0;
  counts.judgesOffered = 0;
  counts.retriesCreated = 0;
  counts.retriesRefused = 0;
  lastSkip = null;
  dispatchedIds.clear();
  lastError = null;
  lastErrorAt = null;
  lastTickAt = null;
  startedAtIso = new Date().toISOString();
  trouble.clear();
  ticking = false;

  timer = setInterval(runTick, intervalMs);
  // So the loop never holds the process open. A background poll is not a reason
  // for `node -e "require('./lib/scheduler').start(...)"` to hang forever, and
  // the server has its own reasons to stay alive.
  timer.unref();

  // IMMEDIATELY, not after the first interval: this call is the startup sweep
  // that lib/goals asks for. A goal whose orders all settled during boot has no
  // settlement event left to fire, and waiting out an interval to notice it
  // would only make the stale window longer, not different.
  runTick();
  return { intervalMs };
}

// Clears the timer AND every piece of loop state, so a later start() is a clean
// start. Which parts of that are load-bearing, precisely, because two of the
// three are and one is not:
//
//   timer   MUST be cleared, or the orphaned interval keeps firing and starts
//           finding work again at the next start() - two loops at twice the
//           configured rate, one more per stop/start cycle. Nulling the handle
//           without clearInterval gets exactly that, and is its own test.
//   config  MUST be dropped, so an interval that somehow outlives the clear
//           finds nothing to do rather than dispatching against a stale root.
//   ticking is reset for completeness only, and this is NOT claiming it does
//           anything today: the tick is synchronous, so the flag is already
//           false whenever stop() can be reached. It matters on the day the
//           tick becomes asynchronous - the change the Known limits anticipate
//           - when a stop() landing mid-tick would otherwise leave it set and
//           make every future tick short-circuit: a scheduler that reports
//           itself started and does nothing at all.
//
// Safe to call when not started.
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  config = null;
  ticking = false;
}

// O(1) and no store reads, because a browser polls it. lastError carries a
// TIMESTAMP and is never cleared on its own: without the timestamp a panel
// cannot tell "erroring now" from "errored once at boot an hour ago", and the
// indicator stays red forever either way.
function stats() {
  const now = Date.now();
  let pausedProjects = 0;
  // WHICH projects, beside the count (plan 3, Task 0): the count alone cannot
  // tell a user looking at a quiet board whether the pause is theirs. Copies,
  // so a caller cannot reach into `trouble`. Still O(paused), not O(store).
  const pausedProjectIds = [];
  for (const [id, t] of trouble) {
    if (t.until <= now) continue;
    pausedProjects += 1;
    pausedProjectIds.push({ id, until: new Date(t.until).toISOString(), consecutive: t.consecutive });
  }
  return {
    ...counts,
    inFlight: dispatchedIds.size,
    lastSkip,
    running: !!timer,
    // Whether verdicts are being given at all. Without it a panel cannot tell
    // "nothing finished" from "nothing is judging what finished".
    judging: !!(config && config.judgeFor),
    intervalMs: config ? config.intervalMs : null,
    startedAt: startedAtIso,
    lastTickAt,
    lastError,
    lastErrorAt,
    pausedProjects,
    pausedProjectIds,
  };
}

// Recorded, not logged: this fires every tick for as long as the cap holds, and
// a line per tick would be the noise warnOnce exists to avoid. The counter and
// the reason are what a panel renders; the log stays for one-off faults.
function blocked(reason, orderId) {
  counts.skipped += 1;
  lastSkip = { reason, orderId, at: new Date().toISOString() };
}

function recordError(e, what) {
  counts.errors += 1;
  lastError = e && e.message ? e.message : String(e);
  lastErrorAt = new Date().toISOString();
  console.error('[scheduler] %s: %s', what, lastError);
}

// A dispatch that settled the record without ever running an agent. This is
// lib/orders' OWN discriminator, not one invented here: markFailed sets
// startedAt back to null and documents it as the way to tell "never ran" from
// "ran and failed", which is exactly the line the breaker needs.
function neverRan(record) {
  // The `!record.startedAt` half is UNREACHABLE from the only call site, and a
  // mutation sweep says so rather than the reasoning alone: the caller returns
  // early on any record that has a startedAt, so this only ever sees records
  // without one. It stays because the predicate is named for what it answers
  // and would be wrong standing alone without it - the same reason lib/orders
  // keeps startedAt null in markFailed rather than relying on its callers.
  return !!record && record.status === 'failed' && !record.startedAt;
}

function noteOutcome(projectId, failedToStart) {
  if (!failedToStart) {
    // Only a dispatch that actually STARTED clears the count. A refusal is not
    // evidence of health - it says nothing about whether the repo can produce a
    // worktree - so refusals leave the counter exactly where it was.
    trouble.delete(projectId);
    return;
  }
  counts.failedToStart += 1;
  const t = trouble.get(projectId) || { consecutive: 0, until: 0 };
  t.consecutive += 1;
  if (t.consecutive >= FAILS_BEFORE_PAUSE && t.until <= Date.now()) {
    t.until = Date.now() + PAUSE_MS;
    // Not warnOnce: this fires at most once per pause window, and a project
    // that stays broken should keep saying so rather than going quiet after the
    // first hour.
    console.warn('[scheduler] project %s failed to start %d orders in a row; '
      + 'pausing it for %ds', projectId, t.consecutive, Math.round(PAUSE_MS / 1000));
  }
  trouble.set(projectId, t);
}

function runTick() {
  // See the Known limits note: unreachable while every call in tick() is
  // synchronous. Kept as a tripwire, not credited with protecting anything now.
  if (ticking) return;
  // Also an argued equivalent, and listed as one: stop() clears the interval
  // before it drops config, so no tick can fire with config already null.
  // It stays for the same reason as the guard above - it is the line that keeps
  // an orphaned interval harmless if one is ever leaked - and deleting it
  // leaves the suite green, which is recorded rather than chased.
  if (!config) return;
  ticking = true;
  try {
    counts.ticks += 1;
    lastTickAt = new Date().toISOString();
    tick(config);
  } catch (e) {
    // A poll loop that dies silently is indistinguishable from one that has no
    // work, which is the worst failure this module could have: the board fills
    // with queued orders and nothing says why. Counted and logged, and the
    // interval survives - setInterval would keep firing regardless, but the
    // throw would escape to an uncaught handler and take the process with it.
    recordError(e, 'tick failed');
  } finally {
    ticking = false;
  }
}

// One snapshot of the store per tick, shared by every pass. Re-reading between
// them would not be more accurate - the records this tick just claimed are
// still `queued` on disk either way, because runOrder marks them running after
// `worktree add` - and would multiply an already O(orders) tick. The goal sweep
// reads the SAME snapshot after the retry and judge passes have written: a
// retry created this tick is absent from it (so its goal reads `planned`
// through the missing-record rule, never `done`), and a judgement claimed this
// tick is seen through verdict.isJudging rather than the record.
//
// SEPARATE try BLOCKS, and the order matters less than the isolation. The
// goal sweep is the one thing only this module can do - it is why lib/goals
// grew three movers - and it used to sit in the same try as the dispatch
// pass, so any throw from dispatch cost the sweep too. Measured: one poisoned
// candidate left a stale `planned` goal unreconciled for 45 straight ticks.
// The goal LIST has its own try for the same reason in the other direction: a
// goal store that cannot be listed must not cost the dispatch pass, which
// needs no goal list.
function tick(cfg) {
  const { root } = cfg;
  const all = orders.list(root);
  const byId = new Map(all.map((o) => [o.id, o]));
  let goalList = null;
  try {
    goalList = goals.list(root);
  } catch (e) {
    recordError(e, 'goal list failed');
  }
  const goalsById = goalList ? new Map(goalList.map((g) => [g.id, g])) : null;
  const onError = (e, what) => recordError(e, what);

  if (goalsById) {
    try {
      const r = attempts.pass(root, all, goalsById, onError);
      counts.retriesCreated += r.created;
      counts.retriesRefused += r.final;
    } catch (e) {
      recordError(e, 'retry pass failed');
    }
  }
  if (goalsById && cfg.judgeFor) {
    try {
      const r = verdict.pass(root, {
        all, goalsById, judgeFor: cfg.judgeFor, childEnv: cfg.childEnv, onError,
        onBlocked: (reason, orderId, detail) => {
          warnOnce(`nojudge:${orderId}`, detail);
          blocked(reason, orderId);
        },
      });
      counts.judgesOffered += r.offered;
    } catch (e) {
      recordError(e, 'judge pass failed');
    }
  }
  try {
    dispatchPass(cfg, all, byId);
  } catch (e) {
    recordError(e, 'dispatch pass failed');
  }
  if (goalList) {
    try {
      reconcileGoals(root, byId, goalList);
    } catch (e) {
      recordError(e, 'goal sweep failed');
    }
  }
}

function dispatchPass(cfg, all, byId) {
  const { root, childEnv, agentFor } = cfg;
  // list() is newest-first by contract, and filter preserves order, so one
  // reverse gives oldest-first. Deliberately not re-sorting: a second copy of
  // orders.js's comparator - createdAt then id, the id being the only record of
  // order within a millisecond - is a copy that can drift from the original.
  const queued = all.filter((o) => o.status === 'queued').reverse();

  const projectCache = new Map();
  const goalCache = new Map();
  const dayCache = new Map();
  // Grouped once so the per-project count below is O(that project's orders) per
  // candidate rather than O(every order in the store). See inFlightOn.
  const idsByProject = new Map();
  for (const o of all) {
    const ids = idsByProject.get(o.projectId);
    if (ids) ids.push(o.id);
    else idsByProject.set(o.projectId, [o.id]);
  }

  for (const order of queued) {
    // The global ceiling. `break`, not `continue`: it spans both spawn pools and
    // nothing later in this loop can lower it, so there is no candidate left
    // this tick that would fit.
    if (dispatch.atCapacity()) break;

    // ONE CANDIDATE'S FAULT IS ONE CANDIDATE'S FAULT. Without this, a single
    // throw anywhere below abandoned the whole tick - and since the queue is
    // oldest-first, a poisoned order at its head starved every other order in
    // the store, on every project, forever. Measured: four orders and a stale
    // goal, 45 ticks, nothing dispatched and the goal never reconciled.
    //
    // The reachable source is agentFor, which is caller-supplied and which
    // Task 5 writes. Its contract here is documented at start() - required,
    // synchronous, may return nothing - and saying it must not throw would be a
    // contract this module cannot enforce anyway. The same `continue` is
    // already what a missing project, a missing goal and a malformed orderIds
    // get; this extends it to the one callback that is not ours.
    try {
      // Ask isClaimed about ORDERS, projectBusy about DIRECTORIES - they answer
      // over different populations and lib/dispatch says so at length. This one
      // reads inFlight, which only runOrder writes, and names the window where
      // the HTTP route has dispatched this order but the record still reads
      // `queued` because `worktree add` has not finished.
      //
      // IT WAS REDUNDANT, and briefly documented as such: while this file asked
      // projectBusy for every project, deleting this line left the whole suite
      // green, because runOrder writes inFlight and projectOf at the same two
      // lines and deletes them at the same two, so isClaimed(id) implied
      // projectBusy(its project). Bounding a git project by its own concurrency
      // instead is what makes it load-bearing again: a second candidate of a
      // two-slot project now reaches this line with a slot free, and this is the
      // only thing standing between it and the SAME order being offered twice
      // while it prepares. Which is exactly what lib/dispatch's isClaimed comment
      // says the check is for.
      if (dispatch.isClaimed(order.id)) continue;

      const project = cached(projectCache, order.projectId, (id) => projects.get(root, id));
      if (!project) {
        warnOnce(`noproject:${order.id}`,
          `order ${order.id} names a project that cannot be read; leaving it queued`);
        blocked('project unreadable', order.id);
        continue;
      }

      // Paused after too many orders in a row that never got as far as running.
      // A Map lookup, so it goes before everything that reads the store.
      const paused = trouble.get(project.id);
      if (paused && paused.until > Date.now()) {
        blocked('project paused after repeated failures to start', order.id);
        continue;
      }

      // PER-PROJECT CONCURRENCY. The two kinds are asked DIFFERENT QUESTIONS,
      // because they have different hazards and different populations.
      //
      // A dir project has no isolation mechanism, so the question is "is anything
      // at all live in this directory", and projectBusy is the only thing that
      // can answer it: lib/plan claims projectOf under a GOAL id while a PM
      // decomposes - and only for non-git projects, which is the whole reason
      // that population matters here - so that PM is invisible to isClaimed.
      // projects.safeConcurrency hard-codes 1 for a dir project and calls it
      // never raisable; this is that same answer, asked of the live registry.
      //
      // A git project gets a worktree per order, so the question is a THROUGHPUT
      // one - lib/dispatch says exactly that, and its header says the scheduler
      // "calls this in a loop bounded by project.concurrency" - and the bound is
      // the knob the project record already carries. Asking projectBusy here too
      // would serialise every git project to one order at a time and make that
      // knob dead, which is what this file did first.
      //
      // Either way this is the check that cannot be replaced by the record's
      // status: an order reads `succeeded` from disk while runOrder's finally is
      // still inside worktrees.cleanup, and neither projectOf.delete nor
      // inFlight.delete has run - they are the same two lines, so both branches
      // keep holding the slot for exactly as long as the cleanup takes.
      //
      // Cheap, so both go before the daily-cap scan below. That ordering is about
      // COST, not precedence: unlike the routes and runOrder, no message here
      // depends on which check answers first, because a skipped candidate is
      // simply retried next tick.
      if (project.kind !== 'git') {
        if (dispatch.projectBusy(project.id)) continue;
      } else if (inFlightOn(idsByProject, project.id) >= concurrencyLimit(project)) {
        continue;
      }

      if (order.goalId) {
        const goal = cached(goalCache, order.goalId, (id) => goals.get(root, id));
        // Fail closed on a goal we cannot read: we cannot tell whether it is
        // settled, or still being decomposed by a PM that would roll this order
        // back. A human can still dispatch it by id.
        if (!goal) {
          warnOnce(`nogoal:${order.id}`,
            `order ${order.id} names a goal that cannot be read; leaving it queued`);
          blocked('goal unreadable', order.id);
          continue;
        }
        if (goals.SETTLED.has(goal.status)) {
          blocked(`goal already ${goal.status}`, order.id);
          continue;
        }
        // `planning` IS NOT SETTLED, AND IS NOT SAFE. lib/plan attaches each
        // order to the goal as it creates it and only calls goals.planned at the
        // end, so there is a real window in which this order is `queued`, carries
        // a goalId, and belongs to a plan that is not finished. If persisting the
        // plan then fails, plan.js's rollback calls orders.markCancelled on every
        // id it recorded - which would settle an order this scheduler had already
        // put an agent on, behind dispatch's back, and dispatch's own
        // markFinished would then be refused by the settled guard. That is the
        // "NOTHING MAY SETTLE A RECORD ANOTHER DISPATCH ALREADY OWNS" invariant
        // runOrder is built around, broken from the outside. plan.js names this
        // exact hazard - "invisible work a scheduler may still run".
        if (goal.status === 'planning') {
          blocked('goal still being planned', order.id);
          continue;
        }
        // A REVIEW HOLD (plan 3, Task 0): the human asked to read the plan
        // before anything runs. Blocked, not deferred - it will not clear
        // itself; POST /api/goals/:id/release does. A human dispatching one
        // order by id is not stopped by this, and must not be: that is the
        // review the hold exists to allow. After the `planning` check so a
        // goal still being decomposed says so rather than "held".
        if (goals.isHeld(goal)) {
          blocked('goal held for review', order.id);
          continue;
        }

        // PER-GOAL SPEND. goal.orderIds is the authoritative list - plan.js says
        // so, and an order's goalId is only a back-pointer that survives a
        // rollback - but it is STORED UNVALIDATED, so it gets the same
        // Array.isArray guard routes/goals.js already carries. A goal whose
        // orderIds is not an array is one whose spend cannot be bounded, so it is
        // skipped rather than run unbounded.
        if (!Array.isArray(goal.orderIds)) {
          warnOnce(`badids:${goal.id}`,
            `goal ${goal.id} has a malformed orderIds; leaving its orders queued`);
          blocked('goal orderIds malformed', order.id);
          continue;
        }
        // orderIds is AUTHORITATIVE and goalId only a back-pointer. An order
        // carrying this goalId that the goal does not name is a rolled-back
        // attempt or the orphan of a crash inside attempts.supersede (created
        // and attached, never added) - outside every per-goal budget and
        // attempt cap. Never run it; a human can still dispatch it by id.
        if (!goal.orderIds.includes(order.id)) {
          warnOnce(`notnamed:${order.id}`,
            `order ${order.id} points at goal ${goal.id}, which does not name it; leaving it queued`);
          blocked("order not in its goal's plan", order.id);
          continue;
        }
        // Anything not `queued` has already been spent on: running, or settled.
        // +1 for the candidate, because withinBudget asks whether a plan of that
        // size fits, and this order would be the nth.
        const spent = goal.orderIds.reduce((n, id) => {
          // CLAIMED COUNTS, even though the record still reads `queued`. runOrder
          // marks an order running only after `worktree add`, so without this
          // every candidate of one goal in one tick reads the SAME `spent` from
          // the SAME snapshot and a cap of 1 admits all of them at once. It was
          // invisible while projectBusy serialised each project to one dispatch
          // per tick; the git concurrency above is exactly what exposes it.
          // reconcileGoals asks isClaimed for this identical staleness eighty
          // lines below - one function in this file knew the snapshot was stale
          // and the other did not.
          if (dispatch.isClaimed(id)) return n + 1;
          const rec = byId.get(id);
          // A MISSING RECORD COUNTS AS SPENT. It may be an order that ran and
          // whose file store.js has since quarantined, and a cap that admits
          // extra work on a record it cannot read is a cap that stops being one
          // exactly when the store is damaged. Fail closed - the same direction
          // reconcileGoals takes on a missing order, for the same reason.
          if (!rec || rec.status !== 'queued') return n + 1;
          return n;
        }, 0);
        // goals.withinBudget rather than a comparison written here: it is the
        // function that already fails closed on every shape of a missing cap -
        // 0 and negatives refuse, a mis-typed '12' refuses, and only a wholly
        // absent budget or absent cap means unlimited. A second implementation is
        // a second chance to read one of those as "no limit".
        if (!goals.withinBudget(spent + 1, project.budget)) {
          blocked('per-goal budget reached', order.id);
          continue;
        }
      }

      // THE DAILY CAP, MIRRORED RATHER THAN TRUSTED TO RUNORDER. runOrder does
      // enforce it - but it enforces it by marking the order FAILED, which is
      // settled and never retried. A human dispatching by hand burns one order
      // that way; a loop dispatching everything queued burns the whole backlog in
      // one tick, permanently, the moment the cap is reached. Skipping instead
      // leaves them queued for tomorrow, which is the recoverable answer.
      //
      // The comparison is runOrder's verbatim, `>` and all: its order is already
      // persisted when it counts, and `>` cancels that self-inclusion. A
      // different comparison here would refuse an order runOrder would have run,
      // or vice versa.
      const cap = project.budget && project.budget.maxOrdersPerDay;
      if (cap && countToday(dayCache, root, project.id, all.length, cap) > cap) {
        blocked('daily order cap reached', order.id);
        continue;
      }

      // Synchronous by contract. An await between here and runOrder's claim below
      // would let another tick - or an HTTP route - slip between the checks above
      // and the claim that acts on them, which is the window lib/dispatch and
      // lib/plan each had to close in turn.
      const agent = agentFor(order, project);
      if (!agent || typeof agent !== 'object') {
        // NOT dispatched with a missing agent. runOrder would answer that with
        // markFailed('no agent available') - settling it - so a loop that passed
        // the absence through would fail every queued order in the store the
        // first time an agent binary went missing. "Not now" is the honest
        // reading of an absent agent, and `queued` is the honest record of it.
        warnOnce(`noagent:${order.id}`,
          `no agent available for order ${order.id}; leaving it queued`);
        blocked('no agent available', order.id);
        continue;
      }

      counts.offered += 1;
      dispatchedIds.add(order.id);
      // NOT awaited, exactly as the routes do it: runOrder resolves only when the
      // agent exits, up to the project's orderTimeoutMs. Awaiting would make the
      // tick as long as the longest order and serialise everything.
      dispatch
        .runOrder(root, { order, project, agent, childEnv })
        .then((r) => {
          // runOrder REFUSES by resolving with { refused }; it does not throw.
          // Every refusal reaching here is one of the advisory checks above
          // having been wrong - stale by a tick, or absent - so this counter is
          // the measure of how much pointless work the checks are failing to
          // avoid, and it is what the tests assert those checks on.
          if (r && r.refused) {
            counts.refused += 1;
            console.warn('[scheduler] order %s was not dispatched: %s', order.id, r.refused);
            return;
          }
          // An order that reached markRunning has a startedAt, whatever it did
          // afterwards. That is the evidence the project can still produce a
          // worktree and spawn, which is the only thing that clears the breaker.
          if (r && r.startedAt) {
            counts.started += 1;
            noteOutcome(project.id, false);
            return;
          }
          if (neverRan(r)) noteOutcome(project.id, true);
        })
        .catch((e) => {
          // A rejection is a bug in dispatch or a store that cannot be written,
          // not a failed order, and it is the one outcome with no durable trace
          // unless this writes one. Same handling as routes/orders.js, including
          // the try around markFailed: if the store is what failed, recording the
          // failure fails too.
          recordError(e, `order ${order.id} failed to dispatch`);
          try { orders.markFailed(root, order.id, `scheduler: ${lastError}`); } catch (_) {}
          // The markFailed above is the same never-ran settle a thrown prepare
          // produces - a second door into the room the breaker exists for - so it
          // is counted here too rather than only on the resolve path.
          noteOutcome(project.id, true);
        })
        // In a finally so it cannot be missed by one of the early returns above:
        // a leak here would make the live gauge climb forever.
        .finally(() => { dispatchedIds.delete(order.id); });
    } catch (e) {
      // warnOnce per ORDER, not per tick: a permanently poisonous candidate is
      // reconsidered every tick forever, and one line per id is the trade
      // lib/orders already makes for its malformed-record warning.
      recordError(e, `skipping order ${order.id}`);
      warnOnce(`threw:${order.id}`,
        `order ${order.id} threw while being considered; leaving it queued`);
      blocked('threw while being considered', order.id);
      continue;
    }
  }
}

// Every live goal, every tick, against its orders' real states - not only the
// ones that changed. That is what makes the first tick a startup sweep without
// a second code path: a goal whose orders all settled during boot emits no
// event, so only an unconditional pass can find it.
//
// lib/chains.goalOutcome owns the rules and their precedence (in flight, then
// outstanding, then all verified, then a final rejection, then stalled); this
// function owns only the writes. Two of the old rules live there now and are
// worth restating because they protect a SETTLED state: a missing order is
// never read as finished (it is outstanding), and an empty or malformed
// orderIds has no outcome at all - "every chain verified" is VACUOUSLY true of
// none, and `done` would be that goal's last word.
//
// BUSY is a dispatch claim OR a judge claim. Both are agents working for the
// goal, and both are invisible in a record that still reads `queued` or
// `succeeded` - isClaimed rather than the record, because an order claimed a
// moment ago still reads `queued` until runOrder marks it running after
// `worktree add`.
function reconcileGoals(root, byId, goalList) {
  const busy = (id) => dispatch.isClaimed(id) || verdict.isJudging(id);
  for (const goal of goalList) {
    if (goals.SETTLED.has(goal.status)) continue;
    // The PM owns a `planning` goal. goals.moveLive would refuse it anyway -
    // HAS_ORDERS excludes `planning` - but reaching for the mover just to have
    // it no-op is a read per goal per tick for nothing.
    if (goal.status === 'planning') continue;
    const outcome = chains.goalOutcome(goal, byId, busy);
    if (!outcome) continue;
    // WRITE ONLY ON A REAL TRANSITION. lib/goals' moveLive rewrites the record
    // on a no-op - mkdir, write, rename - so a per-tick call would rewrite
    // every goal's file every tick with byte-identical data. goals.js says a
    // polling caller should track what it last wrote; the record just read is a
    // better answer than tracking, because it is also correct after another
    // writer moved the goal. The short-circuit is HERE and not in goals.js for
    // the reason stated there: markDone and markFailed stamp finishedAt, so
    // "status is unchanged" and "this write changes nothing" are not the same
    // question in general - they are only the same question at this call site,
    // where each mover below changes status or nothing.
    if (outcome.status === goal.status) continue;
    if (outcome.status === 'done') goals.markDone(root, goal.id);
    else if (outcome.status === 'failed') goals.markFailed(root, goal.id, outcome.error);
    else if (outcome.status === 'running') goals.markRunning(root, goal.id);
    else if (outcome.status === 'stalled') goals.markStalled(root, goal.id);
    // The demotion, and it is not cosmetic: a goal left at `running` while
    // every agent has exited is the same lie - "work in flight with nothing
    // alive" - that this state machine was rebuilt to remove. It happens
    // whenever an order settles and the next is blocked by capacity, a busy
    // project, or the daily cap - and since plan 2d, whenever a judge finishes
    // and the verdict leaves work outstanding.
    else goals.markPlanned(root, goal.id);
  }
}

// How many of this project's orders are in flight right now. Counted LIVE via
// dispatch.isClaimed rather than from the tick's snapshot of statuses, so a
// dispatch made earlier in this same tick is already counted and there is no
// manual tally that can drift from reality on a refusal.
//
// No new export from dispatch was needed for this, and an earlier version of
// this file's Known limits claimed there was - wrongly. For a GIT project,
// projectOf holds nothing but runOrder's own order-id claims (lib/plan claims
// it only for non-git projects), so "is any order of this project claimed" is
// answerable from the order ids this tick already holds, and generalises to a
// count in a way projectBusy's boolean cannot.
//
// Undercounts an in-flight order missing from the snapshot; see Known limits.
function inFlightOn(idsByProject, projectId) {
  const ids = idsByProject.get(projectId);
  if (!ids) return 0;
  let n = 0;
  for (const id of ids) if (dispatch.isClaimed(id)) n++;
  return n;
}

// projects.safeConcurrency already clamps this on the way in, but the record is
// a file on disk a human can edit, and a concurrency of 0, -1 or "lots" must not
// read as "no limit" - the failure lib/projects' own BUDGET_MAX comment names.
// Fail closed on 1: the value a dir project is fixed at, and the value every
// project can run at safely.
function concurrencyLimit(project) {
  if (!Number.isInteger(project.concurrency) || project.concurrency < 1) return 1;
  // A CEILING TOO, which is lib/projects' own rule stated at BUDGET_MAX:
  // "an orderTimeoutMs of 1e15 disables the stuck-agent guard exactly as
  // effectively as 0 does". safeConcurrency clamps to MAX_CONCURRENCY on the
  // way in, but the same hand-edited projects.json that can write a 0 here -
  // which the sibling test proves survives projects.get verbatim - can write
  // 500. atCapacity would still backstop it; that is a reason this is not
  // urgent, not a reason to accept a bound only on one side.
  return Math.min(project.concurrency, projects.MAX_CONCURRENCY);
}

function cached(map, key, read) {
  if (map.has(key)) return map.get(key);
  const value = read(key);
  map.set(key, value);
  return value;
}

// countToday() goes through orders.list(), which opens every order file again -
// so it is memoised per project per tick, and skipped outright when the whole
// store holds no more orders than the cap. That skip is EXACT, not a heuristic:
// countToday(project) can never exceed the total number of orders, so
// total <= cap implies count <= cap implies runOrder's `> cap` is false.
//
// Counted through orders.countToday rather than from the snapshot already in
// hand, because the day boundary is orders.js's localDay - deliberately local
// rather than UTC, so a cap does not reset at 7pm on a UTC-5 host - and it is
// not exported. A second implementation of "today" is a second thing to get
// wrong by a timezone.
function countToday(dayCache, root, projectId, totalOrders, cap) {
  if (totalOrders <= cap) return 0;
  return cached(dayCache, projectId, (id) => orders.countToday(root, id));
}

module.exports = { start, stop, stats };
