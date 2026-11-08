import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learnVocab, loadVocab, DEFAULT_VOCAB } from '../src/vocab.js';

const h = (display, project = '/r/app') => ({ display, project });

test('picks the user\'s most frequent wording for pushing and deploying', () => {
  const v = learnVocab([
    h('push it'), h('push it'), h('commit and push'), h('Push it'),
    h('deploy'), h('ship it'), h('ship it'),
    h('yes'), h('make the header blue please'),
  ]);
  assert.equal(v.push, 'push it');
  assert.equal(v.deploy, 'ship it');
});

test('remembers how each project gets deployed', () => {
  const v = learnVocab([
    h('deploy to lighthouse', '/r/a'), h('deploy to lighthouse', '/r/a'), h('deploy', '/r/a'),
    h('deploy it to vercel', '/r/b'),
    h('push it', '/r/c'),
  ]);
  assert.deepEqual(v.deployByProject, { '/r/a': 'deploy to lighthouse', '/r/b': 'deploy it to vercel' });
});

test('keeps the user\'s most used short prompts as examples of their voice', () => {
  const v = learnVocab([h('yes'), h('yes'), h('yes'), h('send it'), h('send it'), h('/exit'), h('[Pasted text #1 +3 lines]'), h('x'.repeat(80))]);
  assert.deepEqual(v.examples, ['yes', 'send it']);
});

test('falls back to plain defaults with no history', () => {
  assert.deepEqual(learnVocab([]), DEFAULT_VOCAB);
});

test('loads every history.jsonl under the claude dirs, skipping bad lines', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-voc-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-voc-'));
  fs.writeFileSync(path.join(a, 'history.jsonl'), JSON.stringify(h('ship it')) + '\nnot json\n');
  fs.writeFileSync(path.join(b, 'history.jsonl'), JSON.stringify(h('ship it')) + '\n');
  const v = loadVocab([a, b, '/nowhere']);
  assert.equal(v.deploy, 'ship it');
  assert.deepEqual(v.examples, ['ship it']);
});
