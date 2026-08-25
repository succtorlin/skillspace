'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Spawns one agent, streams its output to a log file and an optional callback,
// bounds its runtime, and reports how it ended. Knows nothing about orders,
// projects or git - it is handed a cwd and a prompt and reports a result.
//
// The result is always a value, never a throw: "the agent exited 7" and "the
// binary is missing" are outcomes to record, not exceptions to handle.

const KILL_GRACE_MS = 5000;

// Signals the whole process group. Agent CLIs spawn tool subprocesses, and
// signalling only the direct pid leaves those orphaned to PID 1 - still
// writing, still billing, invisible to us.
function reap(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    try { child.kill(signal); } catch (__) {}
  }
}

// Returns { done, cancel, pid }. `done` settles with
// { exitCode, error, logFile } and never rejects.
function start({ agent, prompt, cwd, logFile, timeoutMs, env, onChunk }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Append, not write: the log is the record of what happened and a caller
  // may have already written a header line.
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  // A WriteStream with no error listener turns any write failure into an
  // unhandled 'error' event, which kills the process. Two ways in: writing
  // after finish() ended the stream (the child is still alive and still
  // chatty), and an unwritable log directory, which fails asynchronously long
  // after createWriteStream returned. Neither is on the promise path, so a
  // caller cannot catch them.
  let logError = null;
  log.on('error', (e) => { logError = e; });

  let settled = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let timer = null;
  let child = null;

  // Guarded separately from `settled`, because both the finish and the error
  // listener below can fire.
  let resolved = false;
  const settle = (result) => {
    if (resolved) return;
    resolved = true;
    resolveDone({
      logFile,
      ...result,
      // A run whose log could not be written is not a clean run, whatever the
      // exit code said.
      error: result.error || (logError ? `log: ${logError.message}` : null),
    });
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    // Detach first: the child outlives a timeout or a cancel by design, and
    // its next chunk would otherwise hit an ended stream.
    if (child) {
      if (child.stdout) child.stdout.removeAllListeners('data');
      if (child.stderr) child.stderr.removeAllListeners('data');
    }
    // Resolve only once the backlog is on disk. On a chatty run this is
    // hundreds of KB behind, and a caller reading the log the instant done
    // resolves would miss the tail - including the marker saying why the run
    // ended, which is the one line that explains the record.
    // A stream that has ALREADY failed - an unwritable log directory fails
    // asynchronously, typically before we get here - emits neither 'finish' nor
    // 'error' again, so waiting on it would hang the promise forever. There is
    // no backlog left to wait for either; the failure dropped it. Settle now.
    if (logError || log.destroyed) {
      settle(result);
      return;
    }
    log.once('finish', () => settle(result));
    log.once('error', () => settle(result));   // a dead stream will never finish
    log.end();
  };

  const write = (buf) => {
    const s = buf.toString();
    if (!settled && log.writable) log.write(s);
    if (onChunk) {
      try { onChunk(s); } catch (e) {
        // A broken SSE consumer must not kill an agent mid-edit, but it should
        // not vanish either.
        if (!settled && log.writable) log.write(`\n[runner] onChunk threw: ${e.message}\n`);
      }
    }
  };

  try {
    child = spawn(agent.bin, agent.buildArgs(prompt), {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so reap() can signal the whole tree.
      detached: true,
    });
  } catch (e) {
    finish({ exitCode: null, error: `${agent.bin}: ${e.message}` });
    return { done, cancel: () => {}, pid: null };
  }

  child.stdout.on('data', write);
  child.stderr.on('data', write);

  child.on('error', (e) => {
    // ENOENT lands here, not in the try above. Name the binary: a missing
    // agent must say which one. But spawn reports a missing binary and an
    // unusable cwd identically, so check the cwd ourselves rather than blaming
    // the agent for the caller's directory.
    const cwdGone = e.code === 'ENOENT' && !fs.existsSync(cwd);
    const msg = cwdGone ? `cwd does not exist: ${cwd}` : `${agent.bin}: ${e.message}`;
    if (!settled && log.writable) log.write(`\n[runner] ${msg}\n`);
    finish({ exitCode: null, error: msg });
  });

  child.on('close', (code) => finish({ exitCode: code, error: null }));

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (settled) return;
      log.write(`\n[runner] timeout after ${timeoutMs}ms, terminating\n`);
      reap(child, 'SIGTERM');
      setTimeout(() => reap(child, 'SIGKILL'), KILL_GRACE_MS).unref();
      finish({ exitCode: null, error: 'timeout' });
    }, timeoutMs);
    timer.unref();
  }

  const cancel = () => {
    if (settled) return;
    log.write('\n[runner] cancelled\n');
    reap(child, 'SIGTERM');
    setTimeout(() => reap(child, 'SIGKILL'), KILL_GRACE_MS).unref();
    finish({ exitCode: null, error: 'cancelled' });
  };

  // An async spawn failure (ENOENT) arrives after this returns, so the pid was
  // never valid even though spawn handed one back - normalise it to null so a
  // `pid !== null` check means what it looks like it means.
  return { done, cancel, pid: child.pid ?? null };
}

// Convenience for callers that do not need to cancel.
function run(opts) {
  return start(opts).done;
}

module.exports = { start, run, reap };
