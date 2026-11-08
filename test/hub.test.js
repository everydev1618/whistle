import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { HerdrError } from '../src/herdr.js';

const sessions = [{ name: 'default', socket: 'd.sock' }, { name: 'work', socket: 'w.sock' }];

function fakeRpc(state) {
  const calls = [];
  const fn = async (socket, method, params) => {
    calls.push([socket, method, params]);
    if (method === 'agent.list') return { agents: state[socket] || [] };
    if (method === 'pane.process_info') return { process_info: { foreground_processes: [{ pid: 7, argv0: 'claude', argv: ['claude'] }] } };
    if (method === 'agent.prompt' || method === 'agent.send_keys') return { ok: true };
    throw new HerdrError('not_found', method);
  };
  fn.calls = calls;
  return fn;
}
const raw = (pane, status) => ({ pane_id: pane, workspace_id: pane.split(':')[0], agent: 'claude', agent_status: status, terminal_title_stripped: 'T', cwd: '/x/proj' });

test('poll emits changes between polls', async () => {
  const state = { 'd.sock': [raw('w1:p1', 'working')] };
  const hub = new Hub({ sessions: () => sessions, rpc: fakeRpc(state), claudeDir: '/nowhere' });
  const events = [];
  hub.on('change', e => events.push(e));
  await hub.poll();
  assert.deepEqual(events.map(e => [e.type, e.agent.id]), [['added', 'default/w1:p1']]);
  state['d.sock'] = [raw('w1:p1', 'done')];
  await hub.poll();
  assert.deepEqual(events.at(-1), { type: 'changed', agent: hub.agents()[0], from: 'working' });
  assert.deepEqual(hub.sessions(), [{ name: 'default', running: true }, { name: 'work', running: true }]);
});

test('prompt and keys go to the socket of the agent\'s own session, targeting its pane', async () => {
  const rpc = fakeRpc({ 'w.sock': [raw('w2:p3', 'idle')] });
  const hub = new Hub({ sessions: () => sessions, rpc, claudeDir: '/nowhere' });
  await hub.poll();
  await hub.prompt('work/w2:p3', 'push it');
  await hub.keys('work/w2:p3', ['esc']);
  assert.deepEqual(rpc.calls.filter(c => c[1].startsWith('agent.') && c[1] !== 'agent.list'), [
    ['w.sock', 'agent.prompt', { target: 'w2:p3', text: 'push it' }],
    ['w.sock', 'agent.send_keys', { target: 'w2:p3', keys: ['esc'] }],
  ]);
  await assert.rejects(hub.prompt('nope/w9:p9', 'x'), e => e.code === 'not_found');
});

test('detail reads the pane\'s transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hub-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects', '-x-proj'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', '7.json'), JSON.stringify({ sessionId: 's1', cwd: '/x/proj' }));
  fs.writeFileSync(path.join(dir, 'projects', '-x-proj', 's1.jsonl'), [
    { type: 'ai-title', aiTitle: 'Slider' },
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const hub = new Hub({ sessions: () => sessions, rpc: fakeRpc({ 'd.sock': [raw('w1:p1', 'done')] }), claudeDir: dir });
  await hub.poll();
  const d = await hub.detail('default/w1:p1');
  assert.equal(d.agent.id, 'default/w1:p1');
  assert.equal(d.transcript.title, 'Slider');
  assert.equal(d.transcript.turns[0].answer, 'done');
  assert.equal(await hub.detail('default/w9:p9'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
