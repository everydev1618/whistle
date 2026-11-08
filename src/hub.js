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
import { suggest, mergeSuggestions } from './suggest.js';
import { DEFAULT_VOCAB } from './vocab.js';
import { diffAgents } from './state.js';

const EMPTY = { lastPrompt: null, summary: null, live: null, steps: 0, files: 0, endedAt: null, question: null, suggestions: [] };

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const plain = s => s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

const FINISHED = new Set(['done', 'idle']);
const HANDOFF_MS = 60_000;

// `model` is the list of next steps from the model, if any have landed.
export function summarize(agent, transcript, question, { vocab = DEFAULT_VOCAB, model = null } = {}) {
  const rules = suggest({ status: agent.status, question, transcript, cwd: agent.cwd, vocab });
  const suggestions = model && !question ? mergeSuggestions(rules, model) : rules;
  const last = transcript?.turns?.at(-1);
  if (!last) return { ...EMPTY, question, suggestions };
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
    suggestions,
  };
}

export class Hub extends EventEmitter {
  #raw = new Map();     // id -> agent as herdr reports it
  #extra = new Map();   // id -> summary fields
  #tx = new Map();      // id -> { path, mtimeMs, transcript }
  #questions = new Map(); // id -> question parsed off the screen
  #sessions = [];
  #spaces = [];
  #polling = null;
  #timer = null;

  #handoff = new Map(); // id -> { sentAt, sawWorking } after sending a queued message

  constructor({ sessions, rpc = defaultRpc, claudeDir, intervalMs = 1500, vocab = DEFAULT_VOCAB, nextSteps = null, queue = null, recheckMs = 10_000, pauseMs = 300 }) {
    super();
    this.pauseMs = pauseMs;
    this.recheckMs = recheckMs;
    this.queue = queue;
    this.vocab = vocab;
    this.nextSteps = nextSteps;
    this.listSessions = sessions;
    this.rpc = rpc;
    this.claudeDir = claudeDir;
    this.intervalMs = intervalMs;
  }

