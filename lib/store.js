'use strict';
const fs = require('fs');
const path = require('path');

// Durable JSON records. Knows nothing about what it stores — projects, goals
// and orders all use it. Every write is atomic so a crash mid-write can never
// leave a half-written file that fails to parse on next boot.

function abs(root, rel) {
  const full = path.join(root, rel);
  if (!full.startsWith(root)) throw new Error('path escapes store root: ' + rel);
  return full;
}

function writeJson(root, rel, value) {
  const full = abs(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Write to a sibling temp file then rename. rename(2) is atomic on the same
  // filesystem, so a reader sees either the old file or the new one, never a
  // partial write.
  const tmp = full + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, full);
}

function readJson(root, rel, fallback) {
  const full = abs(root, rel);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (_) {
    // Keep the corrupt file for diagnosis rather than deleting evidence, then
    // fall back so a single bad record cannot stop the app from booting.
    try { fs.renameSync(full, full + '.corrupt'); } catch (__) {}
    return fallback;
  }
}

function list(root, sub) {
  const dir = abs(root, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

module.exports = { writeJson, readJson, list };
