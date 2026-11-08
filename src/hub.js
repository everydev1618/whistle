// Keeps the live picture of every herdr agent and routes phone actions to the
// right herdr session. Emits 'change' events for the event stream.
import { EventEmitter } from 'node:events';
import { rpc as defaultRpc, listAllAgents, HerdrError } from './herdr.js';
import { findTranscript, readEntries } from './claude.js';
import { parseTranscript } from './transcript.js';
import { diffAgents } from './state.js';

export class Hub extends EventEmitter {
  #byId = new Map();
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

  agents() { return [...this.#byId.values()]; }
  sessions() { return this.#sessions; }

  poll() {
    // Never run two polls at once; a caller during a poll waits for that one.
    this.#polling ||= (async () => {
      try {
        const { agents, sessions } = await listAllAgents(this.listSessions(), this.rpc);
        const events = diffAgents(this.#byId, agents);
        this.#byId = new Map(agents.map(a => [a.id, a]));
        this.#sessions = sessions;
        for (const e of events) this.emit('change', e);
      } finally {
        this.#polling = null;
      }
    })();
    return this.#polling;
  }

  start() {
    const tick = () => this.poll().catch(e => console.error('poll failed:', e.message)).finally(() => {
      this.#timer = setTimeout(tick, this.intervalMs);
    });
    tick();
  }

  stop() { clearTimeout(this.#timer); }

  #target(id) {
    const agent = this.#byId.get(id);
    if (!agent) throw new HerdrError('not_found', `No agent ${id}`);
    const session = this.listSessions().find(s => s.name === agent.session);
    if (!session) throw new HerdrError('unreachable', `herdr session ${agent.session} is gone`);
    return { agent, socket: session.socket };
  }

  async detail(id) {
    if (!this.#byId.has(id)) return null;
    const { agent, socket } = this.#target(id);
    const info = await this.rpc(socket, 'pane.process_info', { pane_id: agent.paneId });
    const found = findTranscript({ processInfo: info.process_info, claudeDir: this.claudeDir });
    const transcript = found ? parseTranscript(readEntries(found.path)) : null;
    return { agent, sessionId: found?.sessionId ?? null, transcript };
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
