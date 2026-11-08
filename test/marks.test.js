import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Marks } from '../src/marks.js';
import { createServer } from '../src/server.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-marks-')), 'marks.json');

test('marks seen and done per user and turn, and undoes done', () => {
  const file = tmpFile();
  const m = new Marks(file);
  m.mark('me', 'default/w1:p1', 'seen', 't1');
  m.mark('me', 'default/w1:p1', 'done', 't1');
  assert.deepEqual(m.get('me'), { 'default/w1:p1': { seen: 't1', done: 't1' } });
  m.mark('me', 'default/w1:p1', 'undone', 't1');
  assert.deepEqual(new Marks(file).get('me'), { 'default/w1:p1': { seen: 't1' } });
  assert.deepEqual(m.get('you'), {});
});

test('rejects unknown kinds and bad values', () => {
  const m = new Marks(tmpFile());
  assert.throws(() => m.mark('me', 'a', 'nuke', 't'), /kind/);
  assert.throws(() => m.mark('me', '', 'seen', 't'), /id/);
  assert.throws(() => m.mark('me', 'a', 'seen', 5), /turn/);
});

test('keeps only the most recent agents per user', () => {
  const m = new Marks(tmpFile(), { maxPerUser: 3 });
  for (const id of ['a', 'b', 'c', 'd']) m.mark('me', id, 'seen', 't');
  m.mark('me', 'b', 'done', 't');
  assert.deepEqual(Object.keys(m.get('me')), ['c', 'd', 'b']);
});

test('GET and POST /api/marks work per Tailscale user', async () => {
  const marks = new Marks(tmpFile());
  const server = createServer({ hub: { agents: () => [] }, allowedUsers: ['me@x.com'], marks });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/marks`;
  const headers = { 'tailscale-user-login': 'me@x.com', 'content-type': 'application/json' };
  try {
    let r = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ id: 'default/w1:p1', kind: 'done', turn: 't1' }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { 'default/w1:p1': { done: 't1' } });
    assert.deepEqual(await (await fetch(base, { headers })).json(), { 'default/w1:p1': { done: 't1' } });
    r = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ id: 'x', kind: 'nuke', turn: 't' }) });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
