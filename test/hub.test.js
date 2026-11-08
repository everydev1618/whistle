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
    if (method === 'agent.read') return { read: { text: fn.screen || '' } };
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

test('agents carry a summary, the live step and buttons from their transcript, and a question when blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hub-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects', '-x-proj'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', '7.json'), JSON.stringify({ sessionId: 's1', cwd: '/x/proj' }));
  const file = path.join(dir, 'projects', '-x-proj', 's1.jsonl');
  const write = entries => fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  write([
    { type: 'user', message: { content: 'make a slider' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm run build' } }] } },
  ]);
  const state = { 'd.sock': [raw('w1:p1', 'working')] };
  const rpc = fakeRpc(state);
  const hub = new Hub({ sessions: () => sessions, rpc, claudeDir: dir });
  const events = [];
  hub.on('change', e => events.push(e));
  await hub.poll();
  let [a] = hub.agents();
  assert.equal(a.live, 'Ran npm run build');
  assert.equal(a.lastPrompt, 'make a slider');

  write([
    { type: 'user', message: { content: 'make a slider' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm run build' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Slider works.\n\nWant me to push?' }] } },
  ]);
  state['d.sock'] = [raw('w1:p1', 'done')];
  await hub.poll();
  [a] = hub.agents();
  assert.equal(a.summary, 'Want me to push?');
  assert.equal(a.live, null);
  assert.deepEqual(a.suggestions.map(s => s.label), ['Yes, push', 'No']);
  assert.equal(events.at(-1).agent.summary, 'Want me to push?');

  const screen = fs.readFileSync(new URL('./fixtures/question-screen.txt', import.meta.url), 'utf8');
  rpc.screen = screen;
  state['d.sock'] = [raw('w1:p1', 'blocked')];
  await hub.poll();
  [a] = hub.agents();
  assert.equal(a.question.question, 'Which color?');
  assert.deepEqual(a.suggestions.map(s => s.keys), [['1'], ['2'], ['3']]);
  fs.rmSync(dir, { recursive: true, force: true });
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

test('finished agents get next steps from the model, merged after the rule buttons once they land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hub-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects', '-x-proj'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', '7.json'), JSON.stringify({ sessionId: 's1', cwd: '/x/proj' }));
  fs.writeFileSync(path.join(dir, 'projects', '-x-proj', 's1.jsonl'), [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done. Does it look right?' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const asked = [];
  let land;
  const nextSteps = {
    get(key, ctx, onReady) {
      asked.push({ key, ctx });
      if (!land) { land = onReady; return null; }
      return [{ label: 'Add tests', text: 'add tests' }];
    },
  };
  const state = { 'd.sock': [raw('w1:p1', 'working')] };
  const hub = new Hub({ sessions: () => sessions, rpc: fakeRpc(state), claudeDir: dir, nextSteps, vocab: { push: 'push it', deploy: 'deploy', deployByProject: {}, examples: ['yes'] } });
  const events = [];
  hub.on('change', e => events.push(e));
  await hub.poll();
  assert.equal(asked.length, 0, 'not while working');

  state['d.sock'] = [raw('w1:p1', 'done')];
  await hub.poll();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].ctx.turn.answer, 'Done. Does it look right?');
  assert.deepEqual(asked[0].ctx.existing.map(s => s.text), ['yes', 'no']);
  assert.deepEqual(asked[0].ctx.vocab.examples, ['yes']);
  assert.equal(asked[0].ctx.project, 'proj');
  assert.deepEqual(hub.agents()[0].suggestions.map(s => s.label), ['Yes', 'No']);

  land();
  assert.deepEqual(hub.agents()[0].suggestions.map(s => s.label), ['Yes', 'No', 'Add tests']);
  assert.deepEqual(events.at(-1).agent.suggestions.map(s => s.label), ['Yes', 'No', 'Add tests']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summaries read as plain text, without markdown list markers', async () => {
  const { summarize } = await import('../src/hub.js');
  const t = { turns: [{ prompt: 'p', steps: [], answer: 'Intro.\n\n- This week: 15 hours.\n- Vidya has not approved.', files: {} }] };
  assert.equal(summarize({ status: 'done' }, t, null).summary, 'This week: 15 hours. Vidya has not approved.');
});

test('a queued message waits while working and is sent when the turn ends, one per turn', async () => {
  const { Queue } = await import('../src/queue.js');
  const queue = new Queue(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hq-')), 'q.json'));
  const state = { 'd.sock': [raw('w1:p1', 'working')] };
  const rpc = fakeRpc(state);
  const hub = new Hub({ sessions: () => sessions, rpc, claudeDir: '/nowhere', queue });
  const events = [];
  hub.on('change', e => events.push(e));
  await hub.poll();
  hub.enqueue('default/w1:p1', 'push it');
  hub.enqueue('default/w1:p1', 'then deploy');
  assert.deepEqual(hub.agents()[0].queue.map(i => i.text), ['push it', 'then deploy']);
  assert.deepEqual(events.at(-1).agent.queue.map(i => i.text), ['push it', 'then deploy']);
  const prompts = () => rpc.calls.filter(c => c[1] === 'agent.prompt').map(c => c[2].text);

  await hub.poll();
  assert.deepEqual(prompts(), [], 'not while working');

  state['d.sock'] = [raw('w1:p1', 'done')];
  await hub.poll();
  assert.deepEqual(prompts(), ['push it']);
  assert.deepEqual(hub.agents()[0].queue.map(i => i.text), ['then deploy']);

  await hub.poll();
  assert.deepEqual(prompts(), ['push it'], 'waits for the agent to pick it up before sending the next');

  state['d.sock'] = [raw('w1:p1', 'working')];
  await hub.poll();
  state['d.sock'] = [raw('w1:p1', 'idle')];
  await hub.poll();
  assert.deepEqual(prompts(), ['push it', 'then deploy']);
  assert.deepEqual(hub.agents()[0].queue, []);
});

test('queued messages wait while the agent asks a question, can be cancelled, and need a known agent', async () => {
  const { Queue } = await import('../src/queue.js');
  const queue = new Queue(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hq-')), 'q.json'));
  const state = { 'd.sock': [raw('w1:p1', 'blocked')] };
  const rpc = fakeRpc(state);
  const hub = new Hub({ sessions: () => sessions, rpc, claudeDir: '/nowhere', queue });
  await hub.poll();
  const item = hub.enqueue('default/w1:p1', 'push it');
  await hub.poll();
  assert.equal(rpc.calls.filter(c => c[1] === 'agent.prompt').length, 0);
  assert.equal(hub.unqueue('default/w1:p1', item.id), true);
  assert.deepEqual(hub.agents()[0].queue, []);
  assert.throws(() => hub.enqueue('nope/w9:p9', 'x'), e => e.code === 'not_found');
});

test('picks up a new transcript after /clear even when the status does not change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-hub-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects', '-x-proj'), { recursive: true });
  const session = id => fs.writeFileSync(path.join(dir, 'sessions', '7.json'), JSON.stringify({ sessionId: id, cwd: '/x/proj' }));
  const transcript = (id, entries) => fs.writeFileSync(path.join(dir, 'projects', '-x-proj', `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  session('s1');
  transcript('s1', [{ type: 'user', message: { content: 'old work' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }]);
  const state = { 'd.sock': [raw('w1:p1', 'idle')] };
  const hub = new Hub({ sessions: () => sessions, rpc: fakeRpc(state), claudeDir: dir, recheckMs: 0 });
  await hub.poll();
  assert.equal(hub.agents()[0].lastPrompt, 'old work');
  session('s2');
  transcript('s2', [{ type: 'user', message: { content: '<command-name>/clear</command-name>' } }]);
  await hub.poll();
  assert.equal(hub.agents()[0].lastPrompt, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
