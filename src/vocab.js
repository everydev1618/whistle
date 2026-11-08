// The user's own wording, learned from Claude's prompt history (history.jsonl in
// every Claude config dir): how they say "push" and "deploy", how each project
// gets deployed, and their most used short prompts as examples of their voice.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_VOCAB = { push: 'commit and push', deploy: 'deploy', deployByProject: {}, examples: [] };

const PUSH = /^(?:yes,? )?(?:commit(?: all)? and )?push(?: it)?(?: to github)?$/;
const DEPLOY = /^(?:yes,? )?(?:deploy\b.*|ship it)$/;
const SHORT = 40;

const top = counts => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

export function learnVocab(entries) {
  const push = new Map(), deploy = new Map(), short = new Map(), byProject = new Map();
  for (const { display, project } of entries) {
    if (typeof display !== 'string') continue;
    const d = display.trim().toLowerCase().replace(/[.!]+$/, '');
    if (!d || d.length > SHORT || d.startsWith('/') || d.startsWith('[') || d.startsWith('!')) continue;
    bump(short, d);
    if (PUSH.test(d)) bump(push, d.replace(/^yes,? /, ''));
    if (DEPLOY.test(d)) {
      const phrase = d.replace(/^yes,? /, '');
      bump(deploy, phrase);
      if (project) {
        if (!byProject.has(project)) byProject.set(project, new Map());
        bump(byProject.get(project), phrase);
      }
    }
  }
  return {
    push: top(push) || DEFAULT_VOCAB.push,
    deploy: top(deploy) || DEFAULT_VOCAB.deploy,
    deployByProject: Object.fromEntries([...byProject].map(([p, m]) => [p, top(m)])),
    examples: [...short].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k),
  };
}

export function loadVocab(claudeDirs) {
  const entries = [];
  for (const dir of claudeDirs) {
    let text;
    try { text = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return learnVocab(entries);
}
