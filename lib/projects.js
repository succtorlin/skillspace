'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = 'projects.json';

const DEFAULT_BUDGET = {
  maxOrdersPerGoal: 12,
  orderTimeoutMs: 900000, // 15 minutes
  maxOrdersPerDay: 100,
};

// Kind is DETECTED, never taken from the caller: it decides whether agents can
// be isolated in worktrees, so a wrong value would let two agents corrupt one
// working tree.
function detectKind(dir) {
  return fs.existsSync(path.join(dir, '.git')) ? 'git' : 'dir';
}

function newId() {
  return 'prj-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function list(root) {
  return store.readJson(root, FILE, []);
}

function create(root, input) {
  const dir = input.path;
  if (!dir || !fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error('path is not a directory: ' + dir);

  const kind = detectKind(dir);
  // A plain directory has no isolation mechanism, so it is serialised rather
  // than allowed to run agents concurrently over one working tree.
  const concurrency = kind === 'git' ? (input.concurrency || 2) : 1;

  const project = {
    id: newId(),
    name: input.name || path.basename(dir),
    kind,
    path: dir,
    branch: input.branch || null,
    skillSources: input.skillSources || [],
    agents: input.agents || [],
    concurrency,
    budget: { ...DEFAULT_BUDGET, ...(input.budget || {}) },
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
// deleting a project must never delete their code.
function remove(root, id) {
  const all = list(root).filter((p) => p.id !== id);
  store.writeJson(root, FILE, all);
}

module.exports = { detectKind, create, list, get, remove, DEFAULT_BUDGET };
