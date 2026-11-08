// Small per-user settings (which session filter is selected), kept on the server
// so they are the same in a Safari tab, the home-screen app and on every device.
// Users are keyed by their Tailscale login.
import fs from 'node:fs';
import path from 'node:path';

const VALID = { filter: v => typeof v === 'string' && v.length > 0 && v.length <= 64 };

export class Prefs {
  #data;

  constructor(file) {
    this.file = file;
    try { this.#data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.#data = {}; }
    if (typeof this.#data !== 'object' || this.#data === null || Array.isArray(this.#data)) this.#data = {};
  }

  get(user) { return { ...(this.#data[user] || {}) }; }

  set(user, patch) {
    const next = this.get(user);
    for (const [k, ok] of Object.entries(VALID)) if (k in (patch || {}) && ok(patch[k])) next[k] = patch[k];
    this.#data[user] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get(user);
  }
}
