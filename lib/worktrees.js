'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Prepares the directory an agent runs in. Two agents editing one working tree
// concurrently will corrupt each other, so a git project gets a real
// `git worktree` per order and a plain directory - which has no isolation
// mechanism at all - runs in place and is serialised by the caller instead.
//
// Knows git. Knows nothing about how orders are persisted or how agents are
// spawned, so it can be tested without either.
//
// Known limits, recorded rather than solved:
//
// - A fresh worktree does not inherit node_modules. Projects needing install
//   pay that per order.
// - A crash between prepare() and cleanup() leaks the skillspace/<orderId>
//   branch and git's worktree registration, and every retry of that exact id
//   then fails on "a branch named ... already exists". Unreachable in practice:
//   order ids are UUID-based and a retry creates a NEW order that `supersedes`
//   the old one rather than reusing the id.
// - A source repo with no commits works only on git >= 2.42, which infers
//   `--orphan`; below that `worktree add` fails with "invalid reference: HEAD".
//   package.json declares a floor for node (>= 21, which is what the test
//   script's glob needs) but none for git.
// - The git calls being async rather than sync is knowingly NOT pinned by a
//   test. Distinguishing the two needs a hung git plus a concurrent timer -
//   slow and flaky for a property that is one visible line of source.
// - A dirty source tree is not a problem, but it is a surprise: the worktree
//   gets committed HEAD content only, so the agent never sees the user's
//   uncommitted edits and operates on a different tree than the user is
//   looking at. The UI will eventually need to say so.

// A hung git is capped rather than waited on forever. This matters more than
// the number does: these calls used to be execFileSync, which blocked the whole
// event loop for the full timeout, so inside a single-process server one wedged
// git froze every other order and every HTTP request - and cleanup's three
// calls made that 90 seconds. Async kept the freeze to the one order - and the
// per-repo lock below has since widened that again, deliberately: a wedged add
// now holds its repo's queue. See withRepoLock's Known limits.
const GIT_TIMEOUT_MS = 30000;

// The id becomes both a directory name and a branch name, so it may not lead
// with a dash for the same reason a branch may not: a later argv position is
// no defence once git parses its own arguments.
const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

// Does double duty: it validates the branch name we create AND the caller's
// start point, which git would resolve more liberally - `HEAD` passes but
// `main~1` is refused even though `worktree add` would accept it. Erring
// strict on a start point is the safe direction.
//
// git check-ref-format's rules, reduced to what we actually need, plus the
// leading dash. A branch called "--force" would be read by git as a flag no
// matter how carefully the argv array is built, because git parses its own
// arguments after we hand them over.
function assertBranch(branch) {
  const ok =
    typeof branch === 'string' &&
    branch.length > 0 &&
    branch.length <= 200 &&
    !branch.startsWith('-') &&
    !branch.endsWith('.lock') &&
    !branch.endsWith('/') &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch);
  if (!ok) throw new Error(`invalid branch: ${String(branch)}`);
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // execFile's 1 MB default would reject a wide `status --porcelain` - a
      // codemod touching ~13-16k paths clears it - straight into the failure
      // path, so the read is capped where a real change cannot reach.
      maxBuffer: 64 * 1024 * 1024,
      // Strip the ambient overrides for the same reason lib/projects does: a
      // GIT_DIR inherited from a hook would silently retarget the worktree, and
      // GIT_INDEX_FILE from that same hook stamps our commit into a third repo.
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
        GIT_CEILING_DIRECTORIES: undefined,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function worktreeDir(root, orderId) {
  return path.join(root, 'worktrees', orderId);
}

