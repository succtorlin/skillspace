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
// Long enough for a backgrounded tool subprocess to release the inherited
// stdout, short enough that a finished agent is not recorded as a timeout.
const STDIO_GRACE_MS = 2000;
// The log is the record; never wait on it forever (a FIFO with no reader never
// drains), but wait long enough that an ordinary backlog lands.
const DRAIN_GRACE_MS = 5000;
// An unusable timeoutMs falls back to this, never to "no bound".
const DEFAULT_TIMEOUT_MS = 900000;

// Fails CLOSED: an unusable value gets the default, not "no timeout". This is
// the only bound on a billing agent, so silently disabling it is the one
// outcome an invalid input must never produce. A truthiness test made 0, -1,
// NaN and undefined all mean "unbounded". Strings are not coerced: a config
// that stringifies its numbers should be fixed at the boundary, not silently
// accepted here where "0" would read as valid. If "no timeout" is ever wanted
// it needs an explicit sentinel, not a falsy number.
function resolveTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

// Signals the whole process group. Agent CLIs spawn tool subprocesses, and
// signalling only the direct pid leaves those orphaned to PID 1 - still
// writing, still billing, invisible to us.
//
// `note` is an optional writer for diagnostics; reap stays module-level because
// it is part of the module's surface, so the log arrives as an argument rather
// than by closing over it.
function reap(child, signal, note) {
  // 0 and NaN are the two values that must never reach a kill here. When spawn
  // fails asynchronously the pid is undefined, so -pid is NaN (process.kill
  // throws) and the fallback child.kill() reaches a libuv handle whose pid is
  // 0 - which signals OUR OWN process group. start() already normalises the
  // pid to null at the boundary; this is the same knowledge, applied where the
  // signal is actually sent.
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH means the group is already gone, which is the common, benign case.
    // EPERM means the child changed its process group, and the fallback then
    // reaches only the direct child - orphaning exactly the tool subprocesses
    // the group kill exists to catch. Say so; the money property should be
    // observable.
    if (e && e.code !== 'ESRCH' && note) {
      note(`group kill failed (${e.code}), signalling child only`);
    }
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
  let exited = false;
  let exitCode = null;

  // Diagnostics from reap(), which is module-level and cannot see this log.
  const note = (msg) => { if (!settled && log.writable) log.write(`\n[runner] ${msg}\n`); };

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
    //
    // The write-after-end crash is guarded by four overlapping layers: the
    // `settled` flag and the `log.writable` check in write(), this detach, and
    // the error listener on the stream. Any one of them prevents the crash, so
    // no single mutation fails the crash tests - they pin the requirement, not
    // any one mechanism. All four stay, because defence in depth is right for a
    // bug that kills the host process.
    //
    // The log tail is carried by this detach OR by `log.writable`: removing
    // either alone keeps the tail, removing both drops it, because the
    // write-after-end then destroys the stream with the queued buffer - marker
    // included - still in it.
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
    // The hang-guard above covers a stream that has ALREADY failed; this covers
    // one that never completes - a logFile on a FIFO with no reader drains
    // never, and the promise would wait forever. Not unref'd: the bound has to
    // actually fire for it to be a bound. A normal run clears it on 'finish'.
    const drainTimer = setTimeout(() => settle(result), DRAIN_GRACE_MS);
    log.once('finish', () => { clearTimeout(drainTimer); settle(result); });
    log.once('error', () => { clearTimeout(drainTimer); settle(result); });
    log.end();
  };

  const write = (buf) => {
    const s = buf.toString();
    if (!settled && log.writable) log.write(s);
    if (onChunk) {
      try { onChunk(s); } catch (e) {
        // A broken SSE consumer must not kill an agent mid-edit, but it should
        // not vanish either.
        // A consumer can throw a string, or null. `${e.message}` would record
        // "undefined" and lose the only evidence there was.
        const detail = e && e.message ? e.message : String(e);
        if (!settled && log.writable) log.write(`\n[runner] onChunk threw: ${detail}\n`);
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

  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    // 'close' waits for the STDIO to close, which a backgrounded tool
    // subprocess holding the inherited stdout can defer indefinitely - turning
    // an agent that finished in milliseconds into a timeout, with the group
    // kill then destroying the very process it was asked to leave running.
    // Give the pipes a short grace to drain the tail, then settle with the real
    // exit code. This deliberately trades a possibly-truncated tail for not
    // misreporting a success as a timeout - the opposite trade from the drain
    // wait above, and the right one, because a wrong outcome is worse than a
    // short log.
    setTimeout(() => finish({ exitCode, error: null }), STDIO_GRACE_MS).unref();
  });

  // Whichever of 'close' and the grace fires first wins; finish() absorbs the
  // other.
  child.on('close', (code) => finish({ exitCode: code ?? exitCode, error: null }));

  const bound = resolveTimeout(timeoutMs);
  timer = setTimeout(() => {
    if (settled) return;
    log.write(`\n[runner] timeout after ${bound}ms, terminating\n`);
    reap(child, 'SIGTERM', note);
    // Only if it is still alive: five seconds on, this pid's group may have
    // been recycled, and signalling it would kill an unrelated group.
    setTimeout(() => { if (!exited) reap(child, 'SIGKILL', note); }, KILL_GRACE_MS).unref();
    finish({ exitCode: null, error: 'timeout' });
  }, bound);
  timer.unref();

  const cancel = () => {
    if (settled) return;
    log.write('\n[runner] cancelled\n');
    reap(child, 'SIGTERM', note);
    setTimeout(() => { if (!exited) reap(child, 'SIGKILL', note); }, KILL_GRACE_MS).unref();
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

// resolveTimeout is exported so the fallback table can be tested directly;
// the alternative is a test that waits fifteen minutes to observe a default.
module.exports = { start, run, reap, resolveTimeout };
