// Finds the Claude Code transcript for a herdr pane:
// pane process info -> claude pid -> <claudeDir>/sessions/<pid>.json -> sessionId
// -> <claudeDir>/projects/*/<sessionId>.jsonl
import fs from 'node:fs';
import path from 'node:path';

const isClaude = p => p.argv0 === 'claude' || /(^|\/)claude$/.test(p.argv?.[0] || '');

// Each herdr session may run Claude with its own CLAUDE_CONFIG_DIR, so look in
// ~/.claude and every ~/.claude-* folder.
export function findClaudeDirs(home) {
  let names = [];
  try { names = fs.readdirSync(home); } catch { return []; }
  return names
    .filter(n => /^\.claude(-[^/]+)?$/.test(n))
    .map(n => path.join(home, n))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .sort();
}

export function findTranscript({ processInfo, claudeDir }) {
  const proc = (processInfo?.foreground_processes || []).find(isClaude);
  if (!proc) return null;
  for (const dir of [claudeDir].flat()) {
    const found = inDir(dir, proc.pid);
    if (found) return found;
  }
  return null;
}

function inDir(claudeDir, pid) {
  let session;
  try { session = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), 'utf8')); } catch { return null; }
  const projects = path.join(claudeDir, 'projects');
  const file = `${session.sessionId}.jsonl`;
  // Try the folder named after the cwd first, then look everywhere.
  const guess = path.join(projects, (session.cwd || '').replace(/[^A-Za-z0-9]/g, '-'), file);
  if (fs.existsSync(guess)) return { pid, sessionId: session.sessionId, path: guess };
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(projects, d, file);
    if (fs.existsSync(p)) return { pid, sessionId: session.sessionId, path: p };
  }
  return null;
}

export function readEntries(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return out;
}
