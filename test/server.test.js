import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.js';
import { HerdrError } from '../src/herdr.js';

class FakeHub extends EventEmitter {
  sent = [];
  agents() { return [{ id: 'default/w1:p1', status: 'done', title: 'Slider' }]; }
  async detail(id) {
    if (id !== 'default/w1:p1') return null;
    return { agent: this.agents()[0], transcript: { title: 'Slider', turns: [], pending: null } };
  }
  async prompt(id, text) {
    if (text === 'blocked') throw new HerdrError('agent_blocked', 'agent is waiting on a question');
    this.sent.push(['prompt', id, text]);
  }
  async keys(id, keys) { this.sent.push(['keys', id, keys]); }
  enqueue(id, text) {
    if (id !== 'default/w1:p1') throw new HerdrError('not_found', 'no agent');
    if (!text.trim()) throw new HerdrError('bad_queue', 'message is empty');
    this.sent.push(['queue', id, text]);
    return { id: 'q1', text, at: 't' };
  }
  unqueue(id, itemId) { return id === 'default/w1:p1' && itemId === 'q1'; }
  spaces() { return [{ id: 'default/w1', label: 'proj' }]; }
  async newSpace(opts) {
    if (opts.cwd === '/nope') throw new HerdrError('bad_folder', 'no such folder');
    this.sent.push(['space', opts]);
    return { spaceId: 'default/w5', id: 'default/w5:p1' };
  }
  async closeSpace(spaceId) {
    if (spaceId !== 'default/w1') throw new HerdrError('not_found', 'no space');
    this.sent.push(['close', spaceId]);
  }
  async newAgent(spaceId, opts) {
    if (spaceId !== 'default/w1') throw new HerdrError('not_found', 'no space');
    if (opts.prompt === 'slow') throw new HerdrError('agent_not_ready', 'still starting');
    this.sent.push(['new', spaceId, opts]);
    return { id: 'default/w1:p9' };
  }
}

let hub, server, base;
before(async () => {
  hub = new FakeHub();
  server = createServer({ hub, allowedUsers: [], log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET /api/agents lists agents', async () => {
  const r = await fetch(base + '/api/agents');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).agents.map(a => a.id), ['default/w1:p1']);
});

test('GET /api/agents/:id returns the transcript, 404 for unknown', async () => {
  const r = await fetch(base + '/api/agents/' + encodeURIComponent('default/w1:p1'));
  assert.equal((await r.json()).transcript.title, 'Slider');
  assert.equal((await fetch(base + '/api/agents/' + encodeURIComponent('nope/w9:p9'))).status, 404);
});

test('POST prompt sends text to the agent', async () => {
  const r = await post('/api/agents/' + encodeURIComponent('default/w1:p1') + '/prompt', { text: 'push it' });
  assert.equal(r.status, 202);
  assert.deepEqual(hub.sent.at(-1), ['prompt', 'default/w1:p1', 'push it']);
});

