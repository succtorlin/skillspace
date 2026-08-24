'use strict';
const fs = require('fs');
const path = require('path');

// Durable JSON records. Knows nothing about what it stores — projects, goals
// and orders all use it. Every write is atomic against a crash or kill
// mid-write: a reader never sees a half-written file that fails to parse on
// next boot. There is no fsync before the rename, so power loss is out of
// scope — deliberately, for a localhost tool.

function abs(root, rel) {
  // Normalise first: a root with a trailing separator would make every path
  // look like an escape, breaking the store entirely at wiring time.
  const base = path.resolve(root);
  const full = path.join(base, rel);
  // startsWith(base) alone is not enough: with base "/base/store" it also
  // accepts "/base/store-evil", a different directory that merely shares the
  // prefix. Compare against base + separator, and allow base itself.
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes store root: ' + rel);
  }
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
  try {
    fs.renameSync(tmp, full);
  } catch (e) {
    // Don't leave the temp behind on a failed rename; the caller is getting an
    // exception, so the write did not happen and the temp is pure litter.
    try { fs.unlinkSync(tmp); } catch (__) {}
    throw e;
  }
}

function readJson(root, rel, fallback) {
  const full = abs(root, rel);
  if (!fs.existsSync(full)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (_) {
    // An I/O error is NOT corruption. The bytes may be perfectly good and we
    // simply could not read them (permissions, EISDIR, fd exhaustion). Moving
    // the file aside here would relocate healthy data — and renameSync happily
    // renames directories, so a single bad read could empty a whole subtree.
    // Fall back and leave the filesystem exactly as it was.
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Genuinely unparseable. Keep the bad bytes for diagnosis rather than
    // deleting the evidence, then fall back so one bad record cannot stop the
    // app booting. Suffix with a timestamp so a second corruption cannot
    // overwrite the first copy.
    const dest = full + '.' + Date.now() + '.corrupt';
    try {
      fs.renameSync(full, dest);
      console.warn('[store] unparseable record moved aside: ' + dest);
    } catch (__) {
      // Nothing left to preserve (e.g. the file vanished under us). The
      // fallback below is the actual recovery; there is nothing to report.
    }
    return fallback;
  }
}

function list(root, sub) {
  const dir = abs(root, sub);
  if (!fs.existsSync(dir)) return [];
  // Contract: lexicographic by id. readdirSync order is stable-looking on APFS
  // and arbitrary on ext4's hashed directories, so sort rather than let a
  // caller observe an accident and depend on it. Ordering by anything inside
  // the record (seq, createdAt) stays the caller's job — list never opens a
  // file.
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

module.exports = { writeJson, readJson, list };
