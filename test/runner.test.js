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

// A uniquely-named sleeper, so the count cannot see another copy of this suite
// running concurrently - which happens routinely on a shared worktree, and which
// showed up as a DECREASE (the other copy's sleeper dying between the two
// samples) rather than the increase a real leak produces.
//
// This replaced a machine-wide `pgrep -f "sleep 60"`, whose trap is worth
// recording: `pgrep -f` matches ANY command line containing the string,
// including the shell you drive these tests from, so a driving command that
// merely mentions the pattern gets counted as a sleeper. That is why the token
// exists. Poking at a machine-wide count by hand needs a non-self-matching
// pattern like "slee[p] 60".
function sleeperShim() {
  const token = `skillspace-sleeper-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = tmpDir('skillspace-sleeper-');
  const bin = path.join(dir, token);
  fs.writeFileSync(bin, '#!/bin/sh\nsleep 60\n');
  fs.chmodSync(bin, 0o755);
  return { token, bin };
}

function countByToken(token) {
  try {
    return execSync(`pgrep -f ${token} | wc -l`, { encoding: 'utf8' }).trim();
  } catch (_) {
    return '0';
  }
}

// Note for mutation testing: CHATTY never exits on its own, so a mutant that
// disables the timeout wedges this whole file instead of failing it. Scope such
// a run with `node --test --test-name-pattern '<test name>'`.
const ECHO = '#!/bin/sh\necho "stdout: $2"\necho "stderr line" >&2\nexit 0\n';
const FAIL = '#!/bin/sh\necho "going wrong"\nexit 7\n';
const SLOW = '#!/bin/sh\nsleep 60\n';
const CHATTY = '#!/bin/sh\nwhile true; do echo "spam line"; done\n';

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
  const sleeper = sleeperShim();
  const before = countByToken(sleeper.token);
  await runner.run({
    agent: shimAgent(`#!/bin/sh\n"${sleeper.bin}" &\nwait\n`), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 700,
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(countByToken(sleeper.token), before, 'a grandchild survived the timeout');
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

test('a chatty agent that is timed out does not crash the host process', async () => {
  // finish() ended the log while the child was still writing, and the stream
  // had no error listener, so the next chunk raised an unhandled
  // ERR_STREAM_WRITE_AFTER_END and took the process down. The original tests
  // missed it because `sleep 60` is silent; real agents are not.
  const r = await runner.run({
    agent: shimAgent(CHATTY), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 400,
  });
  assert.strictEqual(r.error, 'timeout');
  // Still alive to assert it: reaching this line at all is the assertion.
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(true, 'process survived a chatty timeout');
});

test('a chatty agent that is cancelled does not crash the host process', async () => {
  const handle = runner.start({
    agent: shimAgent(CHATTY), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 60000,
  });
  await new Promise((res) => setTimeout(res, 300));
  handle.cancel();
  const r = await handle.done;
  assert.strictEqual(r.error, 'cancelled');
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(true, 'process survived a chatty cancel');
});

test('an unwritable log directory is reported, not recorded as success', async () => {
  const dir = tmpDir();
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  fs.chmodSync(logDir, 0o500); // r-x: mkdirSync succeeds, the write does not
  try {
    const r = await runner.run({
      agent: shimAgent(ECHO), prompt: 'x', cwd: tmpDir(),
      logFile: path.join(logDir, 'run.log'), timeoutMs: 10000,
    });
    assert.ok(r.error, 'a lost log must not be reported as a clean run');
    assert.match(r.error, /log:/);
  } finally {
    fs.chmodSync(logDir, 0o700);
  }
});

test('a bad cwd is reported as a bad cwd, not a missing agent', async () => {
  const r = await runner.run({
    agent: shimAgent(ECHO), prompt: 'x', cwd: '/definitely/not/here',
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 5000,
  });
  assert.match(r.error, /cwd does not exist/);
  assert.ok(!/fake-agent/.test(r.error), 'the agent was blamed for the caller\'s directory');
});

test('the reason a chatty run ended reaches the log', async () => {
  // Two independent halves prevent the crash (the error listener and the
  // detach), so neither alone fails the crash tests. What the detach uniquely
  // buys is the tail: without it the write-after-end destroys the stream and
  // the queued buffer - marker included - is dropped. The record survives the
  // process, but loses the line explaining why the run ended.
  const logFile = path.join(tmpDir(), 'run.log');
  const r = await runner.run({
    agent: shimAgent(CHATTY), prompt: 'x', cwd: tmpDir(), logFile, timeoutMs: 400,
  });
  assert.strictEqual(r.error, 'timeout');
  assert.match(fs.readFileSync(logFile, 'utf8'), /timeout after 400ms/,
    'the marker explaining the outcome never reached the log');
});
