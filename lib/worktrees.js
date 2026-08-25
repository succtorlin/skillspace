'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Prepares the directory an agent runs in. Two agents editing one working tree
// concurrently will corrupt each other, so a git project gets a real
// `git worktree` per order and a plain directory - which has no isolation
// mechanism at all - runs in place and is serialised by the caller instead.
//
// Knows git. Knows nothing about how orders are persisted or how agents are
// spawned, so it can be tested without either.
//
// Known cost, recorded rather than solved: a fresh worktree does not inherit
// node_modules. Projects needing install pay that per order.

const GIT_TIMEOUT_MS = 30000;

// The id becomes both a directory name and a branch name, so it may not lead
// with a dash for the same reason a branch may not: a later argv position is
// no defence once git parses its own arguments.
const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    // Strip the ambient overrides for the same reason lib/projects does: a
    // GIT_DIR inherited from a hook would silently retarget the worktree.
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  });
}

function worktreeDir(root, orderId) {
  return path.join(root, 'worktrees', orderId);
}

// Returns { cwd, isolated, branch }. `isolated: false` means the agent is
// editing the user's actual project directory, which the caller must surface
// rather than hide.
function prepare(root, project, orderId) {
  if (typeof orderId !== 'string' || !PLAIN_ID.test(orderId)) {
    throw new Error(`invalid order id: ${String(orderId)}`);
  }
  if (!project || typeof project.path !== 'string' || !project.path) {
    throw new Error('worktree: project has no path');
  }
  if (project.branch !== null && project.branch !== undefined) assertBranch(project.branch);

  if (project.kind !== 'git') {
    // No isolation available. The caller forces concurrency to 1 for these.
    return { cwd: project.path, isolated: false, branch: null };
  }

  const dest = worktreeDir(root, orderId);
  const branch = `skillspace/${orderId}`;
  assertBranch(branch);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    // -b creates a branch for this order so the worktree is detached from
    // whatever the user has checked out. `--` terminates option parsing.
    const base = project.branch ? [project.branch] : [];
    git(['worktree', 'add', '-b', branch, '--', dest, ...base], project.path);
  } catch (e) {
    // Nothing half-created is left behind, and the order fails before any
    // agent spawns.
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    try { git(['worktree', 'prune'], project.path); } catch (_) {}
    const detail = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    throw new Error(`worktree: ${detail || 'could not create worktree'}`);
  }

  return { cwd: dest, isolated: true, branch, projectPath: project.path };
}

// Idempotent: a cancelled order and its own close handler may both call this.
function cleanup(root, wt) {
  if (!wt || !wt.isolated) return; // never remove a dir project's directory
  try {
    git(['worktree', 'remove', '--force', '--', wt.cwd], wt.projectPath);
  } catch (_) {
    // The worktree may already be gone, or the repo may have moved. Remove the
    // directory directly and let prune reconcile git's own bookkeeping.
    try { fs.rmSync(wt.cwd, { recursive: true, force: true }); } catch (__) {}
  }
  try { git(['worktree', 'prune'], wt.projectPath); } catch (_) {}
  if (wt.branch) {
    try { git(['branch', '-D', '--', wt.branch], wt.projectPath); } catch (_) {}
  }
}

module.exports = { prepare, cleanup, assertBranch, worktreeDir };