test('POST prompt rejects empty text and maps a blocked agent to 409', async () => {
  assert.equal((await post('/api/agents/' + encodeURIComponent('default/w1:p1') + '/prompt', { text: '  ' })).status, 400);
  const r = await post('/api/agents/' + encodeURIComponent('default/w1:p1') + '/prompt', { text: 'blocked' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'agent_blocked');
});

test('POST keys sends key presses', async () => {
  const r = await post('/api/agents/' + encodeURIComponent('default/w1:p1') + '/keys', { keys: ['esc'] });
  assert.equal(r.status, 202);
  assert.deepEqual(hub.sent.at(-1), ['keys', 'default/w1:p1', ['esc']]);
});

test('GET /api/events streams a snapshot, then changes', async () => {
  const ctrl = new AbortController();
  const r = await fetch(base + '/api/events', { signal: ctrl.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const readUntil = async (s) => { while (!text.includes(s)) text += dec.decode((await reader.read()).value); };
  await readUntil('event: snapshot');
  hub.emit('change', { type: 'changed', agent: { id: 'default/w1:p1', status: 'working' }, from: 'done' });
  await readUntil('event: change');
  assert.match(text, /"status":"working"/);
  ctrl.abort();
});

test('only allowed tailnet users get in when a list is set', async () => {
  const locked = createServer({ hub, allowedUsers: ['etdebruin@github'] });
  await new Promise(r => locked.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${locked.address().port}/api/agents`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { 'tailscale-user-login': 'someone@else' } })).status, 403);
  assert.equal((await fetch(url, { headers: { 'tailscale-user-login': 'etdebruin@github' } })).status, 200);
  locked.close();
});

test('POST queue holds a message for later, DELETE cancels it', async () => {
  const p = '/api/agents/' + encodeURIComponent('default/w1:p1') + '/queue';
  let r = await post(p, { text: 'push it' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id: 'q1', text: 'push it', at: 't' });
  assert.deepEqual(hub.sent.at(-1), ['queue', 'default/w1:p1', 'push it']);
  assert.equal((await post(p, { text: ' ' })).status, 400);
  assert.equal((await post(p, { text: 5 })).status, 400);
  assert.equal((await post('/api/agents/' + encodeURIComponent('nope/w9:p9') + '/queue', { text: 'x' })).status, 404);
  assert.equal((await fetch(base + p + '/q1', { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + p + '/zz', { method: 'DELETE' })).status, 404);
});

test('app files tell browsers to check for a newer version every time', async () => {
  const r = await fetch(base + '/app.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
});

test('the app version is a fingerprint of the app files, and changes when one changes', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { appVersion } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-ver-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'one');
  fs.writeFileSync(path.join(dir, 'sub', 'x.css'), 'a');
  const v1 = appVersion(dir);
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(appVersion(dir), v1);
  fs.writeFileSync(path.join(dir, 'sub', 'x.css'), 'b');
  assert.notEqual(appVersion(dir), v1);
});

test('the event stream and agent list carry the app version', async () => {
  const r = await fetch(base + '/api/agents');
  assert.match((await r.json()).version, /^[0-9a-f]{12}$/);
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  const data = JSON.parse(text.split('\n').find(l => l.startsWith('data: ')).slice(6));
  assert.match(data.version, /^[0-9a-f]{12}$/);
});

test('every prompt, key press and queued message is logged with the agent and who sent it', async () => {
  const lines = [];
  const s = createServer({ hub, allowedUsers: [], log: l => lines.push(l) });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}/api/agents/` + encodeURIComponent('default/w1:p1');
  const h = { 'content-type': 'application/json', 'tailscale-user-login': 'me@x.com' };
  try {
    await fetch(b + '/prompt', { method: 'POST', headers: h, body: JSON.stringify({ text: '/clear' }) });
    await fetch(b + '/keys', { method: 'POST', headers: h, body: JSON.stringify({ keys: ['esc'] }) });
    await fetch(b + '/queue', { method: 'POST', headers: h, body: JSON.stringify({ text: 'push it' }) });
  } finally { s.close(); }
  assert.deepEqual(lines, [
    'me@x.com → default/w1:p1 prompt "/clear"',
    'me@x.com → default/w1:p1 keys esc',
    'me@x.com → default/w1:p1 queue "push it"',
  ]);
});

test('POST /api/uploads saves an image and returns its path on this Mac', async () => {
  const saved = [];
  const uploads = { save: (buf, type) => { if (type === 'image/heic') throw new HerdrError('bad_image', 'no heic'); saved.push([buf.toString(), type]); return '/state/uploads/s.png'; } };
  const s = createServer({ hub, allowedUsers: [], uploads, log: () => {} });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/uploads`;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'img' });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { path: '/state/uploads/s.png' });
    assert.deepEqual(saved, [['img', 'image/png']]);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'image/heic' }, body: 'x' })).status, 400);
  } finally { s.close(); }
});

test('the agent list and event stream carry the spaces', async () => {
  assert.deepEqual((await (await fetch(base + '/api/agents')).json()).spaces, [{ id: 'default/w1', label: 'proj' }]);
});

test('POST /api/spaces/:id/agents starts a new agent in that space', async () => {
  const p = '/api/spaces/' + encodeURIComponent('default/w1') + '/agents';
  const r = await post(p, { label: 'Pricing', prompt: 'go' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id: 'default/w1:p9' });
  assert.deepEqual(hub.sent.at(-1), ['new', 'default/w1', { label: 'Pricing', prompt: 'go' }]);
  assert.equal((await post(p, { label: 5 })).status, 400);
  assert.equal((await post('/api/spaces/' + encodeURIComponent('default/w7') + '/agents', {})).status, 404);
  assert.equal((await post(p, { prompt: 'slow' })).status, 409);
});

test('POST /api/spaces makes a new space', async () => {
  const r = await post('/api/spaces', { session: 'default', label: 'Pricing', cwd: '/code/x', prompt: 'go' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { spaceId: 'default/w5', id: 'default/w5:p1' });
  assert.deepEqual(hub.sent.at(-1), ['space', { session: 'default', label: 'Pricing', cwd: '/code/x', prompt: 'go' }]);
  assert.equal((await post('/api/spaces', { cwd: 5 })).status, 400);
  assert.equal((await post('/api/spaces', { cwd: '/nope' })).status, 400);
});

test('DELETE /api/spaces/:id closes the space', async () => {
  const del = id => fetch(base + '/api/spaces/' + encodeURIComponent(id), { method: 'DELETE' });
  assert.equal((await del('default/w1')).status, 200);
  assert.deepEqual(hub.sent.at(-1), ['close', 'default/w1']);
  assert.equal((await del('default/w7')).status, 404);
});
