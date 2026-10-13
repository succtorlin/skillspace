'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logs = require('../lib/logs');

const created = [];
function file(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-logs-'));
  created.push(d);
  const f = path.join(d, 'x.log');
  fs.writeFileSync(f, content);
  return f;
}
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

test('readSlice returns the whole small log and where to resume', () => {
  const s = logs.readSlice(file('hello\nworld\n'), 0);
  assert.deepStrictEqual(s, { text: 'hello\nworld\n', from: 0, next: 12, size: 12, exists: true, reset: false });
});

test('readSlice resumes from an offset', () => {
  const s = logs.readSlice(file('hello\nworld\n'), 6);
  assert.strictEqual(s.text, 'world\n');
  assert.strictEqual(s.next, 12);
});

test('a slice cap never cuts a CJK character in half', () => {
  // 你 and 好 are 3 bytes each. A 4-byte cap lands inside 好; the slice must
  // stop before it rather than hand the browser a U+FFFD. Agents here print
  // Chinese routinely, so this is the common case, not an edge.
  const f = file('你好');
  const a = logs.readSlice(f, 0, 4);
  assert.strictEqual(a.text, '你');
  assert.strictEqual(a.next, 3);
  const b = logs.readSlice(f, a.next, 4);
  assert.strictEqual(b.text, '好');
  assert.strictEqual(b.next, 6);
});

test('a log that currently ends mid-character waits for the rest', () => {
  const f = file(Buffer.from('你').subarray(0, 2));
  const s = logs.readSlice(f, 0);
  assert.strictEqual(s.text, '');
  assert.strictEqual(s.next, 0, 'must not advance past bytes it did not return');
});

test('a 4-byte character straddling the cap is held back too', () => {
  const f = file('a😀');               // 1 + 4 bytes
  const s = logs.readSlice(f, 0, 3);
  assert.strictEqual(s.text, 'a');
  assert.strictEqual(s.next, 1);
});

test('a missing log is not an error: it has not been written yet', () => {
  const s = logs.readSlice(path.join(os.tmpdir(), 'skillspace-no-such-' + Date.now() + '.log'), 0);
  assert.deepStrictEqual(s, { text: '', from: 0, next: 0, size: 0, exists: false, reset: false });
});

test('an offset past the end restarts from zero and says so', () => {
  // Logs only grow, so this means the client's offset belongs to another
  // store (a server restarted with a different SKILLSPACE_HOME). Clamping to
  // the end would silently show nothing forever.
  const s = logs.readSlice(file('abc'), 99);
  assert.strictEqual(s.reset, true);
  assert.strictEqual(s.from, 0);
  assert.strictEqual(s.text, 'abc');
});

test('a garbage or negative offset reads from zero without claiming a reset', () => {
  for (const raw of ['abc', '-5', '1.5', null, undefined, '']) {
    const s = logs.readSlice(file('abc'), raw);
    assert.strictEqual(s.from, 0, `from for ${JSON.stringify(raw)}`);
    assert.strictEqual(s.reset, false, `reset for ${JSON.stringify(raw)}`);
  }
});

test('logPath confines the id to logs/ under the root', () => {
  assert.strictEqual(logs.logPath('/r', 'ord-1'), path.join('/r', 'logs', 'ord-1.log'));
});
