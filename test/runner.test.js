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

// Waits for the grandchild to actually appear. A fixed sleep flakes: the chain
// is two shells deep, and under load it can take longer than any delay short
// enough to land before the timeout fires.
async function waitForGrandchild(token, before, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (Number(countByToken(token)) > Number(before)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// A grandchild that ignores SIGTERM, to prove the +5s SIGKILL escalation still
// happens. `trap '' TERM` sets SIG_IGN, which the sleep child inherits, so the
// whole subtree survives SIGTERM and only SIGKILL removes it. The marker file
// proves the trap is armed BEFORE anything signals it - otherwise the signal
// races the trap and the test passes for the wrong reason.
function trapperShim() {
  const token = `skillspace-trapper-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = tmpDir('skillspace-trapper-');
  const bin = path.join(dir, token);
  const armed = path.join(dir, 'armed');
  fs.writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\ntouch ${armed}\nsleep 60\n`);
  fs.chmodSync(bin, 0o755);
  return { token, bin, armed };
}

async function waitForFile(file, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// KILL_GRACE_MS in lib/runner.js is 5s; this is that plus room to observe.
const AFTER_ESCALATION_MS = 6500;

// PRECONDITION BOUNDS, and what they are actually protecting - read this before
// tightening them back.
//
// Several tests below assert that NOTHING survived a reap. "Nothing survived"
// is also trivially true of a grandchild that never started, so each one first
// waits for evidence that the chain really came up. That wait is a bound on
// PROCESS SPAWN LATENCY, which is not a function of CPU load alone: measured
// failures came from running two full suites concurrently - doubled process
// count - where a chain two shells deep took over 1500ms to appear. Single-suite
// runs at 24 CPU hogs never reproduced it. So the bound has to cover a machine
// that is busy with PROCESSES, not merely busy.
//
// Two constants because the two kinds of evidence have different constraints:
//
// LIVE_PRECONDITION_MS polls for a live process, so it is racing the reap it is
// setting up - once the run's timeoutMs fires, the process is gone and no
// further waiting can ever succeed. It must therefore stay BELOW the timeoutMs
// of any run it guards, and that run's timeoutMs is what really sets the
// headroom. Raising this without raising that timeout buys nothing.
//
// FILE_PRECONDITION_MS waits for a marker the shim wrote, which is durable - it
// survives the reap - so it is free to be generous and is not bounded by the
// run's timeout at all.
const LIVE_PRECONDITION_MS = 5000;
const FILE_PRECONDITION_MS = 15000;

function countByToken(token) {
  try {
    return execSync(`pgrep -f ${token} | wc -l`, { encoding: 'utf8' }).trim();
  } catch (_) {
    return '0';
  }
}

// Known limits:
//  - Mutation testing: CHATTY never exits on its own, so a mutant that disables
//    the timeout wedges this whole file instead of failing it. Scope such a run
//    with `node --test --test-name-pattern '<test name>'`.
//  - The bounded drain wait (DRAIN_GRACE_MS) is NOT pinned here. The natural
//    pin - a logFile on a FIFO with no reader - wedges this file even against
//    correct code, because the open() blocks before any of our timers exist. To
//    pin it, run that case in a SPAWNED CHILD and assert on the child's exit
//    code, so the wedge is contained by a hard timeout while the parent asserts
//    cleanly.
//  - The +5s SIGKILL escalation is pinned (below), but a group-kill FAILURE at
//    that point leaves no trace: `settled` is true and the log is closed.
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
  const handle = runner.start({
    agent: shimAgent(`#!/bin/sh\n"${sleeper.bin}" &\nwait\n`), prompt: 'x', cwd: tmpDir(),
    // Generous on purpose: the precondition below polls for a LIVE process, so
    // it is racing this timeout, and the grandchild has to be observed alive
    // before the reap it is setting up. At 2000ms with the poll at 1500ms this
    // was the branch's only recurring flake - 1 in 349, and only ever with two
    // suites running at once. The run still ends when the timeout fires, so
    // this costs wall time and buys the headroom.
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 6000,
  });
  // Without this, "after === before" is also satisfied by a grandchild that
  // never started, and the test would pass while proving nothing.
  assert.ok(await waitForGrandchild(sleeper.token, before, LIVE_PRECONDITION_MS),
    'the grandchild never started, so this test proves nothing');
  await handle.done;
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(countByToken(sleeper.token), before, 'a grandchild survived the timeout');
});

