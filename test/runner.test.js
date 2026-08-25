'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const runner = require('../lib/runner');

const created = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'skillspace-run-'));
  created.push(d);
  return d;
}
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

// A fake agent, so no test ever spends money. It takes its behaviour from the
// prompt it is given, which is exactly how a real agent is invoked.
function shimAgent(script) {
  const dir = tmpDir('skillspace-shim-');
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { id: 'fake', bin, buildArgs: (p) => ['-p', p] };
}

function countSleepers() {
  try {
    return execSync('pgrep -f "sleep 60" | wc -l', { encoding: 'utf8' }).trim();
  } catch (_) {
    return '0';
  }
}

const ECHO = '#!/bin/sh\necho "stdout: $2"\necho "stderr line" >&2\nexit 0\n';
const FAIL = '#!/bin/sh\necho "going wrong"\nexit 7\n';
const SLOW = '#!/bin/sh\nsleep 60\n';
const CHILD = '#!/bin/sh\nsleep 60 &\nwait\n';

test('a successful run reports exit 0 and captures both streams', async () => {
  const cwd = tmpDir();
  const logFile = path.join(tmpDir(), 'run.log');
  const r = await runner.run({
    agent: shimAgent(ECHO), prompt: 'hello world', cwd, logFile, timeoutMs: 10000,
  });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.error, null);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /stdout: hello world/);
  assert.match(log, /stderr line/, 'stderr must be captured too — that is where agents explain failures');
});

test('a non-zero exit is reported, not thrown', async () => {
  const r = await runner.run({
    agent: shimAgent(FAIL), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 10000,
  });
  assert.strictEqual(r.exitCode, 7);
  assert.strictEqual(r.error, null, 'a non-zero exit is the agent failing, not the runner');
});

test('the agent runs in the cwd it is given', async () => {
  const cwd = tmpDir();
  const logFile = path.join(tmpDir(), 'run.log');
  await runner.run({
    agent: shimAgent('#!/bin/sh\npwd\nexit 0\n'), prompt: 'x', cwd, logFile, timeoutMs: 10000,
  });
  assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp(fs.realpathSync(cwd)));
});

test('a run past its timeout is killed and reported as timeout', async () => {
  const r = await runner.run({
    agent: shimAgent(SLOW), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 700,
  });
  assert.strictEqual(r.error, 'timeout');
  assert.strictEqual(r.exitCode, null, 'a killed process has no exit code of its own');
});

test('a timeout reaps the whole process group, not just the direct child', async () => {
  // Agent CLIs spawn tool subprocesses. Killing only the direct pid leaves
  // those orphaned to PID 1 - still writing files, still billing, invisible.
  const before = countSleepers();
  await runner.run({
    agent: shimAgent(CHILD), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 700,
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(countSleepers(), before, 'a grandchild survived the timeout');
});

test('cancel stops a running agent and reports cancelled', async () => {
  const handle = runner.start({
    agent: shimAgent(SLOW), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 60000,
  });
  await new Promise((r) => setTimeout(r, 300));
  handle.cancel();
  const r = await handle.done;
  assert.strictEqual(r.error, 'cancelled');
});

test('a missing agent binary is reported, not thrown', async () => {
  const r = await runner.run({
    agent: { id: 'ghost', bin: '/definitely/not/here/ghost', buildArgs: (p) => ['-p', p] },
    prompt: 'x', cwd: tmpDir(), logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 5000,
  });
  assert.ok(r.error, 'a missing binary must surface as an error');
  assert.match(r.error, /ghost/, 'the message must name the binary');
});

test('onChunk receives output as it arrives', async () => {
  const chunks = [];
  await runner.run({
    agent: shimAgent(ECHO), prompt: 'streamed', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 10000,
    onChunk: (s) => chunks.push(s),
  });
  assert.ok(chunks.join('').includes('streamed'), 'the caller must be able to stream this to SSE');
});
