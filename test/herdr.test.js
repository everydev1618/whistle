import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rpc, findSessions, listAllAgents, HerdrError } from '../src/herdr.js';
import { findTranscript, findClaudeDirs } from '../src/claude.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake herdr server: one JSON request per connection, one reply, then close.
function fakeHerdr(sock, handler) {
  const srv = net.createServer(c => {
    let buf = '';
    c.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      c.end(JSON.stringify({ id: req.id, ...handler(req) }) + '\n');
    });
  });
  return new Promise(r => srv.listen(sock, () => r(srv)));
}

test('rpc sends one request and returns its result', async () => {
  const sock = path.join(tmp, 'a.sock');
  let seen;
  const srv = await fakeHerdr(sock, req => { seen = req; return { result: { type: 'pong' } }; });
  const res = await rpc(sock, 'ping', {});
  assert.deepEqual(res, { type: 'pong' });
  assert.equal(seen.method, 'ping');
  assert.deepEqual(seen.params, {});
  srv.close();
});

test('rpc turns herdr errors into HerdrError with the code', async () => {
  const sock = path.join(tmp, 'b.sock');
  const srv = await fakeHerdr(sock, () => ({ error: { code: 'agent_blocked', message: 'agent is blocked' } }));
  await assert.rejects(rpc(sock, 'agent.prompt', { target: 'x', text: 'y' }), e => e instanceof HerdrError && e.code === 'agent_blocked');
  srv.close();
});

test('rpc fails fast when nothing listens on the socket', async () => {
  await assert.rejects(rpc(path.join(tmp, 'nobody.sock'), 'ping', {}), e => e.code === 'unreachable');
});

test('findSessions lists the default session and named sessions that have a socket', () => {
  const dir = path.join(tmp, 'cfg');
  fs.mkdirSync(path.join(dir, 'sessions', 'Acme'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'herdr.sock'), '');
  fs.writeFileSync(path.join(dir, 'sessions', 'Acme', 'herdr.sock'), '');
  assert.deepEqual(findSessions(dir), [
    { name: 'default', socket: path.join(dir, 'herdr.sock') },
    { name: 'Acme', socket: path.join(dir, 'sessions', 'Acme', 'herdr.sock') },
  ]);
});

test('listAllAgents merges agents and spaces from every running session and skips dead ones', async () => {
  const sessions = [{ name: 'default', socket: 'd' }, { name: 'gone', socket: 'g' }, { name: 'work', socket: 'w' }];
  const fakeRpc = async (sock, method) => {
    if (sock === 'g') throw new HerdrError('unreachable', 'no server');
    const pane = sock === 'd' ? 'w1:p1' : 'w2:p3';
    if (method === 'workspace.list') {
      return { workspaces: [
        { workspace_id: 'w9', label: 'later', number: 2, agent_status: 'idle', tab_count: 1, pane_count: 1 },
        { workspace_id: pane.split(':')[0], label: 'proj ' + sock, number: 1, agent_status: 'done', tab_count: 3, pane_count: 4 },
      ] };
    }
    return { agents: [{ pane_id: pane, agent: 'claude', agent_status: 'done', terminal_title_stripped: 'T ' + sock, cwd: '/Users/me/Code/proj', workspace_id: pane.split(':')[0] }] };
  };
  const { agents, sessions: status, spaces } = await listAllAgents(sessions, fakeRpc);
  assert.deepEqual(agents.map(a => [a.id, a.session, a.paneId, a.status, a.title, a.project, a.spaceId]), [
    ['default/w1:p1', 'default', 'w1:p1', 'done', 'T d', 'proj', 'default/w1'],
    ['work/w2:p3', 'work', 'w2:p3', 'done', 'T w', 'proj', 'work/w2'],
  ]);
  assert.deepEqual(status, [{ name: 'default', running: true }, { name: 'gone', running: false }, { name: 'work', running: true }]);
  assert.deepEqual(spaces.map(s => [s.id, s.session, s.workspaceId, s.label, s.number, s.tabs]), [
    ['default/w1', 'default', 'w1', 'proj d', 1, 3],
    ['default/w9', 'default', 'w9', 'later', 2, 1],
    ['work/w2', 'work', 'w2', 'proj w', 1, 3],
    ['work/w9', 'work', 'w9', 'later', 2, 1],
  ]);
});

test('findTranscript follows pane process -> claude pid -> session file -> transcript', () => {
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects', '-Users-me-Code-shop'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'sessions', '41012.json'), JSON.stringify({ pid: 41012, sessionId: 'abc-123', cwd: '/Users/me/Code/shop' }));
  const file = path.join(claudeDir, 'projects', '-Users-me-Code-shop', 'abc-123.jsonl');
  fs.writeFileSync(file, '');
  const processInfo = { foreground_processes: [
    { pid: 41036, argv0: 'node', argv: ['node', '/opt/homebrew/bin/playwright-mcp'] },
    { pid: 41012, argv0: 'claude', argv: ['claude', '--dangerously-skip-permissions'] },
  ] };
  assert.deepEqual(findTranscript({ processInfo, claudeDir }), { pid: 41012, sessionId: 'abc-123', path: file });
  assert.equal(findTranscript({ processInfo: { foreground_processes: [{ pid: 1, argv0: 'zsh', argv: ['zsh'] }] }, claudeDir }), null);
});

test('findTranscript searches several Claude config folders for the pid', () => {
  const dirA = path.join(tmp, 'claude-a');
  const dirB = path.join(tmp, 'claude-b');
  fs.mkdirSync(path.join(dirA, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dirB, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dirB, 'projects', '-p'), { recursive: true });
  fs.writeFileSync(path.join(dirB, 'sessions', '99.json'), JSON.stringify({ sessionId: 's9', cwd: '/p' }));
  fs.writeFileSync(path.join(dirB, 'projects', '-p', 's9.jsonl'), '');
  const processInfo = { foreground_processes: [{ pid: 99, argv0: 'claude', argv: ['claude'] }] };
  assert.equal(findTranscript({ processInfo, claudeDir: [dirA, dirB] }).path, path.join(dirB, 'projects', '-p', 's9.jsonl'));
});

test('findClaudeDirs finds ~/.claude and ~/.claude-* folders, not files', () => {
  const home = path.join(tmp, 'home');
  for (const d of ['.claude', '.claude-acme', '.claude-work', '.config']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  assert.deepEqual(findClaudeDirs(home), ['.claude', '.claude-acme', '.claude-work'].map(d => path.join(home, d)));
});
