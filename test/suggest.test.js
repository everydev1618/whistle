import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, mergeSuggestions } from '../src/suggest.js';

const turn = (answer, files = {}) => ({ prompt: 'p', steps: [], answer, files });
const tr = (...turns) => ({ title: 't', turns, pending: null });
const vocab = { push: 'push it', deploy: 'ship it', deployByProject: { '/r/site': 'deploy to lighthouse' }, examples: [] };

test('a question on screen becomes one button per option, sent as its number key', () => {
  const question = { header: 'Color', question: 'Which color?', options: [{ n: 1, label: 'Red', description: 'Warm' }, { n: 2, label: 'Green', description: 'Natural' }] };
  assert.deepEqual(suggest({ status: 'blocked', question, transcript: tr() }), [
    { label: 'Red', hint: 'Warm', keys: ['1'], primary: true },
    { label: 'Green', hint: 'Natural', keys: ['2'], primary: false },
  ]);
});

test('an arrow menu sends its option\'s keys, with no default button', () => {
  const question = { header: 'Trust this folder?', question: '/x', arrows: true, options: [{ n: 1, label: 'No, exit', description: '', keys: ['enter'] }, { n: 2, label: 'Yes, I trust this folder', description: '', keys: ['down', 'enter'] }] };
  assert.deepEqual(suggest({ status: 'blocked', question, transcript: tr() }).map(c => [c.label, c.keys, c.primary]), [
    ['No, exit', ['enter'], false],
    ['Yes, I trust this folder', ['down', 'enter'], false],
  ]);
});

test('a bare question gets Yes and No', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('All fixed.\n\nDoes that look right?')) });
  assert.deepEqual(s, [{ label: 'Yes', text: 'yes', primary: true }, { label: 'No', text: 'no', primary: false }]);
});

test('an offer becomes "Yes, <the offer>" in the user\'s own shape', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('All fixed.\n\nWant me to deploy it?')) });
  assert.deepEqual(s, [{ label: 'Yes, deploy it', text: 'yes deploy it', primary: true }, { label: 'No', text: 'no', primary: false }]);
  const t = suggest({ status: 'done', transcript: tr(turn('Done. Should I also add keyboard support?')) });
  assert.equal(t[0].text, 'yes add keyboard support');
});

test('an either/or offer becomes one button per choice', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('Want me to push now or wait for review?')) });
  assert.deepEqual(s.map(x => [x.label, x.text, x.primary]), [['Push now', 'push now', true], ['Wait for review', 'wait for review', false]]);
});

test('a long offer keeps plain Yes', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('Want me to rewrite the whole auth layer so that sessions survive restarts and tokens rotate?')) });
  assert.equal(s[0].text, 'yes');
});

test('changed files that were not pushed get a push button in the user\'s words', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('The slider works now.', { '/r/a.ts': { added: 3, removed: 1 } })), vocab });
  assert.deepEqual(s, [{ label: 'Push it', text: 'push it', primary: true }]);
  const d = suggest({ status: 'done', transcript: tr(turn('The slider works now.', { '/r/a.ts': { added: 3, removed: 1 } })) });
  assert.equal(d[0].text, 'commit and push');
});

test('once pushed, a project the user deploys gets its deploy button', () => {
  const s = suggest({ status: 'done', cwd: '/r/site', transcript: tr(turn('Committed and pushed to main.', { '/r/a.ts': { added: 3, removed: 1 } })), vocab });
  assert.deepEqual(s, [{ label: 'Deploy to lighthouse', text: 'deploy to lighthouse', primary: true }]);
  assert.deepEqual(suggest({ status: 'done', cwd: '/r/other', transcript: tr(turn('Committed and pushed.', { '/r/a.ts': { added: 1, removed: 0 } })), vocab }), []);
  assert.deepEqual(suggest({ status: 'done', cwd: '/r/site', transcript: tr(turn('Pushed and deployed.', { '/r/a.ts': { added: 1, removed: 0 } })), vocab }), []);
});

test('offer plus unpushed files: the offer stays primary, push is secondary', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('Does it look right?', { '/r/a.ts': { added: 1, removed: 0 } })), vocab });
  assert.deepEqual(s.map(x => [x.label, x.primary]), [['Yes', true], ['No', false], ['Push it', false]]);
});

test('working agents and empty transcripts get no buttons', () => {
  assert.deepEqual(suggest({ status: 'working', transcript: tr(turn('Want me to push?')) }), []);
  assert.deepEqual(suggest({ status: 'idle', transcript: null }), []);
});

test('merge keeps rule buttons first, drops duplicates, caps the count', () => {
  const rules = [{ label: 'Push it', text: 'push it', primary: true }];
  const model = [{ label: 'Push', text: 'Push it.' }, { label: 'Add tests', text: 'add tests' }, { label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }];
  assert.deepEqual(mergeSuggestions(rules, model), [
    { label: 'Push it', text: 'push it', primary: true },
    { label: 'Add tests', text: 'add tests', primary: false, source: 'model' },
    { label: 'A', text: 'a', primary: false, source: 'model' },
    { label: 'B', text: 'b', primary: false, source: 'model' },
  ]);
  assert.equal(mergeSuggestions([], model)[0].primary, true);
});
