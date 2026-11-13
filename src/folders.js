// Where a new space's code lives: a folder already under the code root, a new
// repo made there, or a GitHub repo cloned there (listed with `gh`).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HerdrError } from './herdr.js';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
    else resolve(String(stdout));
  });
});

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class Folders {
  #cache = null;

  constructor({ root, extraRoots = [], cloneRoots = {}, exec = run, ttlMs = 60_000 }) {
    this.root = root;
    this.extraRoots = extraRoots;
    this.cloneRoots = cloneRoots;
    this.exec = exec;
    this.ttlMs = ttlMs;
  }

  // Every folder one level under the root (and the extra roots), newest first.
  list() {
    const roots = [this.root, ...this.extraRoots];
    const out = [];
    for (const r of roots) {
      let names = [];
      try { names = fs.readdirSync(r); } catch { continue; }
      for (const n of names) {
        const p = path.join(r, n);
        if (n.startsWith('.') || roots.includes(p) || !isDir(p)) continue;
        out.push({ name: path.relative(this.root, p), path: p, git: isDir(path.join(p, '.git')), mtime: fs.statSync(p).mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // Makes <root>/<slug of name> and runs git init in it.
  async create(name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new HerdrError('bad_folder', 'Give the new space a name.');
    const dir = path.join(this.root, slug);
    if (fs.existsSync(dir)) throw new HerdrError('bad_folder', `${dir} already exists. Pick it under Folder instead.`);
    fs.mkdirSync(dir, { recursive: true });
    await this.exec('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  destFor(full) {
    const [owner, name] = full.split('/');
    return path.join(this.cloneRoots[owner] || this.root, name);
  }

  // Repos the gh account can see (own, collaborator, orgs), most recently pushed first.
  async repos() {
    if (this.#cache && Date.now() - this.#cache.at < this.ttlMs) return this.#cache.repos;
    let out;
    try {
      out = await this.exec('gh', ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100']);
    } catch (e) {
      throw new HerdrError('gh_failed', `Couldn't list GitHub repos: ${(e.stderr || e.message).trim().split('\n')[0]}`);
    }
    const repos = JSON.parse(out).flat()
      .map(r => {
        const full = r.full_name;
        const dest = this.destFor(full);
        return { full, name: r.name, owner: r.owner?.login || '', description: r.description || '', private: !!r.private, pushedAt: r.pushed_at, local: isDir(dest) ? dest : null };
      })
      .sort((a, b) => Date.parse(b.pushedAt || 0) - Date.parse(a.pushedAt || 0));
    this.#cache = { at: Date.now(), repos };
    return repos;
  }

  // Clones owner/name into its folder; a git repo already there is used as is.
  async clone(full) {
    if (!REPO.test(full) || full.split('/').some(s => /^\.+$/.test(s))) throw new HerdrError('bad_repo', `Not a repo name: ${full}`);
    const dest = this.destFor(full);
    if (fs.existsSync(dest)) {
      if (isDir(path.join(dest, '.git'))) return dest;
      throw new HerdrError('bad_folder', `${dest} already exists and isn't a git repo.`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await this.exec('gh', ['repo', 'clone', full, dest]);
    } catch (e) {
      throw new HerdrError('clone_failed', `Clone failed: ${(e.stderr || e.message).trim().split('\n').at(-1)}`);
    }
    this.#cache = null;
    return dest;
  }
}
