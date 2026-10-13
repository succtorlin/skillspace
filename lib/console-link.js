'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Where the console link (with the per-boot API secret) is written, and how.
//
// stdout is not a safe place for it once SkillSpace runs as a service: launchd
// sends it to /tmp/skillspace.log, mode 644, readable by any agent this server
// spawns. So the full link goes to a 0600 file instead, and only an
// interactive terminal still sees it printed.
//
// OUTSIDE ~/.skillspace by default: agents' worktrees live under it. Under
// SKILLSPACE_HOME when that is set, so tests and demos never touch the real
// location.
//
// The residual, stated plainly: any process running as the same OS user can
// read a 0600 file, or the browser's history. This stops web pages and blind
// or opportunistic local requests, not a targeted same-user attacker.
function defaultFile(env = process.env) {
  if (env.SKILLSPACE_HOME) return path.join(env.SKILLSPACE_HOME, 'console-link');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'SkillSpace', 'console-link');
  }
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'skillspace', 'console-link');
}

// Atomic replace: a fresh temp file created with O_EXCL at 0600 (so nothing
// pre-planted can be written through, and it is never readable by others even
// for an instant), then renamed over the old one.
function write(file, link) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, link + '\n');
    fs.fchmodSync(fd, 0o600); // umask cannot widen it, but be explicit
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// Removes the file only if it still holds THIS boot's link: a second instance
// may have replaced it, and its key must survive this one shutting down.
function remove(file, link) {
  try {
    if (fs.readFileSync(file, 'utf8').trim() === link) fs.unlinkSync(file);
  } catch (_) { /* already gone, or unreadable: nothing of ours to remove */ }
}

module.exports = { defaultFile, write, remove };