// One `git worktree add` at a time per repository. Two concurrent adds on one
// repo race: one enumerates .git/worktrees/*/commondir while the other is
// mid-creation of its own, and reads a file that exists but is not yet
// written. git reports it as
//   fatal: failed to read .git/worktrees/<id>/commondir: Undefined error: 0
// and sometimes as "... : No such file or directory" - the errno is whatever
// happened to be left in it, so the tail of the message is not stable and
// nothing should match on it.
//
// It fails closed: the order is marked failed and prepare leaves nothing
// behind, so the cost is one legitimate order failing spuriously.
//
// Rates, because the number matters for how this can be tested. lib/dispatch
// recorded 1/48 adds at K=4 under load - the shipped MAX_CONCURRENT_RUNS
// default - and 1/12 trials at K=3 idle. Re-measured here per TRIAL of K
// simultaneous adds (macOS, git 2.50): 5/50 at K=8, 2/20 at K=16, 3/20 at
// K=32, 2/12 at K=64. An earlier version of this note read those as a plateau
// near 10-15% that did not climb with K. THAT WAS READING NOISE AS A CEILING,
// the same error the measurement in lib/dispatch was corrected for. Independent
// sampling: 8/80 at K=8, 3/30 at K=16, 13/50 at K=32 - so it DOES climb, and
// the spread between batches at one K is wide (40% then 17% at K=32). Treat
// every figure here as measured at that K, not as a bound.
//
// What survives the correction is the decision, not the ceiling: even ~26% is
// nowhere near a gate, and K=32 costs roughly 4x the runtime of K=8, so the
// test below uses the cheapest K that reproduces rather than the highest.
// The decisive figure is the test itself, run 100 times each way: 6/100
// runs failed without this lock, 0/100 with it.
//
// Keyed by the repo path, NOT global: a global lock would serialise unrelated
// projects, which turns an isolation fix into a throughput bug.
//
// The lock covers the add AND its undo, but nothing above them. The read-only
// inspection before it does not need serialising, and holding the lock across
// it would block the repo for longer than the race requires. The undo is
// inside because `worktree prune` enumerates the same list a concurrent add is
// writing to; whether git's prune-expiry grace protects an in-flight entry is
// a question this does not have to answer if the two never overlap.
//
// Known limits:
// - Per-PROCESS. A second SkillSpace against the same repo still races, and so
//   does a human running `git worktree add` by hand. Both still fail closed.
// - THIS LOCK WIDENED THE BLAST RADIUS OF A WEDGED GIT, and that is the trade
//   it makes. A `worktree add` that hangs - a stalled post-checkout hook, NFS,
//   a credential prompt - now blocks every other queued order AT THAT REPO for
//   up to GIT_TIMEOUT_MS, and up to 3x that if the undo's prune and branch -D
//   stall too. Before the lock they proceeded immediately. Demonstrated at
//   1/20 scale (timeout 1500ms): a same-repo order did not start until the
//   wedged one returned, while an other-repo control finished in 189ms.
//
//   Taken deliberately: it converts "a legitimate order fails spuriously,
//   silently, ~10% of the time at K=8" into "queued orders at one repo wait,
//   visibly, behind a genuinely stuck git". Unrelated projects are untouched,
//   which is what keying on project.path buys. The scheduler is the caller
//   that will sit in this queue, so it is recorded here rather than inferred.
// - Keyed on the project.path STRING, not on the repository. Two records
//   naming one repo by different spellings - a symlink, a trailing slash - get
//   two locks and race exactly as before. lib/projects.create realpaths every
//   path it stores, so records made the normal way are already canonical; a
//   hand-built project object passed straight to prepare() is not.
// - Two prepares with the SAME orderId on one repo destroy the winner's RUN,
//   not just its record. The winner's add succeeds and prepare returns
//   {cwd: dest} to it; the loser's add then fails "a branch named ... already
//   exists" and its undo runs against that same id - `fs.rmSync(dest)`, where
//   dest is worktreeDir(root, orderId) and therefore the SAME PATH, followed by
//   prune and `branch -D`. Measured 5/5: the winner's checkout directory is
//   deleted and its branch with it. The agent has already been handed that cwd,
//   so it spawns into a directory that no longer exists.
//
//   The mechanism is that `branchExisted` is read ABOVE the lock: both prepares
//   see the branch absent, so the loser believes it created what it destroys.
//   The bug is the SCOPE OF THAT READ, not the `branch -D`.
//
//   Still strictly better than no lock, where both fail and nothing survives
//   (5/5), and unreachable through lib/dispatch, which refuses a duplicate at
//   `inFlight.has(order.id)` and claims the id synchronously before any await.
//   Recorded because a caller that is NOT dispatch would find it. The fix, if
//   it ever becomes reachable, is to raise the lock to cover the emptiness
//   check and the rev-parse: that makes the read fresh, the loser is rejected
//   by the non-empty-dest guard instead, and the winner's branch survives
//   (3/3). So the wider lock is not equivalent to this one - it is SAFER here,
//   and only throughput argues for the narrow scope.
//
//   Deliberately not pinned by a test, because the test would have to assert
//   the shipped behaviour, which is the worse of the two. Note that the reason
//   is NOT that this file abstains from timing instruments - the "per repo,
//   not global" test below is one. It is margin: that test reads completion
//   order across a 1s hook sleep, whereas telling these two lock scopes apart
//   means detecting whether a ~10ms read-only op sits inside a lock. Same
//   instrument, unusable signal.
const addLocks = new Map();

