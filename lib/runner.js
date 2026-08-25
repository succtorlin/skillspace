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

  let settled = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let timer = null;
  let child = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    log.end();
    resolveDone({ logFile, ...result });
  };

  const write = (buf) => {
    const s = buf.toString();
    log.write(s);
    if (onChunk) {
      try { onChunk(s); } catch (_) { /* a broken consumer must not kill the run */ }
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
    // agent must say which one.
    log.write(`\n[runner] ${agent.bin}: ${e.message}\n`);
    finish({ exitCode: null, error: `${agent.bin}: ${e.message}` });
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

  return { done, cancel, pid: child.pid };
}

// Convenience for callers that do not need to cancel.
function run(opts) {
  return start(opts).done;
}

module.exports = { start, run, reap };
