// Talks to herdr's socket API. Each connection carries one JSON request and
// one JSON reply, then herdr closes it.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let seq = 0;

export function rpc(socket, method, params = {}, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `whistle:${++seq}`;
    const conn = net.connect(socket);
    let buf = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); conn.destroy(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`)), timeoutMs);

    conn.on('connect', () => conn.write(JSON.stringify({ id, method, params }) + '\n'));
    conn.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) parse(buf.slice(0, nl));
    });
    conn.on('end', () => { if (buf.trim()) parse(buf); else finish(reject, new HerdrError('empty_reply', `${method}: herdr closed without a reply`)); });
    conn.on('error', e => finish(reject, new HerdrError('unreachable', `${socket}: ${e.message}`)));

    function parse(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { return finish(reject, new HerdrError('bad_reply', `${method}: unreadable reply`)); }
      if (msg.error) finish(reject, new HerdrError(msg.error.code || 'herdr_error', msg.error.message || 'herdr error'));
      else finish(resolve, msg.result);
    }
  });
}

// The default session lives at <dir>/herdr.sock, named ones at <dir>/sessions/<name>/herdr.sock.
export function findSessions(configDir) {
  const out = [];
  const def = path.join(configDir, 'herdr.sock');
  if (fs.existsSync(def)) out.push({ name: 'default', socket: def });
  const dir = path.join(configDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { /* no named sessions */ }
  for (const name of names) {
    const sock = path.join(dir, name, 'herdr.sock');
    if (fs.existsSync(sock)) out.push({ name, socket: sock });
  }
  return out;
}

export function toAgent(session, a) {
  return {
    id: `${session}/${a.pane_id}`,
    session,
    paneId: a.pane_id,
    workspaceId: a.workspace_id,
    spaceId: `${session}/${a.workspace_id}`,
    tabId: a.tab_id,
    agent: a.agent,
    status: a.agent_status,
    title: a.terminal_title_stripped || a.terminal_title || '',
    cwd: a.cwd,
    project: (a.cwd || '').split('/').filter(Boolean).pop() || '',
    stateSeq: a.state_change_seq,
  };
}

// A herdr workspace, which the phone calls a space.
export function toSpace(session, w) {
  return { id: `${session}/${w.workspace_id}`, session, workspaceId: w.workspace_id, label: w.label || w.workspace_id, number: w.number ?? 0, tabs: w.tab_count ?? 0 };
}

export async function listAllAgents(sessions, call = rpc) {
  const results = await Promise.all(sessions.map(async s => {
    try {
      const [r, w] = await Promise.all([
        call(s.socket, 'agent.list', {}, { timeoutMs: 3000 }),
        call(s.socket, 'workspace.list', {}, { timeoutMs: 3000 }),
      ]);
      const spaces = (w.workspaces || []).map(x => toSpace(s.name, x)).sort((a, b) => a.number - b.number);
      return { name: s.name, running: true, agents: (r.agents || []).map(a => toAgent(s.name, a)), spaces };
    } catch {
      return { name: s.name, running: false, agents: [], spaces: [] };
    }
  }));
  return {
    agents: results.flatMap(r => r.agents),
    spaces: results.flatMap(r => r.spaces),
    sessions: results.map(({ name, running }) => ({ name, running })),
  };
}