function withRepoLock(repoPath, fn) {
  const prev = addLocks.get(repoPath) || Promise.resolve();
  // Chain onto the previous holder, swallowing its rejection so one failed
  // prepare cannot poison every later one on the same repo.
  //
  // `() => fn()`, not `prev.then(fn, fn)`: the latter hands fn the previous
  // holder's resolved value - or its Error - as an argument. Harmless while
  // every fn here ignores its parameters, and a trap the moment one is written
  // as `withRepoLock(path, (opts) => ...)`. fn is called with NO arguments, and
  // now by construction rather than by convention.
  const mine = prev.then(() => fn(), () => fn());
  // Keep the chain finite: drop the entry once this is the tail. `finally`
  // passes the settlement through untouched, so the lock never alters what the
  // caller sees - and it states the delete once instead of in both handlers.
  const done = mine.finally(() => {
    if (addLocks.get(repoPath) === done) addLocks.delete(repoPath);
  });
  addLocks.set(repoPath, done);
  return done;
}

// Returns { cwd, isolated, branch, projectPath, orderId } for both kinds, so a
// caller in another process can clean up a worktree it did not create.
// `isolated: false` means the agent is editing the user's actual project
// directory, which the caller must surface rather than hide.
async function prepare(root, project, orderId) {
  if (typeof orderId !== 'string' || !PLAIN_ID.test(orderId)) {
    throw new Error(`invalid order id: ${String(orderId)}`);
  }
  if (!project || typeof project.path !== 'string' || !project.path) {
    throw new Error('worktree: project has no path');
  }
  if (project.branch !== null && project.branch !== undefined) assertBranch(project.branch);

  if (project.kind !== 'git') {
    // No isolation available, so the caller MUST serialise these - two agents
    // in one plain directory corrupt each other's edits. lib/dispatch does it,
    // refusing a second concurrent order on an unisolated project with
    // `refused: 'project busy'`. Nothing enforces it at this layer: a caller
    // that skips that check gets two agents in the user's own tree, which is
    // what happened while this comment claimed the caller already handled it.
    return { cwd: project.path, isolated: false, branch: null, projectPath: project.path, orderId };
  }

  const dest = worktreeDir(root, orderId);
  const branch = `skillspace/${orderId}`;
  assertBranch(branch);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // A non-empty dest means a previous run of this id crashed. Its contents may
  // be the only copy of that agent's work, so refuse rather than delete - the
  // order fails with a message a human can act on.
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    throw new Error(`worktree: ${dest} already exists and is not empty`);
  }

  // Did this call create the branch? `worktree add -b` fails outright if it
  // already exists, so anything pre-existing is a previous order's preserved
  // record - the one thing branch retention exists to protect.
  let branchExisted = false;
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], project.path);
    branchExisted = true;
  } catch (_) { /* absent, which is the normal case */ }

  // Serialised per repo; see withRepoLock above for the race and its rates.
  await withRepoLock(project.path, async () => {
    try {
      // -b creates a branch for this order so the worktree is detached from
      // whatever the user has checked out. `--` terminates option parsing.
      const base = project.branch ? [project.branch] : [];
      await git(['worktree', 'add', '-b', branch, '--', dest, ...base], project.path);
    } catch (e) {
      // Nothing half-created is left behind, and the order fails before any agent
      // spawns. Because a non-empty dest was refused above, this only ever
      // removes a directory git itself created - which is what makes it safe.
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
      try { await git(['worktree', 'prune'], project.path); } catch (_) {}
      // The branch is created by `worktree add -b` before the checkout can fail,
      // so a failed prepare leaks one it made - nothing ran, so there is nothing
      // to keep, and a leak would make every retry of this id fail permanently.
      // But ONLY one it made: if the branch pre-existed, this prepare failed
      // *because* of that, and deleting it would destroy the previous order's
      // preserved record - the same work the non-empty-dest refusal protects.
      if (!branchExisted) {
        try { await git(['branch', '-D', '--', branch], project.path); } catch (_) {}
      }
      // git's first stderr line is usually progress ("Preparing worktree ..."),
      // not the cause, so taking it recorded the wrong reason on the order. Of
      // seven sampled failures git's fatal: line was always already the last one,
      // so the find() is belt-and-braces over the last-line fallback - it is not
      // inert by construction: a hook whose first stderr line starts "error:"
      // would make find() select the worse line.
      const lines = (e.stderr || e.message || '').toString().trim().split('\n');
      // A git that was KILLED rather than one that failed prints no fatal: line
      // at all, so the last-line fallback takes its PROGRESS line and records
      // `worktree: Preparing worktree (new branch 'skillspace/...')` as the
      // reason - the exact wrong-reason failure the find() exists to prevent,
      // reached by the one path this lock has made more consequential. Observed
      // on a wedged post-checkout hook. node sets `killed` when IT killed the
      // child, which here means the timeout (maxBuffer sets it too, but 64 MB
      // is out of reach for `worktree add`).
      //
      // Verified by hand, NOT pinned by a test: GIT_TIMEOUT_MS is a module
      // const, so a real timeout test costs 30s of suite time against a 36s
      // suite. Reproduced at 1500ms - without this branch the order records
      // `worktree: Preparing worktree (new branch 'skillspace/ord_wedged')`,
      // with it, `worktree: git did not finish within 1500ms`. Same reason the
      // sync-vs-async property above is knowingly unpinned: the instrument
      // costs more than the property is worth.
      const detail = e.killed
        ? `git did not finish within ${GIT_TIMEOUT_MS}ms`
        : lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1] || '';
      throw new Error(`worktree: ${detail.trim() || 'could not create worktree'}`);
    }
  });

  return { cwd: dest, isolated: true, branch, projectPath: project.path, orderId };
}

