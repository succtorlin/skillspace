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
  assert.ok(fs.existsSync(path.join(root, 'bad.json.corrupt')));
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