test('cancel reaps the whole process group, not just the direct child', async () => {
  // Group-kill was only exercised on the timeout path, so a cancel() that
  // settled without signalling passed every test - while leaving the agent and
  // its tool subprocesses running, billing, with nothing left to reap them.
  // Cancel is the path a user actually triggers from the UI.
  const sleeper = sleeperShim();
  const before = countByToken(sleeper.token);
  const handle = runner.start({
    agent: shimAgent(`#!/bin/sh\n"${sleeper.bin}" &\nwait\n`), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 60000,
  });
  // Not racing anything: the run's timeoutMs is 60s and the cancel below is what
  // ends it, so this bound only has to cover spawn latency.
  assert.ok(await waitForGrandchild(sleeper.token, before, FILE_PRECONDITION_MS),
    'the grandchild never started, so this test proves nothing');
  handle.cancel();
  await handle.done;
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(countByToken(sleeper.token), before, 'a grandchild survived the cancel');
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
  const handle = runner.start({
    agent: { id: 'ghost', bin: '/definitely/not/here/ghost', buildArgs: (p) => ['-p', p] },
    prompt: 'x', cwd: tmpDir(), logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 5000,
  });
  // The spawn failure arrives asynchronously, after start() has already handed
  // back a pid, so an un-normalised pid is `undefined` and a `pid !== null`
  // check does not mean what it looks like.
  assert.strictEqual(handle.pid, null, 'a failed spawn must report a null pid, not undefined');
  const r = await handle.done;
  assert.ok(r.error, 'a missing binary must surface as an error');
  assert.match(r.error, /ghost/, 'the message must name the binary');
});

test('onChunk receives output as it arrives, from both streams', async () => {
  const chunks = [];
  await runner.run({
    agent: shimAgent(ECHO), prompt: 'streamed', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 10000,
    onChunk: (s) => chunks.push(s),
  });
  const streamed = chunks.join('');
  assert.ok(streamed.includes('streamed'), 'the caller must be able to stream this to SSE');
  // Stderr is where agents explain failures. A UI fed only stdout would stream
  // the run happily and silently drop the diagnosis.
  assert.ok(streamed.includes('stderr line'), 'stderr never reached the callback');
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
  // This pins the drain-wait: resolving without waiting for the stream to
  // finish leaves the marker still queued, and a caller reading the log the
  // instant done resolves misses the one line explaining the record.
  //
  // It also pins "no write-after-end occurs", which is carried by the detach OR
  // by log.writable - removing either alone keeps this green, removing both
  // destroys the stream with the marker still queued. It does NOT pin the
  // detach specifically; nothing does, and that is a property of defence in
  // depth rather than a gap to close.
  const logFile = path.join(tmpDir(), 'run.log');
  const r = await runner.run({
    agent: shimAgent(CHATTY), prompt: 'x', cwd: tmpDir(), logFile, timeoutMs: 400,
  });
  assert.strictEqual(r.error, 'timeout');
  const atResolve = fs.readFileSync(logFile, 'utf8');
  assert.match(atResolve, /timeout after 400ms/,
    'the marker explaining the outcome never reached the log');
  // The marker alone is a flaky pin: on a short backlog it can happen to be
  // flushed already, and a mutant that drops the drain-wait then survives. The
  // drain itself is the deterministic property - without the wait the file is
  // still being written after done resolved.
  await new Promise((res) => setTimeout(res, 700));
  assert.strictEqual(fs.readFileSync(logFile, 'utf8').length, atResolve.length,
    'the log was still being written after done resolved');
});

test('a throwing onChunk cannot kill the run, and leaves a trace', async () => {
  const logFile = path.join(tmpDir(), 'run.log');
  const r = await runner.run({
    agent: shimAgent(ECHO), prompt: 'x', cwd: tmpDir(), logFile, timeoutMs: 10000,
    // Deliberately a non-Error: consumers throw strings, and `${e.message}`
    // would record "onChunk threw: undefined", losing the only evidence there
    // was. Throwing a string pins the swallow, the trace, AND the detail.
    onChunk: () => { throw 'consumer exploded'; },
  });
  assert.strictEqual(r.exitCode, 0, 'a broken consumer must not kill an agent mid-edit');
  assert.match(fs.readFileSync(logFile, 'utf8'), /onChunk threw: consumer exploded/,
    'the failure vanished silently, or lost its detail');
});

