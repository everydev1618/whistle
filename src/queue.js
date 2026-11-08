// Messages waiting for an agent to finish its turn. The hub sends the first one
// when the agent is free, then the next after the agent has picked that one up.
// Saved to disk so a restart doesn't lose them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TEXT = 20000;

export class Queue {
  #data; // { agentId: [{ id, text, at }] }

  constructor(file, { maxPerAgent = 10 } = {}) {
    this.file = file;
    this.maxPerAgent = maxPerAgent;
    try { this.#data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.#data = {}; }
    if (typeof this.#data !== 'object' || this.#data === null || Array.isArray(this.#data)) this.#data = {};
  }

  list(agentId) { return (this.#data[agentId] || []).map(i => ({ ...i })); }
  ids() { return Object.keys(this.#data); }

  add(agentId, text) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('message is empty');
    if (text.length > MAX_TEXT) throw new TypeError('message is too long');
    const items = this.#data[agentId] ||= [];
    if (items.length >= this.maxPerAgent) throw new TypeError('queue is full');
    const item = { id: crypto.randomBytes(6).toString('hex'), text, at: new Date().toISOString() };
    items.push(item);
    this.#save();
    return { ...item };
  }

  remove(agentId, itemId) {
    const items = this.#data[agentId] || [];
    const i = items.findIndex(x => x.id === itemId);
    if (i < 0) return false;
    items.splice(i, 1);
    this.#tidy(agentId);
    this.#save();
    return true;
  }

  shift(agentId) {
    const item = this.#data[agentId]?.shift() ?? null;
    this.#tidy(agentId);
    if (item) this.#save();
    return item;
  }

  // Drops the queues of agents that no longer exist; returns their ids.
  prune(liveIds) {
    const gone = this.ids().filter(id => !liveIds.has(id));
    for (const id of gone) delete this.#data[id];
    if (gone.length) this.#save();
    return gone;
  }

  #tidy(agentId) { if (this.#data[agentId] && !this.#data[agentId].length) delete this.#data[agentId]; }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data));
    fs.renameSync(tmp, this.file);
  }
}
