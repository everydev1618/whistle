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
}

let hub, server, base;
before(async () => {
  hub = new FakeHub();
  server = createServer({ hub, allowedUsers: [] });
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
