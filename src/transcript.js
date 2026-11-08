// Turns a Claude Code transcript (.jsonl entries) into what the phone shows:
// turns of { prompt, steps, answer, files }, the session title, and any question
// Claude is waiting on.

const LOCAL_COMMANDS = new Set(['/exit', '/mcp', '/config', '/model', '/help', '/status', '/cost', '/login', '/logout', '/resume', '/compact', '/context', '/permissions', '/fast']);
const MAX_DIFF_LINES = 40;

const base = p => (p || '').split('/').pop();
const lines = s => (s ? String(s).split('\n').length : 0);
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function describeStep(tool, input = {}) {
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__');
    return `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${name.replace(/_/g, ' ')}`;
  }
  switch (tool) {
    case 'Bash': return input.description || `Ran ${clip(String(input.command || '').split('\n')[0])}`;
    case 'Read': return `Read ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${base(input.file_path)}`;
    case 'Write': return `Wrote ${base(input.file_path)}`;
    case 'NotebookEdit': return `Edited ${base(input.notebook_path)}`;
    case 'Grep': return `Searched for ${clip(String(input.pattern || ''), 50)}`;
    case 'Glob': return `Listed ${clip(String(input.pattern || ''), 50)}`;
    case 'WebSearch': return `Searched the web for ${clip(String(input.query || ''), 60)}`;
    case 'WebFetch': try { return `Fetched ${new URL(input.url).host}`; } catch { return 'Fetched a page'; }
    case 'Agent': case 'Task': return `Agent: ${input.description || 'subtask'}`;
    case 'Skill': return `Skill: ${input.skill || ''}`.trim();
    case 'TodoWrite': return 'Updated the todo list';
    case 'ToolSearch': return 'Loaded tools';
    case 'AskUserQuestion': return 'Asked you a question';
    default: return tool;
  }
}

// Returns the prompt text for a real user entry, '' for entries to ignore,
// or { clear: true } for /clear.
function promptOf(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return '';
  const c = entry.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b.type === 'tool_result')) return '';
    text = c.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join(' ');
  } else return '';
  text = text.trim();
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const name = cmd[1].trim();
    if (name === '/clear') return { clear: true };
    if (LOCAL_COMMANDS.has(name)) return '';
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '').trim();
    return args ? `${name} ${args}` : name;
  }
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return `! ${bash[1].trim()}`;
  if (text.startsWith('<')) return ''; // command output, reminders, caveats
  return text;
}

export function parseTranscript(entries, { maxTurns = 20 } = {}) {
  let title = null;
  let turns = [];
  let turn = null;
  const steps = new Map(); // tool_use id -> step
  const questions = new Map(); // tool_use id -> questions, until answered

  for (const e of entries) {
    if (e.type === 'ai-title') { title = e.aiTitle; continue; }
    if (e.isSidechain) continue;

    if (e.type === 'user') {
      const p = promptOf(e);
      if (p && typeof p === 'object') { turns = []; turn = null; questions.clear(); continue; }
      if (p) {
        turn = { prompt: p, at: e.timestamp, endedAt: e.timestamp, steps: [], answer: '', files: {}, _texts: [] };
        turns.push(turn);
        continue;
      }
      if (Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b.type !== 'tool_result') continue;
          const s = steps.get(b.tool_use_id);
          if (s) s.ok = !b.is_error;
          questions.delete(b.tool_use_id);
        }
        if (turn) turn.endedAt = e.timestamp;
      }
      continue;
    }

    if (e.type !== 'assistant' || !turn || !Array.isArray(e.message?.content)) continue;
    turn.endedAt = e.timestamp;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text?.trim()) turn._texts.push(b.text.trim());
      if (b.type !== 'tool_use') continue;
      turn._texts = []; // the answer is what Claude says after its last tool call
      const input = b.input || {};
      const step = { id: b.id, tool: b.name, label: describeStep(b.name, input), ok: null };
      tally(turn, step, b.name, input);
      steps.set(b.id, step);
      turn.steps.push(step);
      if (b.name === 'AskUserQuestion') questions.set(b.id, input.questions || []);
    }
  }

  for (const t of turns) { t.answer = t._texts.join('\n\n'); delete t._texts; }
  const last = [...questions].at(-1);
  return {
    title,
    totalTurns: turns.length,
    turns: turns.slice(-maxTurns),
    pending: last ? { toolUseId: last[0], questions: last[1] } : null,
  };
}

function tally(turn, step, tool, input) {
  const add = (file, added, removed) => {
    if (!file) return;
    const f = (turn.files[file] ||= { added: 0, removed: 0 });
    f.added += added;
    f.removed += removed;
  };
  if (tool === 'Edit') {
    add(input.file_path, lines(input.new_string), lines(input.old_string));
    step.diff = {
      file: input.file_path,
      removed: String(input.old_string ?? '').split('\n').slice(0, MAX_DIFF_LINES),
      added: String(input.new_string ?? '').split('\n').slice(0, MAX_DIFF_LINES),
    };
  } else if (tool === 'MultiEdit') {
    for (const ed of input.edits || []) add(input.file_path, lines(ed.new_string), lines(ed.old_string));
  } else if (tool === 'Write') {
    add(input.file_path, lines(input.content), 0);
  }
}