test('cancelling a failed spawn does not signal our own process group', async () => {
  // -undefined is NaN and child.kill() on a dead handle signals pid 0, i.e.
  // every process in OUR group. Reachable synchronously after start(), because
  // the ENOENT arrives on process.nextTick and `settled` is still false.
  const handle = runner.start({
    agent: { id: 'ghost', bin: '/definitely/not/here/ghost', buildArgs: (p) => ['-p', p] },
    prompt: 'x', cwd: tmpDir(), logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 5000,
  });
  handle.cancel();                      // synchronous: the dangerous window
  const r = await handle.done;
  // The cancel legitimately wins the race with the nextTick ENOENT, so this
  // records `cancelled`, not the missing binary. Either is a correct outcome;
  // asserting the one that actually happens keeps the test honest.
  assert.match(r.error, /cancelled/, 'the run must still report how it ended');
  assert.ok(true, 'the test process survived its own cancel');
});

test('an agent that backgrounds a subprocess reports its real exit code, not a timeout', async () => {
  // 'close' waits for the stdio to close, not for the agent to exit. An agent
  // told to "start the dev server and check it" exits 0 in milliseconds while a
  // backgrounded child holds the inherited stdout - and the run used to sit
  // open until the timeout, then record `timeout / exitCode: null` and group-
  // kill the very process it had been asked to leave running.
  const logFile = path.join(tmpDir(), 'run.log');
  const started = Date.now();
  const r = await runner.run({
    agent: shimAgent('#!/bin/sh\nsleep 8 &\necho "done"\nexit 0\n'), prompt: 'x',
    cwd: tmpDir(), logFile, timeoutMs: 5000,
  });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.exitCode, 0, 'the real exit code was lost');
  assert.strictEqual(r.error, null, 'a finished agent was recorded as a failure');
  // Settles on the stdio grace (~2s), not the 5s timeout; the gap is the
  // discrimination, and it is wide enough not to flake under load.
  assert.ok(elapsed < 4000, `settled in ${elapsed}ms - it waited for the timeout, not the exit`);
});

test('an unusable timeoutMs falls back to the default bound, never to no bound', () => {
  // A truthiness test made 0, -1, NaN and undefined all mean "unbounded" - on
  // the one property standing between a stuck agent and an unbounded bill.
  for (const bad of [0, -1, NaN, undefined, null, Infinity, '500']) {
    const bound = runner.resolveTimeout(bad);
    assert.ok(Number.isFinite(bound) && bound > 0,
      `timeoutMs ${String(bad)} produced ${bound} - an unusable value must never disable the bound`);
  }
  // Strings are not coerced: '500' is a boundary bug to fix at the caller, and
  // accepting it here would also accept '0'.
  assert.strictEqual(runner.resolveTimeout('500'), runner.resolveTimeout(-1));
  assert.strictEqual(runner.resolveTimeout(700), 700, 'a usable value must be honoured exactly');
});

test('a grandchild that ignores SIGTERM is escalated to SIGKILL on cancel', async () => {
  // `exited` tracks the DIRECT child, which does die from our own group
  // SIGTERM - so guarding escalation on it skipped the escalation in exactly
  // the case it exists for. Any tool subprocess with a signal handler, a dev
  // server shutting down gracefully, or docker run lands here, and without the
  // escalation it runs on indefinitely, still billing.
  const trapper = trapperShim();
  const before = countByToken(trapper.token);
  const handle = runner.start({
    agent: shimAgent(`#!/bin/sh\n"${trapper.bin}" &\nwait\n`), prompt: 'x', cwd: tmpDir(),
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 60000,
  });
  assert.ok(await waitForFile(trapper.armed, FILE_PRECONDITION_MS),
    'the trap never armed, so this test proves nothing');
  handle.cancel();
  await handle.done;
  await new Promise((r) => setTimeout(r, AFTER_ESCALATION_MS));
  assert.strictEqual(countByToken(trapper.token), before,
    'a grandchild that ignored SIGTERM was never escalated to SIGKILL');
});

test('a grandchild that ignores SIGTERM is escalated to SIGKILL on timeout', async () => {
  // Both paths reap, so both paths are pinned: the guard broke them together.
  const trapper = trapperShim();
  const before = countByToken(trapper.token);
  const handle = runner.start({
    agent: shimAgent(`#!/bin/sh\n"${trapper.bin}" &\nwait\n`), prompt: 'x', cwd: tmpDir(),
    // The marker below is durable, so the WAIT does not race this timeout - but
    // the trap still has to ARM before it, or the shim is reaped before it can
    // write the marker and the precondition fails honestly but pointlessly.
    // 1200ms was ~24x the typical arming time and still inside the range where
    // a machine busy with processes misses it.
    logFile: path.join(tmpDir(), 'run.log'), timeoutMs: 4000,
  });
  assert.ok(await waitForFile(trapper.armed, FILE_PRECONDITION_MS),
    'the trap never armed, so this test proves nothing');
  await handle.done;
  await new Promise((r) => setTimeout(r, AFTER_ESCALATION_MS));
  assert.strictEqual(countByToken(trapper.token), before,
    'a grandchild that ignored SIGTERM was never escalated to SIGKILL');
});

