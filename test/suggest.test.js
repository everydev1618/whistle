import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../src/suggest.js';

const turn = (answer, files = {}) => ({ prompt: 'p', steps: [], answer, files });
const tr = (...turns) => ({ title: 't', turns, pending: null });

test('a question on screen becomes one button per option, sent as its number key', () => {
  const question = { header: 'Color', question: 'Which color?', options: [{ n: 1, label: 'Red', description: 'Warm' }, { n: 2, label: 'Green', description: 'Natural' }] };
  assert.deepEqual(suggest({ status: 'blocked', question, transcript: tr() }), [
    { label: 'Red', hint: 'Warm', keys: ['1'], primary: true },
    { label: 'Green', hint: 'Natural', keys: ['2'], primary: false },
  ]);
});

test('an answer ending in an offer gets Yes and No', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('All fixed.\n\nWant me to commit and push?')) });
  assert.deepEqual(s.slice(0, 2), [{ label: 'Yes', text: 'yes', primary: true }, { label: 'No', text: 'no', primary: false }]);
});

test('changed files that were not pushed get a push button', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('The slider works now.', { '/r/a.ts': { added: 3, removed: 1 } })) });
  assert.deepEqual(s, [{ label: 'Commit and push', text: 'commit and push', primary: true }]);
});

test('no push button once the answer says it was pushed', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('Committed and pushed to main.', { '/r/a.ts': { added: 3, removed: 1 } })) });
  assert.deepEqual(s, []);
});

test('offer plus unpushed files: Yes stays primary, push is secondary', () => {
  const s = suggest({ status: 'done', transcript: tr(turn('Should I also add dots?', { '/r/a.ts': { added: 1, removed: 0 } })) });
  assert.deepEqual(s.map(x => [x.label, x.primary]), [['Yes', true], ['No', false], ['Commit and push', false]]);
});

test('working agents and empty transcripts get no buttons', () => {
  assert.deepEqual(suggest({ status: 'working', transcript: tr(turn('Want me to push?')) }), []);
  assert.deepEqual(suggest({ status: 'idle', transcript: null }), []);
});
