// Keeps the live picture of every herdr agent and routes phone actions to the
// right herdr session. Emits 'change' events for the event stream.
//
// Each poll lists agents on every session, then enriches each one from its
// Claude transcript (re-parsed only when the file changes) and, when blocked,
// from the question on its screen.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { rpc as defaultRpc, listAllAgents, HerdrError } from './herdr.js';
import { findTranscript, readEntries } from './claude.js';
import { parseTranscript } from './transcript.js';
import { parseQuestionScreen } from './screen.js';
import { suggest } from './suggest.js';
import { diffAgents } from './state.js';

const EMPTY = { lastPrompt: null, summary: null, live: null, steps: 0, files: 0, endedAt: null, question: null, suggestions: [] };

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const plain = s => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

export function summarize(agent, transcript, question) {
  const last = transcript?.turns?.at(-1);
  if (!last) return { ...EMPTY, question, suggestions: suggest({ status: agent.status, question, transcript }) };
  const lastPara = last.answer.split(/\n\s*\n/).at(-1) || '';
  const running = [...last.steps].reverse().find(s => s.ok === null) || last.steps.at(-1);
  return {
    lastPrompt: clip(plain(last.prompt), 140),
    summary: lastPara ? clip(plain(lastPara), 220) : null,
    live: agent.status === 'working' && running ? running.label : null,
    steps: last.steps.length,
    files: Object.keys(last.files).length,
    endedAt: last.endedAt ?? null,
    question,
    suggestions: suggest({ status: agent.status, question, transcript }),
  };
}

export class Hub extends EventEmitter {
  #raw = new Map();     // id -> agent as herdr reports it
  #extra = new Map();   // id -> summary fields
  #tx = new Map();      // id -> { path, mtimeMs, transcript }
  #sessions = [];
  #polling = null;
  #timer = null;

  constructor({ sessions, rpc = defaultRpc, claudeDir, intervalMs = 1500 }) {
    super();
    this.listSessions = sessions;
    this.rpc = rpc;
    this.claudeDir = claudeDir;
    this.intervalMs = intervalMs;
  }

  #merged(id) { return { ...this.#raw.get(id), ...(this.#extra.get(id) || EMPTY) }; }
  agents() { return [...this.#raw.keys()].map(id => this.#merged(id)); }
  sessions() { return this.#sessions; }

  poll() {
    // Never run two polls at once; a caller during a poll waits for that one.
    this.#polling ||= this.#pollOnce().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #pollOnce() {
    const { agents, sessions } = await listAllAgents(this.listSessions(), this.rpc);
    const events = diffAgents(this.#raw, agents);
    this.#raw = new Map(agents.map(a => [a.id, a]));
    this.#sessions = sessions;
    const moved = new Set(events.filter(e => e.agent).map(e => e.agent.id));
    for (const e of events) if (e.type === 'removed') { this.#extra.delete(e.id); this.#tx.delete(e.id); }

    const enriched = await Promise.all(agents.map(a => this.#enrich(a, moved.has(a.id)).catch(() => false)));
    for (const e of events) this.emit('change', e.agent ? { ...e, agent: this.#merged(e.agent.id) } : e);
    agents.forEach((a, i) => {
      if (enriched[i] && !moved.has(a.id)) this.emit('change', { type: 'changed', agent: this.#merged(a.id), from: a.status });
    });
  }

  // Returns true when the summary fields changed.
  async #enrich(agent, statusMoved) {
    const socket = this.#socketFor(agent);
    let tx = this.#tx.get(agent.id);
    if (!tx || statusMoved) {
      // The pane may now host a different Claude session (e.g. after /clear).
      const info = await this.rpc(socket, 'pane.process_info', { pane_id: agent.paneId });
      const found = findTranscript({ processInfo: info.process_info, claudeDir: this.claudeDir });
      if (!tx || tx.path !== found?.path) tx = { path: found?.path ?? null, mtimeMs: -1, transcript: null };
      this.#tx.set(agent.id, tx);
    }
    if (tx.path) {
      const { mtimeMs } = fs.statSync(tx.path);
      if (mtimeMs !== tx.mtimeMs) { tx.transcript = parseTranscript(readEntries(tx.path)); tx.mtimeMs = mtimeMs; }
    }
    let question = null;
    if (agent.status === 'blocked') {
      const r = await this.rpc(socket, 'agent.read', { target: agent.paneId, source: 'visible' });
      question = parseQuestionScreen(r.read?.text ?? r.text ?? '');
    }
    const next = summarize(agent, tx.transcript, question);
    const prev = this.#extra.get(agent.id);
    this.#extra.set(agent.id, next);
    return JSON.stringify(prev) !== JSON.stringify(next);
  }

  start() {
    const tick = () => this.poll().catch(e => console.error('poll failed:', e.message)).finally(() => {
      this.#timer = setTimeout(tick, this.intervalMs);
    });
    tick();
  }

  stop() { clearTimeout(this.#timer); }

  #socketFor(agent) {
    const session = this.listSessions().find(s => s.name === agent.session);
    if (!session) throw new HerdrError('unreachable', `herdr session ${agent.session} is gone`);
    return session.socket;
  }

  #target(id) {
    const agent = this.#raw.get(id);
    if (!agent) throw new HerdrError('not_found', `No agent ${id}`);
    return { agent, socket: this.#socketFor(agent) };
  }

  async detail(id) {
    if (!this.#raw.has(id)) return null;
    const { agent, socket } = this.#target(id);
    const info = await this.rpc(socket, 'pane.process_info', { pane_id: agent.paneId });
    const found = findTranscript({ processInfo: info.process_info, claudeDir: this.claudeDir });
    const transcript = found ? parseTranscript(readEntries(found.path)) : null;
    return { agent: this.#merged(id), sessionId: found?.sessionId ?? null, transcript };
  }

  async prompt(id, text) {
    const { agent, socket } = this.#target(id);
    await this.rpc(socket, 'agent.prompt', { target: agent.paneId, text });
  }

  async keys(id, keys) {
    const { agent, socket } = this.#target(id);
    await this.rpc(socket, 'agent.send_keys', { target: agent.paneId, keys });
  }
}