test('a character split across two pipe reads is not corrupted', async () => {
  // A pipe read ends wherever 64KB lands. Decoding each Buffer independently
  // turns the two halves of one character into replacement characters, and it
  // fails silently: U+FFFD is legal in JSON, so a plan carrying one still
  // parses and the corrupted text reaches a persisted order prompt. The same
  // bug was fixed on the HTTP body path in server.js; this is the runner's.
  const dir = tmpDir('skillspace-mb-');
  const shim = path.join(dir, 'shim.js');
  const HEAD = 'PREFIX:';
  // First byte of U+4F60 at offset 65535, so its three bytes straddle 65536.
  fs.writeFileSync(shim,
    `const pad = 'a'.repeat(65535 - ${Buffer.byteLength(HEAD)});\n`
    + `process.stdout.write(${JSON.stringify(HEAD)} + pad + '\\u4f60\\u597d' + ':SUFFIX');\n`);
  const agent = shimAgent(`#!/bin/sh\nexec node ${shim}\n`);

  let seen = '';
  const logFile = path.join(dir, 'run.log');
  const result = await runner.run({
    agent, prompt: 'x', cwd: dir, logFile, timeoutMs: 30000,
    env: { ...process.env }, onChunk: (c) => { seen += c; },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.ok(!seen.includes('�'), 'onChunk carried replacement characters');
  assert.match(seen, /a你好:SUFFIX$/, 'the split character was not rejoined');
  // The log is the durable record and takes the same decoded text.
  const logged = fs.readFileSync(logFile, 'utf8');
  assert.ok(!logged.includes('�'), 'the log file carried replacement characters');
  assert.match(logged, /a你好:SUFFIX/);
});

test('bytes still held by the decoder when a child dies are not dropped', async () => {
  // A child killed mid-character leaves an incomplete sequence in the decoder.
  // Dropping it loses real output; flushing renders it as U+FFFD, which is the
  // honest reading of bytes that are genuinely not a character.
  const dir = tmpDir('skillspace-mb-');
  const shim = path.join(dir, 'shim.js');
  // Write a lone lead byte of a 3-byte sequence, then exit.
  fs.writeFileSync(shim, "process.stdout.write(Buffer.from([0x41, 0x42, 0xE4]));\n");
  const agent = shimAgent(`#!/bin/sh\nexec node ${shim}\n`);

  let seen = '';
  const result = await runner.run({
    agent, prompt: 'x', cwd: dir, logFile: path.join(dir, 'run.log'), timeoutMs: 30000,
    env: { ...process.env }, onChunk: (c) => { seen += c; },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(seen, 'AB�', 'the truncated trailing byte was dropped instead of flushed');
});

test('stdout and stderr are decoded independently', async () => {
  // They are separate byte streams. A character split across two stdout reads
  // must be rejoined with the NEXT STDOUT read - not with whatever stderr
  // happened to say in between, which one shared decoder would splice into the
  // middle of it. Agent CLIs write progress to stderr while writing content to
  // stdout, so the interleaving is the normal case.
  const dir = tmpDir('skillspace-mb-');
  const shim = path.join(dir, 'shim.js');
  fs.writeFileSync(shim, [
    "process.stdout.write(Buffer.from([0x41]));",              // 'A'
    "process.stdout.write(Buffer.from([0xE4, 0xBD]));",        // first 2 of 3 bytes of U+4F60
    "setTimeout(() => {",
    "  process.stderr.write('ERR');",                           // arrives mid-character
    "  setTimeout(() => {",
    "    process.stdout.write(Buffer.from([0xA0]));",           // completes U+4F60
    "    process.stdout.write('!');",
    "  }, 120);",
    "}, 120);",
  ].join('\n'));
  const agent = shimAgent(`#!/bin/sh\nexec node ${shim}\n`);

  let seen = '';
  const result = await runner.run({
    agent, prompt: 'x', cwd: dir, logFile: path.join(dir, 'run.log'), timeoutMs: 30000,
    env: { ...process.env }, onChunk: (c) => { seen += c; },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.ok(!seen.includes('�'), `a shared decoder spliced the streams: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('你'), 'the stdout character was not rejoined across the stderr write');
  assert.ok(seen.includes('ERR'), 'the stderr text was lost');
});
