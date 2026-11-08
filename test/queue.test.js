import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from '../src/queue.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-q-')), 'queue.json');

test('queues messages per agent in order and survives a restart', () => {
  const file = tmpFile();
  const q = new Queue(file);
  const a = q.add('default/w1:p1', 'push it');
  q.add('default/w1:p1', 'then deploy');
  q.add('work/w2:p3', 'yes');
  assert.match(a.id, /^[a-z0-9]+$/);
  assert.deepEqual(new Queue(file).list('default/w1:p1').map(i => i.text), ['push it', 'then deploy']);
  assert.deepEqual(q.list('nope'), []);
});

test('removes one message, and takes the next one off the front', () => {
  const q = new Queue(tmpFile());
  const a = q.add('x', 'one');
  const b = q.add('x', 'two');
  q.add('x', 'three');
  assert.equal(q.remove('x', b.id), true);
  assert.equal(q.remove('x', 'missing'), false);
  assert.equal(q.shift('x').id, a.id);
  assert.deepEqual(q.list('x').map(i => i.text), ['three']);
  q.shift('x');
  assert.equal(q.shift('x'), null);
  assert.deepEqual(q.ids(), []);
});

test('rejects empty or huge messages and too many queued', () => {
  const q = new Queue(tmpFile(), { maxPerAgent: 2 });
  assert.throws(() => q.add('x', '  '), /empty/);
  assert.throws(() => q.add('x', 'a'.repeat(20001)), /long/);
  q.add('x', '1'); q.add('x', '2');
  assert.throws(() => q.add('x', '3'), /full/);
});

test('drops agents that are gone', () => {
  const q = new Queue(tmpFile());
  q.add('a', '1'); q.add('b', '2');
  assert.deepEqual(q.prune(new Set(['b'])), ['a']);
  assert.deepEqual(q.ids(), ['b']);
});