  #merged(id) { return { ...this.#raw.get(id), ...(this.#extra.get(id) || EMPTY), queue: this.queue?.list(id) ?? [] }; }
  agents() { return [...this.#raw.keys()].map(id => this.#merged(id)); }
  sessions() { return this.#sessions; }
  spaces() { return this.#spaces; }

  poll() {
    // Never run two polls at once; a caller during a poll waits for that one.
    this.#polling ||= this.#pollOnce().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #pollOnce() {
    const { agents, sessions, spaces = [] } = await listAllAgents(this.listSessions(), this.rpc);
    const events = diffAgents(this.#raw, agents);
    this.#raw = new Map(agents.map(a => [a.id, a]));
    this.#sessions = sessions;
    if (JSON.stringify(spaces) !== JSON.stringify(this.#spaces)) {
      this.#spaces = spaces;
      this.emit('change', { type: 'spaces', spaces });
    }
    const moved = new Set(events.filter(e => e.agent).map(e => e.agent.id));
    for (const e of events) if (e.type === 'removed') { this.#extra.delete(e.id); this.#tx.delete(e.id); this.#questions.delete(e.id); }

    const enriched = await Promise.all(agents.map(a => this.#enrich(a, moved.has(a.id)).catch(() => false)));
    for (const e of events) this.emit('change', e.agent ? { ...e, agent: this.#merged(e.agent.id) } : e);
    agents.forEach((a, i) => {
      if (enriched[i] && !moved.has(a.id)) this.emit('change', { type: 'changed', agent: this.#merged(a.id), from: a.status });
    });
    if (this.queue) await this.#drain(agents, sessions);
  }

  // Sends the next queued message to each agent that has finished its turn. After a
  // send, waits until the agent has been seen working (or a minute has passed)
  // before sending another, so two messages never land in the same turn.
  async #drain(agents, sessions) {
    const running = new Set(sessions.filter(s => s.running).map(s => s.name));
    const live = new Set(agents.map(a => a.id));
    for (const id of this.queue.ids()) if (!running.has(id.split('/')[0])) live.add(id);
    for (const id of this.queue.prune(live)) console.error(`dropped queued messages for ${id}: agent is gone`);

    const now = Date.now();
    for (const a of agents) {
      const h = this.#handoff.get(a.id);
      if (a.status === 'working') { if (h) h.sawWorking = true; continue; }
      if (a.status !== 'done' && a.status !== 'idle') continue;
      const next = this.queue.list(a.id)[0];
      if (!next) { this.#handoff.delete(a.id); continue; }
      if (h && !h.sawWorking && now - h.sentAt < HANDOFF_MS) continue;
      try {
        await this.prompt(a.id, next.text);
        this.queue.remove(a.id, next.id);
        this.#handoff.set(a.id, { sentAt: now, sawWorking: false });
        this.emit('change', { type: 'changed', agent: this.#merged(a.id), from: a.status });
      } catch (e) {
        console.error(`could not send queued message to ${a.id}: ${e.message}`);
        this.#handoff.set(a.id, { sentAt: now, sawWorking: false }); // retry in a minute
      }
    }
  }

  enqueue(id, text) {
    if (!this.queue) throw new HerdrError('not_found', 'Queueing is not enabled.');
    if (!this.#raw.has(id)) throw new HerdrError('not_found', `No agent ${id}`);
    let item;
    try { item = this.queue.add(id, text); } catch (e) { throw new HerdrError('bad_queue', e.message); }
    this.emit('change', { type: 'changed', agent: this.#merged(id), from: this.#raw.get(id).status });
    return item;
  }

  unqueue(id, itemId) {
    if (!this.queue?.remove(id, itemId)) return false;
    if (this.#raw.has(id)) this.emit('change', { type: 'changed', agent: this.#merged(id), from: this.#raw.get(id).status });
    return true;
  }

  // Returns true when the summary fields changed.
  async #enrich(agent, statusMoved) {
    const socket = this.#socketFor(agent);
    let tx = this.#tx.get(agent.id);
    if (!tx || statusMoved || Date.now() - tx.checkedAt >= this.recheckMs) {
      // The pane may now host a different Claude session (e.g. after /clear, which
      // doesn't always change the status), so look again every so often.
      const info = await this.rpc(socket, 'pane.process_info', { pane_id: agent.paneId });
      const found = findTranscript({ processInfo: info.process_info, claudeDir: this.claudeDir });
      if (!tx || tx.path !== found?.path) tx = { path: found?.path ?? null, mtimeMs: -1, transcript: null };
      tx.checkedAt = Date.now();
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
    this.#questions.set(agent.id, question);
    return this.#summarize(agent.id);
  }

  // Recomputes the summary fields from what is cached; true when they changed.
  #summarize(id) {
    const agent = this.#raw.get(id);
    if (!agent) return false;
    const tx = this.#tx.get(id);
    const question = this.#questions.get(id) ?? null;
    const model = this.#modelSteps(agent, tx, question);
    const next = summarize(agent, tx?.transcript, question, { vocab: this.vocab, model });
    const prev = this.#extra.get(id);
    this.#extra.set(id, next);
    return JSON.stringify(prev) !== JSON.stringify(next);
  }

  #modelSteps(agent, tx, question) {
    const transcript = tx?.transcript;
    const turn = transcript?.turns?.at(-1);
    if (!this.nextSteps || question || !FINISHED.has(agent.status) || !turn?.answer) return null;
    const key = `${tx.path}#${transcript.totalTurns}#${turn.answer.length}`;
    const ctx = {
      project: agent.project,
      turn,
      existing: suggest({ status: agent.status, question, transcript, cwd: agent.cwd, vocab: this.vocab }),
      vocab: this.vocab,
    };
    return this.nextSteps.get(key, ctx, () => {
      const now = this.#raw.get(agent.id);
      if (now && this.#summarize(agent.id)) this.emit('change', { type: 'changed', agent: this.#merged(agent.id), from: now.status });
    });
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

  // Opens a tab in the space, in the folder its agents already work in, starts
  // Claude there and sends the first prompt. Returns the new agent's id.
  async newAgent(spaceId, { label = '', prompt = '' } = {}) {
    const space = this.#spaces.find(s => s.id === spaceId);
    if (!space) throw new HerdrError('not_found', `No space ${spaceId}`);
    const socket = this.#socketFor(space);
    const name = label.trim() || prompt.trim().split(/\s+/).slice(0, 4).join(' ') || 'agent';
    const { panes = [] } = await this.rpc(socket, 'pane.list', { workspace_id: space.workspaceId });
    const cwd = panes.find(p => p.agent)?.cwd || panes[0]?.cwd;
    const made = await this.rpc(socket, 'tab.create', { workspace_id: space.workspaceId, ...(cwd ? { cwd } : {}), label: name });
    const pane = made.root_pane.pane_id;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 24) || 'agent';
    const tab = made.tab.tab_id.split(':t')[1];
    await this.#startClaude(socket, `${slug}-t${tab}`, pane);
    if (prompt.trim()) await this.rpc(socket, 'agent.prompt', { target: pane, text: prompt.trim() });
    this.poll().catch(() => {});
    return { id: `${space.session}/${pane}` };
  }

  // herdr won't start an agent until the new tab's shell is at its prompt, and
  // agent.start returns before Claude is up, so wait on both (about 30s at most).
  async #startClaude(socket, name, pane) {
    const pause = () => new Promise(r => setTimeout(r, this.pauseMs));
    for (let i = 0; ; i++) {
      try { await this.rpc(socket, 'agent.start', { name, kind: 'claude', pane_id: pane, timeout_ms: 60_000 }); break; } catch (e) {
        if (e.code !== 'agent_pane_busy' || i >= 50) throw e;
        await pause();
      }
    }
    for (let i = 0; i < 100; i++) {
      const { agent } = await this.rpc(socket, 'agent.get', { target: pane }).catch(() => ({}));
      if (agent?.interactive_ready) return;
      if (agent?.agent_status === 'blocked') throw new HerdrError('agent_not_ready', 'Claude stopped on a question while starting.');
      await pause();
    }
    throw new HerdrError('agent_not_ready', 'Claude did not finish starting.');
  }

  async keys(id, keys) {
    const { agent, socket } = this.#target(id);
    await this.rpc(socket, 'agent.send_keys', { target: agent.paneId, keys });
  }
}