// Preserve before removing. An agent that edited files and did not commit has
// its work in the worktree only, and `worktree remove --force` would delete it.
// Committing to the order's own branch makes the result inspectable with
// `git log skillspace/<orderId>` long after the directory is gone - which is
// the point of having run the agent at all.
//
// Idempotent: a cancelled order and its own close handler may both call this.
async function cleanup(wt) {
  if (!wt || !wt.isolated) {
    return { removed: false, committed: false, branchKept: false, ignoredOutput: 0, preserveError: null };
  }
  // Only meaningful for an isolated record: a dir project's cwd IS the project
  // path by definition, so this must never fire on one - the early exit above
  // already returns, and the explicit flag keeps that true if it ever moves.
  // wt round-trips through persistence, so an isolated record claiming the
  // project itself as its worktree would delete the user's work and report
  // success.
  if (wt.isolated && wt.cwd === wt.projectPath) {
    return {
      removed: false, committed: false, branchKept: false, ignoredOutput: 0,
      preserveError: 'refusing to clean up: cwd is the project itself',
    };
  }

  let committed = false;
  let preserveError = null;   // work existed and could not be preserved
  try {
    const status = await git(['status', '--porcelain'], wt.cwd);
    if (status.trim()) {
      await git(['add', '-A'], wt.cwd);
      // A linked worktree shares the common dir's hooks, so husky/lint-staged
      // would fire on this snapshot and agent-written code failing lint is the
      // expected case, not an exotic one. This is a machine snapshot, not the
      // user's commit: their hooks and their signing key belong to theirs.
      // The identity flags are NOT cargo - under user.useConfigOnly, or on any
      // container with a dotless hostname, git cannot synthesise an address and
      // fails with "no email was given".
      await git([
        '-c', 'user.email=skillspace@localhost',
        '-c', 'user.name=SkillSpace',
        '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-q', '-m', `skillspace: ${wt.orderId}`,
      ], wt.cwd);
      committed = true;
    }
  } catch (e) {
    // The work is still in the worktree at this point. Record why we could not
    // save it, so the caller is not told the agent did nothing - and do not
    // force-remove a tree whose only copy of the work is right here.
    preserveError = (e.stderr || e.message || String(e)).toString().trim().split('\n').pop();
  }

  // Ignored paths are deliberately NOT committed - `add -A -f` would put
  // node_modules and .env into the user's repo. But an agent whose only output
  // is a build directory must not read as "did nothing", so the count is
  // reported and the caller decides whether to surface it. The unit is
  // porcelain ENTRIES, not files: git collapses an ignored directory to one
  // line, so 16,000 files under node_modules/ count as 1.
  let ignoredOutput = 0;
  try {
    const ignored = await git(['status', '--porcelain', '--ignored=matching'], wt.cwd);
    ignoredOutput = ignored.split('\n').filter((l) => l.startsWith('!!')).length;
  } catch (_) { /* best effort; never block the removal */ }

  // Deliberately trade a leaked worktree for the user's data: the only copy of
  // the work is in this tree, and `remove --force` would delete it. A leaked
  // tree is recoverable and prepare's non-empty-dest guard already refuses to
  // silently reuse it, so the next order fails loudly instead of overwriting.
  if (preserveError) {
    return { removed: false, committed: false, preserveError, branchKept: true, ignoredOutput };
  }

  let removed = true;
  try {
    await git(['worktree', 'remove', '--force', '--', wt.cwd], wt.projectPath);
  } catch (_) {
    // The worktree may already be gone, or the repo may have moved. Remove the
    // directory directly and let prune reconcile git's own bookkeeping.
    try { fs.rmSync(wt.cwd, { recursive: true, force: true }); } catch (__) { removed = false; }
  }
  try { await git(['worktree', 'prune'], wt.projectPath); } catch (_) {}

  // The branch is deliberately KEPT. It is the durable record of what the
  // agent did, and deleting it is the caller's decision, not ours.
  return { removed, committed, branchKept: true, ignoredOutput, preserveError: null };
}

// Deletes the branch cleanup() deliberately kept. Not the default and never
// called for an order: for an order the branch IS the durable record of what
// the agent did, which is the point of having run it.
//
// lib/plan uses it for the PM, whose output is the plan on stdout rather than
// anything in the tree - so a retained branch per goal is pollution in the
// user's repository and nothing else. The caller is responsible for only asking
// when there is genuinely nothing to lose; `committed` from cleanup() is how it
// knows. Git lives here rather than in the caller, which is the whole reason
// this module exists.
//
// Returns { deleted, error }. Never throws: a branch that could not be deleted
// is untidy, and failing a goal whose plan is already extracted over untidiness
// would be the worse trade.
async function deleteBranch(wt) {
  if (!wt || !wt.isolated || !wt.branch) return { deleted: false, error: null };
  try {
    await git(['branch', '-D', '--', wt.branch], wt.projectPath);
    return { deleted: true, error: null };
  } catch (e) {
    const detail = (e.stderr || e.message || String(e)).toString().trim().split('\n').pop();
    return { deleted: false, error: detail };
  }
}

module.exports = { prepare, cleanup, deleteBranch };
