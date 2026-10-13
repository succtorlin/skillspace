'use strict';
const fs = require('fs');
const path = require('path');

// A byte slice of an append-only log, for a browser that polls it by offset.
//
// Why an offset poll and not a stream is argued in docs/plans/2026-10-12-
// board.md ("Live updates"). This module owns the one subtle part: never hand
// back half a UTF-8 character. lib/runner writes through a StringDecoder, so
// the FILE holds whole characters - but a slice cap can land inside one, and
// a reader can catch the file between two writes. Either way the trailing
// partial character is held back and `next` stops before it, so the client's
// next request starts on a boundary.
//
// Known limits:
// - A FILE WHOSE BYTES ARE NOT UTF-8 is emitted as-is and decoded with
//   replacement characters. Only a TRAILING incomplete sequence is held back;
//   malformed bytes mid-file are not ours to repair.
// - `from` is trusted to be a boundary this module returned. A client that
//   invents an offset inside a character gets replacement characters for it.

const MAX_SLICE = 64 * 1024;

function logPath(root, id) {
  return path.join(root, 'logs', `${id}.log`);
}

// How many of the first n bytes form complete UTF-8 characters.
function completeUtf8Length(buf, n) {
  let i = n - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i] & 0xc0) === 0x80) { i--; cont++; }
  if (i < 0) return n; // nothing but continuation bytes: not a sequence we can complete
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return cont + 1 >= need ? n : i;
}

function readSlice(file, fromRaw, max = MAX_SLICE) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: '', from: 0, next: 0, size: 0, exists: false, reset: false };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const asked = typeof fromRaw === 'string' && fromRaw.trim() !== '' ? Number(fromRaw)
      : typeof fromRaw === 'number' ? fromRaw : NaN;
    const valid = Number.isSafeInteger(asked) && asked >= 0;
    const reset = valid && asked > size;
    const from = valid && !reset ? asked : 0;
    const want = Math.min(max, size - from);
    const buf = Buffer.alloc(Math.max(0, want));
    const n = want > 0 ? fs.readSync(fd, buf, 0, want, from) : 0;
    const keep = completeUtf8Length(buf, n);
    return { text: buf.toString('utf8', 0, keep), from, next: from + keep, size, exists: true, reset };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readSlice, logPath, MAX_SLICE };
