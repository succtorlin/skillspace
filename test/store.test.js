const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');

const created = [];

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-test-'));
  created.push(d);
  return d;
}

after(() => {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

test('writeJson then readJson round-trips', () => {
  const root = tmpRoot();
  store.writeJson(root, 'projects.json', { a: 1 });
  assert.deepStrictEqual(store.readJson(root, 'projects.json', null), { a: 1 });
});

test('readJson returns the fallback when the file is absent', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(store.readJson(root, 'nope.json', []), []);
});

test('readJson returns the fallback when the file is corrupt, and keeps the bad file', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'bad.json'), '{ not json');
  assert.deepStrictEqual(store.readJson(root, 'bad.json', []), []);
  const kept = fs.readdirSync(root).filter((f) => f.startsWith('bad.json.') && f.endsWith('.corrupt'));
  assert.strictEqual(kept.length, 1, 'the unparseable bytes must be kept for diagnosis');
});

test('writeJson leaves no temp file behind', () => {
  const root = tmpRoot();
  store.writeJson(root, 'x.json', { ok: true });
  const stray = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(stray, []);
});

test('writeJson creates nested directories', () => {
  const root = tmpRoot();
  store.writeJson(root, 'orders/ord-1.json', { id: 'ord-1' });
  assert.deepStrictEqual(store.readJson(root, 'orders/ord-1.json', null), { id: 'ord-1' });
});

test('list returns ids of records in a subdirectory', () => {
  const root = tmpRoot();
  store.writeJson(root, 'orders/ord-1.json', { id: 'ord-1' });
  store.writeJson(root, 'orders/ord-2.json', { id: 'ord-2' });
  assert.deepStrictEqual(store.list(root, 'orders').sort(), ['ord-1', 'ord-2']);
});

test('list returns empty for a missing subdirectory', () => {
  assert.deepStrictEqual(store.list(tmpRoot(), 'orders'), []);
});

test('abs rejects a sibling directory that merely shares the root prefix', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-prefix-'));
  created.push(base);
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  assert.throws(
    () => store.writeJson(root, '../store-evil/x.json', { pwned: true }),
    /escapes store root/
  );
  assert.ok(!fs.existsSync(path.join(base, 'store-evil')), 'nothing may be written outside the root');
});

test('writeJson writes via a temp file and renames — never straight to the target', () => {
  const root = tmpRoot();
  const target = path.join(root, 'atomic.json');
  // This monkeypatch is process-global and is safe only because everything
  // between the patch and the restore is synchronous. Do not introduce an
  // await here: the patch would leak into whatever test runs next.
  const renames = [];
  const realRename = fs.renameSync;
  const realWrite = fs.writeFileSync;
  const writes = [];
  fs.renameSync = (from, to) => { renames.push([from, to]); return realRename(from, to); };
  fs.writeFileSync = (p, d, o) => { writes.push(p); return realWrite(p, d, o); };
  try {
    store.writeJson(root, 'atomic.json', { v: 1 });
  } finally {
    fs.renameSync = realRename;
    fs.writeFileSync = realWrite;
  }
  // the payload must never be written directly to its final path
  assert.ok(!writes.includes(target), 'wrote straight to the target — not atomic');
  assert.strictEqual(writes.length, 1, 'expected exactly one write, to a temp path');
  assert.ok(writes[0].endsWith('.tmp'), 'the write target should be a .tmp path');
  // and it must land at the target via rename
  assert.deepStrictEqual(renames, [[writes[0], target]]);
  assert.deepStrictEqual(store.readJson(root, 'atomic.json', null), { v: 1 });
});

test('a root with a trailing separator still works', () => {
  const root = tmpRoot();
  store.writeJson(root + path.sep, 'trailing.json', { ok: true });
  assert.deepStrictEqual(store.readJson(root, 'trailing.json', null), { ok: true });
});

test('readJson refuses to read outside the store root', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(path.dirname(root), 'secret.json'), '{"apiKey":"SECRET"}');
  assert.throws(() => store.readJson(root, '../secret.json', null), /escapes store root/);
});

test('list refuses to enumerate outside the store root', () => {
  const root = tmpRoot();
  assert.throws(() => store.list(root, '../'), /escapes store root/);
});

test('list returns only .json records, never temp or corrupt files', () => {
  const root = tmpRoot();
  store.writeJson(root, 'orders/ord-1.json', { v: 1 });
  fs.writeFileSync(path.join(root, 'orders', 'ord-9.json.4242.tmp'), 'partial');
  fs.writeFileSync(path.join(root, 'orders', 'ord-8.json.171.corrupt'), 'garbage');
  assert.deepStrictEqual(store.list(root, 'orders'), ['ord-1']);
});
