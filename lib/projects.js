'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const store = require('./store');

// Known limits, deliberately not addressed here:
//
// - Cross-process races. create() is read-modify-write over one file with no
//   lock. It is fully synchronous, so two calls in ONE process cannot
//   interleave, but two processes (a second server, or a CLI run while the
//   server is up) can, and the loser's project is silently lost. Fixing it
//   needs lockfiles, which belongs with the scheduler.
// - Corruption discards earlier projects. If projects.json is unparseable the
//   store preserves the bytes as a .corrupt file and warns, but list() returns
//   [] and the next create() writes a fresh array, so the live file loses
//   everything that came before. Recovering automatically needs versioning.
// - Overlapping working trees. kind and concurrency are decided per project,
//   so registering a repo root (git, concurrency 2) AND a subdirectory of it
//   (dir, concurrency 1) puts three agents over overlapping trees. Nothing
//   detects the overlap; that check belongs with the scheduler.

const FILE = 'projects.json';

const MAX_CONCURRENCY = 8;

const DEFAULT_BUDGET = {
  maxOrdersPerGoal: 12,
  orderTimeoutMs: 900000, // 15 minutes
  maxOrdersPerDay: 100,
};

// Kind is DETECTED, never taken from the caller: it decides whether agents can
// be isolated in worktrees, so a wrong value would let two agents corrupt one
// working tree.
//
// A stray .git file passes existsSync and would earn concurrency 2, then fail
// at `git worktree add` with "invalid gitfile format". Confirm git actually
// agrees this is a repository ROOT: --show-toplevel succeeds in a SUBDIRECTORY
// too, and a subdir cannot be isolated (worktree add there checks out the whole
// repo), so equality with the directory itself is the part that matters.
function detectKind(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return 'dir';
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return fs.realpathSync(top) === fs.realpathSync(dir) ? 'git' : 'dir';
  } catch (_) {
    // Not a usable repository - classify as dir and serialise. Being wrong in
    // this direction costs throughput; being wrong the other way costs the
    // user's working tree.
    return 'dir';
  }
}

// randomUUID, not a timestamp+random: remove() filters by predicate, so two
// records sharing an id would both be deleted by a single remove call.
function newId() {
  return 'prj-' + crypto.randomUUID();
}

// Clamped and coerced: this arrives from an HTTP request body, and whatever
// schedules against it needs a positive integer, not "-5" or {}.
function safeConcurrency(value, kind) {
  if (kind !== 'git') return 1; // no isolation mechanism; never raisable
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(n, MAX_CONCURRENCY);
}

// Allowlisted and bounded: unknown keys from an HTTP body must not become
// permanent state, and a zero or negative timeout would disable the only
// control standing between a stuck agent and an unbounded run.
function safeBudget(input) {
  const b = { ...DEFAULT_BUDGET };
  if (!input || typeof input !== 'object') return b;
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const n = Math.floor(Number(input[key]));
    if (Number.isFinite(n) && n > 0) b[key] = n;
  }
  return b;
}

function list(root) {
  return store.readJson(root, FILE, []);
}

function create(root, input) {
  // Resolve to absolute at creation. A relative path stored here would be
  // re-resolved against whatever cwd the process happens to have later, so a
  // record created as "." inside a repo (kind: git, concurrency 2) would point
  // at a plain directory after a restart from elsewhere - two agents over a
  // tree that cannot be isolated, which is the exact corruption `kind` exists
  // to prevent. The record outlives the process; the cwd does not.
  const dir = input.path ? path.resolve(input.path) : input.path;
  if (!dir || !fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error('path is not a directory: ' + dir);

  const kind = detectKind(dir);
  // A plain directory has no isolation mechanism, so it is serialised rather
  // than allowed to run agents concurrently over one working tree.
  const concurrency = safeConcurrency(input.concurrency, kind);

  const project = {
    id: newId(),
    name: input.name || path.basename(dir),
    kind,
    path: dir,
    branch: input.branch || null,
    skillSources: input.skillSources || [],
    agents: input.agents || [],
    concurrency,
    budget: safeBudget(input.budget),
    createdAt: new Date().toISOString(),
  };

  const all = list(root);
  all.push(project);
  store.writeJson(root, FILE, all);
  return project;
}

function get(root, id) {
  return list(root).find((p) => p.id === id) || null;
}

// Removes the RECORD only. The user's working directory is never touched —
// deleting a project must never delete their code. Returns whether a record
// actually matched, so an unknown id can 404 rather than reporting success.
function remove(root, id) {
  const all = list(root);
  const kept = all.filter((p) => p.id !== id);
  if (kept.length === all.length) return false; // nothing matched; let the route 404
  store.writeJson(root, FILE, kept);
  return true;
}

module.exports = {
  detectKind, newId, create, list, get, remove,
  DEFAULT_BUDGET, MAX_CONCURRENCY,
};
