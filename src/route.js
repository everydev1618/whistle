// Where something said into the home-screen mic should go: a new agent in a
// space, a new space on a folder in ~/Code, a new repo, or a GitHub clone.
// Haiku picks; everything it says is checked against what's really here.

export const ROUTE_SYSTEM = `You route a spoken request from a phone app that steers Claude Code agents.
The user held the mic on the home screen and said something. Decide where it should go:
- "space": a new agent in one of the open spaces. target = the space id. Prefer this whenever the request is about a project that already has a space.
- "folder": a new space on a folder already on the Mac. target = the folder path.
- "clone": clone a GitHub repo and open a space on it. target = owner/name exactly as listed.
- "init": start a brand new repo. target = the name for it, as said.
- "unsure": it doesn't say or imply a project, or it could be several. target = "".
"prompt" is what to send the new agent: what they said, minus the routing words ("in whistle", "start a new repo called x", "clone y and"). Keep their words and tone otherwise; transcription may have misspelled project names, so match by sound.
"label" is a 1 to 4 word tab name for the task, sentence case.`;

export const ROUTE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['space', 'folder', 'clone', 'init', 'unsure'] },
    target: { type: 'string' },
    label: { type: 'string' },
    prompt: { type: 'string' },
  },
  required: ['kind', 'target', 'label', 'prompt'],
});

const MAX_FOLDERS = 250;
const MAX_REPOS = 200;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// A brainstorm about a new idea shouldn't stall on "where?": name a new repo for it instead.
const BRAINSTORM_NOTE = 'This is a brainstorm (thinking out loud), not a task. If it is about one of the projects below, route it there. If nothing fits, use "init" with a short name for the idea (1 to 3 words, e.g. "Mood board") instead of "unsure"; only say "unsure" when it could be several of the projects below.';

export function buildRoutePrompt({ text, brainstorm = false, spaces = [], folders = [], repos = [] }) {
  return [
    `They said: ${text}`,
    ...(brainstorm ? [BRAINSTORM_NOTE] : []),
    `Open spaces (id | name | folder):\n${spaces.map(s => `- ${s.id} | ${s.label} | ${s.cwd || '?'}`).join('\n') || '- none'}`,
    `Folders on the Mac (name | path):\n${folders.slice(0, MAX_FOLDERS).map(f => `- ${f.name} | ${f.path}`).join('\n') || '- none'}`,
    `GitHub repos (owner/name | description):\n${repos.slice(0, MAX_REPOS).map(r => `- ${r.full}${r.description ? ` | ${clip(r.description, 80)}` : ''}`).join('\n') || '- none'}`,
  ].join('\n\n');
}

// Turns the model's answer into a route, or `unsure` when it doesn't hold up.
export function cleanRoute(out, { spaces = [], folders = [], repos = [] }, said) {
  const prompt = (typeof out?.prompt === 'string' && out.prompt.trim()) || said.trim();
  const label = typeof out?.label === 'string' ? clip(out.label.trim(), 40) : '';
  const unsure = { kind: 'unsure', label: '', prompt };
  const target = typeof out?.target === 'string' ? out.target.trim() : '';
  const toSpace = s => ({ kind: 'space', spaceId: s.id, where: s.label, label, prompt });
  const toFolder = f => {
    const sp = spaces.find(s => s.cwd === f.path);
    return sp ? toSpace(sp) : { kind: 'folder', cwd: f.path, where: f.name, label, prompt };
  };

  switch (out?.kind) {
    case 'space': {
      const sp = spaces.find(s => s.id === target);
      return sp ? toSpace(sp) : unsure;
    }
    case 'folder': {
      const f = folders.find(x => x.path === target);
      return f ? toFolder(f) : unsure;
    }
    case 'clone': {
      const r = repos.find(x => x.full === target);
      if (!r) return unsure;
      const f = r.local && folders.find(x => x.path === r.local);
      return f ? toFolder(f) : { kind: 'clone', repo: r.full, where: r.full, label, prompt };
    }
    case 'init': {
      const name = slug(target);
      if (!name) return unsure;
      const f = folders.find(x => x.name === name);
      return f ? toFolder(f) : { kind: 'init', label: target, where: name, prompt };
    }
    default:
      return unsure;
  }
}

export class Router {
  constructor({ hub, folders, run, log = console.error }) {
    this.hub = hub;
    this.folders = folders;
    this.run = run;
    this.log = log;
  }

  // Each space's folder is where its agents work.
  #spaces() {
    const agents = this.hub.agents();
    return this.hub.spaces().map(s => ({ ...s, cwd: agents.find(a => a.spaceId === s.id && a.cwd)?.cwd || '' }));
  }

  async route(text, { brainstorm = false } = {}) {
    const ctx = {
      spaces: this.#spaces(),
      folders: this.folders?.list() ?? [],
      repos: await (this.folders?.repos() ?? Promise.resolve([])).catch(() => []),
    };
    let out = null;
    try { out = await this.run(buildRoutePrompt({ text, brainstorm, ...ctx })); } catch (e) { this.log(`routing failed: ${e.message}`); }
    return cleanRoute(out, ctx, text);
  }
}
