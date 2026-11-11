import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prefs } from '../src/prefs.js';
import { createServer } from '../src/server.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-prefs-')), 'sub', 'prefs.json');

test('prefs are kept per user and survive a restart', () => {
  const file = tmpFile();
  const a = new Prefs(file);
  assert.deepEqual(a.get('me@x.com'), {});
  assert.deepEqual(a.set('me@x.com', { filter: 'Work' }), { filter: 'Work' });
  a.set('you@x.com', { filter: 'all' });
  const b = new Prefs(file);
  assert.deepEqual(b.get('me@x.com'), { filter: 'Work' });
  assert.deepEqual(b.get('you@x.com'), { filter: 'all' });
});

test('only known prefs with sane values are stored', () => {
  const p = new Prefs(tmpFile());
  assert.deepEqual(p.set('me', { filter: 'x'.repeat(200), evil: 1 }), {});
  assert.deepEqual(p.set('me', { filter: 42 }), {});
  assert.deepEqual(p.set('me', { filter: 'Acme' }), { filter: 'Acme' });
});

test('a corrupt prefs file starts empty instead of crashing', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(new Prefs(file).get('me'), {});
});

test('GET and PUT /api/prefs read and write the caller\'s own prefs', async () => {
  const prefs = new Prefs(tmpFile());
  const server = createServer({ hub: { agents: () => [] }, allowedUsers: ['me@x.com', 'you@x.com'], prefs });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/prefs`;
  const as = user => ({ 'tailscale-user-login': user, 'content-type': 'application/json' });
  try {
    let r = await fetch(base, { method: 'PUT', headers: as('me@x.com'), body: JSON.stringify({ filter: 'Work' }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { filter: 'Work' });
    assert.deepEqual(await (await fetch(base, { headers: as('me@x.com') })).json(), { filter: 'Work' });
    assert.deepEqual(await (await fetch(base, { headers: as('you@x.com') })).json(), {});
  } finally { server.close(); }
});

test('hidden spaces are a list of ids', () => {
  const p = new Prefs(tmpFile());
  assert.deepEqual(p.set('me', { hidden: ['default/w1', 'work/w2'] }), { hidden: ['default/w1', 'work/w2'] });
  assert.deepEqual(p.set('me', { filter: 'all' }), { hidden: ['default/w1', 'work/w2'], filter: 'all' }, 'other prefs leave it alone');
  assert.deepEqual(p.set('me', { hidden: [] }).hidden, []);
  assert.deepEqual(p.set('me', { hidden: 'default/w1' }).hidden, [], 'not a list');
  assert.deepEqual(p.set('me', { hidden: [3] }).hidden, [], 'not text');
  assert.deepEqual(p.set('me', { hidden: ['x'.repeat(200)] }).hidden, [], 'too long');
});
