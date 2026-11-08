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
      { n: 1, label: 'Red', description: 'Warm' },
      { n: 2, label: 'Green', description: 'Natural' },
      { n: 3, label: 'Blue', description: 'Cool' },
    ],
  });
});

test('joins a question that wraps onto several lines', () => {
  const s = ' ☐ Domain\n\nWhich domain should the manifesto\nlive on?\n\n❯ 1. example.com\n     on demo\n  2. Type something.\n─────\n  3. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const q = parseQuestionScreen(s);
  assert.equal(q.question, 'Which domain should the manifesto live on?');
  assert.deepEqual(q.options.map(o => o.label), ['example.com']);
});

test('returns null when no question is on screen', () => {
  assert.equal(parseQuestionScreen('❯ \n  ⏵⏵ auto mode on · esc to interrupt'), null);
  assert.equal(parseQuestionScreen(''), null);
});
