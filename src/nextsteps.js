// Next-step buttons from Claude Haiku: when an agent finishes a turn, ask once
// what the user would likely send next, in their own voice, and cache it per turn.
// Runs through the `claude` CLI so it uses the machine's existing Claude login.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = 'claude-haiku-5-5';
const ANSWER_TAIL = 3000;
const MAX_CACHE = 500;

const SYSTEM = `You suggest reply buttons for a phone app that steers Claude Code agents.
Given the agent's last turn, suggest up to 3 prompts the user is most likely to send next.
- Concrete next steps that follow from this turn: answer its question, act on what it found, take the obvious next step. No generic filler ("thanks", "explain more").
- Write "text" the way this user types: short, lowercase, terse, no pleasantries, usually under 10 words.
- "label" is the button: 1 to 3 words, sentence case (capitalize only the first word and names).
- Don't repeat the buttons already shown.
- If nothing useful comes next, return an empty list.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { suggestions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } }, required: ['label', 'text'] } } },
  required: ['suggestions'],
});

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function buildPrompt({ project, turn, existing = [], vocab = {} }) {
  const files = Object.entries(turn.files || {}).map(([f, c]) => `${path.basename(f)} (+${c.added} -${c.removed})`);
  const answer = turn.answer.length > ANSWER_TAIL ? '…' + turn.answer.slice(-ANSWER_TAIL) : turn.answer;
  return [
    `Project: ${project || 'unknown'}`,
    `User asked: ${clip(turn.prompt || '', 500)}`,
    turn.steps?.length ? `What the agent did:\n${turn.steps.slice(-20).map(s => `- ${s.label}`).join('\n')}` : null,
    files.length ? `Files changed: ${files.join(', ')}` : null,
    `Agent's answer:\n${answer}`,
    `Buttons already shown: ${existing.map(b => b.text || b.label).join(' | ') || 'none'}`,
    vocab.examples?.length ? `How this user usually types: ${vocab.examples.join(' | ')}` : null,
  ].filter(Boolean).join('\n\n');
}

export function cleanSuggestions(out) {
  if (!Array.isArray(out?.suggestions)) return [];
  return out.suggestions
    .filter(s => typeof s?.label === 'string' && typeof s?.text === 'string' && s.label.trim() && s.text.trim())
    .slice(0, 3)
    .map(s => ({ label: clip(s.label.trim(), 26), text: clip(s.text.trim(), 300) }));
}

// One structured answer from Haiku. The system prompt and schema default to next steps.
export function runClaude(prompt, { bin = 'claude', model = MODEL, configDir, timeoutMs = 60000, system = SYSTEM, schema = SCHEMA } = {}) {
  const args = ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--setting-sources', '',
    '--system-prompt', system, '--output-format', 'json', '--json-schema', schema];
  const env = { ...process.env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const r = JSON.parse(out);
        if (code !== 0 || r.is_error) return reject(new Error(`claude exited ${code}: ${r.result || err}`.slice(0, 300)));
        resolve(r.structured_output ?? JSON.parse(r.result));
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

export class NextSteps {
  #cache = new Map();   // key -> suggestions, or null while asking
  #queue = [];
  #active = 0;

  // With `file`, answers are saved there so a restart doesn't ask again.
  // Failures are never saved, so they get retried after a restart.
  constructor({ run = p => runClaude(p), concurrency = 2, log = console.error, file = null } = {}) {
    this.run = run;
    this.concurrency = concurrency;
    this.log = log;
    this.file = file;
    this.#saved = new Set();
    if (file) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) { this.#cache.set(k, v); this.#saved.add(k); }
      } catch { /* missing or corrupt: start empty */ }
    }
  }

  #saved;

  #save() {
    if (!this.file) return;
    try {
      const data = Object.fromEntries([...this.#cache].filter(([k, v]) => v && this.#saved.has(k)));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log(`could not save next steps: ${e.message}`); }
  }

  // Returns cached suggestions, or null while they are being worked out;
  // onReady is called once when they land.
  get(key, ctx, onReady) {
    if (this.#cache.has(key)) return this.#cache.get(key);
    this.#cache.set(key, null);
    if (this.#cache.size > MAX_CACHE) {
      const oldest = this.#cache.keys().next().value;
      this.#cache.delete(oldest);
      this.#saved.delete(oldest);
    }
    this.#queue.push({ key, ctx, onReady });
    this.#pump();
    return null;
  }

  #pump() {
    while (this.#active < this.concurrency && this.#queue.length) {
      const { key, ctx, onReady } = this.#queue.shift();
      this.#active++;
      Promise.resolve()
        .then(() => this.run(buildPrompt(ctx)))
        .then(out => ({ ok: true, s: cleanSuggestions(out) }), e => { this.log(`next steps failed: ${e.message}`); return { ok: false, s: [] }; })
        .then(({ ok, s }) => {
          this.#cache.set(key, s);
          if (ok) { this.#saved.add(key); this.#save(); }
          this.#active--;
          try { onReady(); } finally { this.#pump(); }
        });
    }
  }
}
