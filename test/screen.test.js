import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseQuestionScreen } from '../src/screen.js';

const real = fs.readFileSync(new URL('./fixtures/question-screen.txt', import.meta.url), 'utf8');

test('reads a Claude question off the screen, with option numbers and descriptions', () => {
  assert.deepEqual(parseQuestionScreen(real), {
    header: 'Color',
    question: 'Which color?',
    options: [
      { n: 1, label: 'Red', description: 'Warm', keys: ['1'] },
      { n: 2, label: 'Green', description: 'Natural', keys: ['2'] },
      { n: 3, label: 'Blue', description: 'Cool', keys: ['3'] },
    ],
  });
});

test('joins a question that wraps onto several lines', () => {
  const s = ' ☐ Domain\n\nWhich domain should the manifesto\nlive on?\n\n❯ 1. example.com\n     on demo\n  2. Type something.\n─────\n  3. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const q = parseQuestionScreen(s);
  assert.equal(q.question, 'Which domain should the manifesto live on?');
  assert.deepEqual(q.options.map(o => o.label), ['example.com']);
});

test('numbered options are answered with their number key', () => {
  assert.deepEqual(parseQuestionScreen(real).options.map(o => o.keys), [['1'], ['2'], ['3']]);
});

const trust = fs.readFileSync(new URL('./fixtures/trust-screen.txt', import.meta.url), 'utf8');

test('reads Claude\'s trust-this-folder prompt, answered with arrows and Enter', () => {
  assert.deepEqual(parseQuestionScreen(trust), {
    header: 'Trust this folder?',
    question: '/Users/me/Code/new-project · Claude Code will be able to read, edit, and execute files here.',
    arrows: true,
    options: [
      { n: 1, label: 'No, exit', description: '', keys: ['enter'] },
      { n: 2, label: 'Yes, I trust this folder', description: '', keys: ['down', 'enter'] },
    ],
  });
});

test('an arrow menu counts moves from wherever the cursor is', () => {
  const s = '────\n Pick one\n\n   Alpha\n   Beta\n ❯ Gamma\n\n Enter to confirm · Esc to cancel';
  const q = parseQuestionScreen(s);
  assert.equal(q.header, 'Pick one');
  assert.deepEqual(q.options.map(o => [o.label, o.keys]), [['Alpha', ['up', 'up', 'enter']], ['Beta', ['up', 'enter']], ['Gamma', ['enter']]]);
});

test('returns null when no question is on screen', () => {
  assert.equal(parseQuestionScreen('❯ \n  ⏵⏵ auto mode on · esc to interrupt'), null);
  assert.equal(parseQuestionScreen(''), null);
});

test('a long folder path is shortened to its last parts', () => {
  const long = trust.replace('/Users/me/Code/new-project', '/private/tmp/a/very/deep/scratch/untrusted');
  assert.match(parseQuestionScreen(long).question, /^…\/scratch\/untrusted · /);
});

test('on the second of several questions, the header is the one being asked', () => {
  const q = parseQuestionScreen(fs.readFileSync(new URL('./fixtures/question-second-screen.txt', import.meta.url), 'utf8'));
  assert.equal(q.header, 'Fruit');
  assert.equal(q.question, 'Which fruit?');
  assert.deepEqual(q.options.map(o => [o.label, o.keys]), [['Apple', ['1']], ['Pear', ['2']]]);
});

test('after the last question, the review screen asks to submit the answers', () => {
  // This screen has no "Enter to select" footer.
  const q = parseQuestionScreen(fs.readFileSync(new URL('./fixtures/question-review-screen.txt', import.meta.url), 'utf8'));
  assert.equal(q.header, 'Submit your answers?');
  assert.equal(q.question, 'Which color? → Red · Which fruit? → Apple');
  assert.deepEqual(q.options.map(o => [o.label, o.keys]), [['Submit answers', ['1']], ['Cancel', ['2']]]);
});
