'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dispatch = require('../lib/dispatch');
const orders = require('../lib/orders');
const projects = require('../lib/projects');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-dsp-'));
  created.push(d);
  return d;
}
function tmpGitRepo() {
  const d = tmpDir('skillspace-dsprepo-');
  execSync('git init -q', { cwd: d });
  fs.writeFileSync(path.join(d, 'file.txt'), 'original\n');
  execSync('git add -A', { cwd: d });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}
after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const OK = '#!/bin/sh\necho "did the work"\nexit 0\n';
const BAD = '#!/bin/sh\necho "broke"\nexit 4\n';
const SLOW = '#!/bin/sh\nsleep 60\n';

test('a dispatched order runs isolated, succeeds, and is recorded', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'do it' });

  const result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'succeeded');
  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'succeeded');
  assert.strictEqual(stored.exitCode, 0);
  assert.strictEqual(stored.agent, 'fake');
  assert.ok(stored.startedAt && stored.finishedAt);
  assert.match(fs.readFileSync(path.join(root, 'logs', `${order.id}.log`), 'utf8'), /did the work/);
});

test('the worktree is removed after the order finishes', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });
  const wtRoot = path.join(root, 'worktrees');
  const left = fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [];
  assert.deepStrictEqual(left, [], `worktree left behind: ${JSON.stringify(left)}`);
});

test('the agent\'s work survives on the order branch', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  const agent = shimAgent('#!/bin/sh\necho "output" > agent-made.txt\nexit 0\n');

  await dispatch.runOrder(root, { order, project, agent });

  const files = execSync(`git ls-tree -r --name-only skillspace/${order.id}`, { cwd: repo, encoding: 'utf8' });
  assert.match(files, /agent-made\.txt/, 'the agent\'s work was discarded');
});

test('a non-zero exit records failed with the exit code, and still cleans up', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });
  await dispatch.runOrder(root, { order, project, agent: shimAgent(BAD) });

  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.exitCode, 4);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'a failed run must not hold its worktree');
});

test('a worktree that cannot be created fails the order before any agent starts', async () => {
  // The shim would exit 0 if it ever ran, so a succeeded status here would
  // prove the abort did not happen.
  const root = tmpDir('skillspace-home-');
  const notARepo = tmpDir('skillspace-plain-');
  const project = { ...projects.create(root, { path: notARepo }), kind: 'git' };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const result = await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  const stored = orders.get(root, order.id);
  assert.match(stored.error, /worktree/);
  assert.strictEqual(stored.startedAt, null, 'no agent should have started');
});

test('maxOrdersPerDay refuses a dispatch and does not spawn or prepare', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, maxOrdersPerDay: 1 } };

  const first = orders.create(root, { projectId: project.id, prompt: 'one' });
  await dispatch.runOrder(root, { order: first, project, agent: shimAgent(OK) });

  const second = orders.create(root, { projectId: project.id, prompt: 'two' });
  const result = await dispatch.runOrder(root, { order: second, project, agent: shimAgent(OK) });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, second.id).error, /daily limit/);
  assert.strictEqual(orders.get(root, second.id).startedAt, null);
  // Refused BEFORE a worktree exists, so a refused order leaves nothing behind.
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'the budget check ran after the worktree was created');
});

test('the order timeout comes from the project budget', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const base = projects.create(root, { path: repo });
  const project = { ...base, budget: { ...base.budget, orderTimeoutMs: 700 } };
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  await dispatch.runOrder(root, { order, project, agent: shimAgent(SLOW) });

  const stored = orders.get(root, order.id);
  assert.strictEqual(stored.status, 'failed');
  assert.strictEqual(stored.error, 'timeout');
  assert.strictEqual(stored.exitCode, null);
});

test('a dir project runs in place and the directory survives', async () => {
  const root = tmpDir('skillspace-home-');
  const work = tmpDir('skillspace-work-');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'precious');
  const project = projects.create(root, { path: work });
  assert.strictEqual(project.kind, 'dir');
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  await dispatch.runOrder(root, { order, project, agent: shimAgent(OK) });

  assert.strictEqual(orders.get(root, order.id).cwd, fs.realpathSync(work));
  assert.ok(fs.existsSync(path.join(work, 'keep.txt')), 'a dir project must never be cleaned up');
  assert.ok(fs.existsSync(work));
});

test('cancel stops a running order and records cancelled', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const running = dispatch.runOrder(root, { order, project, agent: shimAgent(SLOW) });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(dispatch.cancel(order.id), true);
  const result = await running;

  assert.strictEqual(result.status, 'cancelled');
  assert.strictEqual(orders.get(root, order.id).status, 'cancelled');
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], [],
    'a cancelled order must not hold its worktree');
});

test('cancel of an unknown or finished order reports false', async () => {
  assert.strictEqual(dispatch.cancel('ord-nope'), false);
});

test('a missing agent fails the order without preparing a worktree', async () => {
  const root = tmpDir('skillspace-home-');
  const repo = tmpGitRepo();
  const project = projects.create(root, { path: repo });
  const order = orders.create(root, { projectId: project.id, prompt: 'x' });

  const result = await dispatch.runOrder(root, { order, project, agent: null });

  assert.strictEqual(result.status, 'failed');
  assert.match(orders.get(root, order.id).error, /agent/);
  const wtRoot = path.join(root, 'worktrees');
  assert.deepStrictEqual(fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : [], []);
});
