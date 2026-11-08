import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, describeStep } from '../src/transcript.js';

let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 8, 9, 0, n++)).toISOString();
const user = (content, extra = {}) => ({ type: 'user', isSidechain: false, timestamp: ts(), message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => ({ type: 'assistant', isSidechain: false, timestamp: ts(), message: { role: 'assistant', content }, ...extra });
const tool = (id, name, input) => asst([{ type: 'tool_use', id, name, input }]);
const result = (id, content, isError = false) => user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);

test('splits a transcript into turns with prompt, steps and final answer', () => {
  const t = parseTranscript([
    { type: 'ai-title', aiTitle: 'Front page block slider' },
    user('make the blocks a slider'),
    asst([{ type: 'thinking', thinking: '' }]),
    asst([{ type: 'text', text: 'Looking at the page first.' }]),
    tool('t1', 'Read', { file_path: '/repo/src/Blocks.tsx' }),
    result('t1', 'file contents'),
    tool('t2', 'Bash', { command: 'npm run build', description: 'Build the site' }),
    result('t2', 'ok'),
    asst([{ type: 'text', text: 'The blocks now scroll sideways.' }, { type: 'text', text: 'Want me to push?' }]),
  ]);
  assert.equal(t.title, 'Front page block slider');
  assert.equal(t.turns.length, 1);
  const [turn] = t.turns;
  assert.equal(turn.prompt, 'make the blocks a slider');
  assert.deepEqual(turn.steps.map(s => [s.tool, s.ok]), [['Read', true], ['Bash', true]]);
  assert.equal(turn.answer, 'The blocks now scroll sideways.\n\nWant me to push?');
  assert.equal(t.pending, null);
});

test('marks failed tool results and leaves unanswered tools as running', () => {
  const t = parseTranscript([
    user('run tests'),
    tool('a', 'Bash', { command: 'npm test' }),
    result('a', 'boom', true),
    tool('b', 'Bash', { command: 'npm test' }),
  ]);
  assert.deepEqual(t.turns[0].steps.map(s => s.ok), [false, null]);
});

test('skips meta entries, sidechains and tool results when finding prompts', () => {
  const t = parseTranscript([
    user('<local-command-caveat>ignore me</local-command-caveat>', { isMeta: true }),
    user('real prompt'),
    user('subagent prompt', { isSidechain: true }),
    asst([{ type: 'text', text: 'subagent answer' }], { isSidechain: true }),
    asst([{ type: 'text', text: 'main answer' }]),
  ]);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].prompt, 'real prompt');
  assert.equal(t.turns[0].answer, 'main answer');
});

test('shows slash commands as the command the user typed, and /clear starts fresh', () => {
  const t = parseTranscript([
    user('old work'),
    asst([{ type: 'text', text: 'old answer' }]),
    user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    user('<command-name>/code-review</command-name>\n<command-message>code-review</command-message>\n<command-args>high</command-args>'),
    asst([{ type: 'text', text: 'review done' }]),
  ]);
  assert.deepEqual(t.turns.map(x => x.prompt), ['/code-review high']);
});

test('a compaction summary is not a prompt; work after it joins the current turn', () => {
  const t = parseTranscript([
    user('migrate the site'),
    asst([{ type: 'text', text: 'halfway' }]),
    user('This session is being continued from a previous conversation…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    asst([{ type: 'text', text: 'all migrated' }]),
  ]);
  assert.deepEqual(t.turns.map(x => [x.prompt, x.answer]), [['migrate the site', 'halfway\n\nall migrated']]);
});

test('reads prompts given as text blocks and notes attached images', () => {
  const t = parseTranscript([
    user([{ type: 'text', text: 'what is wrong here' }, { type: 'image', source: {} }]),
  ]);
  assert.equal(t.turns[0].prompt, 'what is wrong here [image]');
});

test('tallies changed files with added and removed line counts', () => {
  const t = parseTranscript([
    user('edit it'),
    tool('e1', 'Edit', { file_path: '/repo/a.js', old_string: 'x\ny', new_string: 'x\ny\nz\nw' }),
    result('e1', 'ok'),
    tool('e2', 'Write', { file_path: '/repo/b.js', content: '1\n2\n3' }),
    result('e2', 'ok'),
    tool('e3', 'Edit', { file_path: '/repo/a.js', old_string: 'q', new_string: '' }),
    result('e3', 'ok'),
  ]);
  assert.deepEqual(t.turns[0].files, {
    '/repo/a.js': { added: 4, removed: 3 },
    '/repo/b.js': { added: 3, removed: 0 },
  });
  assert.deepEqual(t.turns[0].steps[0].diff, { file: '/repo/a.js', removed: ['x', 'y'], added: ['x', 'y', 'z', 'w'] });
});

test('reports a pending AskUserQuestion until it has a result', () => {
  const questions = [{ question: 'Which domain?', header: 'Domain', multiSelect: false,
    options: [{ label: 'example.com', description: 'on demo' }, { label: 'manifesto.example.com', description: 'needs CNAME' }] }];
  const open = parseTranscript([user('ship it'), tool('q1', 'AskUserQuestion', { questions })]);
  assert.deepEqual(open.pending, { toolUseId: 'q1', questions });
  const answered = parseTranscript([user('ship it'), tool('q1', 'AskUserQuestion', { questions }), result('q1', 'example.com')]);
  assert.equal(answered.pending, null);
});

test('keeps only the last title and caps the number of turns returned', () => {
  const entries = [{ type: 'ai-title', aiTitle: 'Old' }, { type: 'ai-title', aiTitle: 'New' }];
  for (let i = 0; i < 30; i++) entries.push(user(`p${i}`), asst([{ type: 'text', text: `a${i}` }]));
  const t = parseTranscript(entries, { maxTurns: 5 });
  assert.equal(t.title, 'New');
  assert.equal(t.totalTurns, 30);
  assert.deepEqual(t.turns.map(x => x.prompt), ['p25', 'p26', 'p27', 'p28', 'p29']);
});

test('describes common tools in plain words', () => {
  assert.equal(describeStep('Bash', { command: 'npm run build', description: 'Build the site' }), 'Build the site');
  assert.equal(describeStep('Bash', { command: 'npm test' }), 'Ran npm test');
  assert.equal(describeStep('Read', { file_path: '/Users/me/Code/x/src/a.ts' }), 'Read a.ts');
  assert.equal(describeStep('Edit', { file_path: '/x/b.ts' }), 'Edited b.ts');
  assert.equal(describeStep('Write', { file_path: '/x/c.ts' }), 'Wrote c.ts');
  assert.equal(describeStep('Grep', { pattern: 'TODO' }), 'Searched for TODO');
  assert.equal(describeStep('WebSearch', { query: 'herdr' }), 'Searched the web for herdr');
  assert.equal(describeStep('mcp__claude_ai_Gmail__send_message', {}), 'Gmail: send message');
  assert.equal(describeStep('Agent', { description: 'Explore repo' }), 'Agent: Explore repo');
  assert.equal(describeStep('Mystery', {}), 'Mystery');
});
