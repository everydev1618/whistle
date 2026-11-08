// Which agents a user has seen or marked done in whistle, per turn, so the
// home screen's Finished list can get to zero. Keyed by Tailscale login.
import fs from 'node:fs';
import path from 'node:path';

const KINDS = new Set(['seen', 'done', 'undone']);

export class Marks {
  #data;

  constructor(file, { maxPerUser = 500 } = {}) {
    this.file = file;
    this.maxPerUser = maxPerUser;
    try { this.#data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.#data = {}; }
    if (typeof this.#data !== 'object' || this.#data === null || Array.isArray(this.#data)) this.#data = {};
  }

  get(user) { return structuredClone(this.#data[user] || {}); }

  mark(user, id, kind, turn) {
    if (!KINDS.has(kind)) throw new TypeError(`unknown kind ${kind}`);
    if (typeof id !== 'string' || !id || id.length > 200) throw new TypeError('bad id');
    if (typeof turn !== 'string' || turn.length > 200) throw new TypeError('bad turn');
    const mine = this.#data[user] ||= {};
    const entry = { ...mine[id] };
    delete mine[id]; // re-insert so the most recently touched agents come last
    if (kind === 'undone') delete entry.done;
    else entry[kind] = turn;
    mine[id] = entry;
    const ids = Object.keys(mine);
    for (const old of ids.slice(0, Math.max(0, ids.length - this.maxPerUser))) delete mine[old];
    this.#save();
    return this.get(user);
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data));
    fs.renameSync(tmp, this.file);
  }
}
