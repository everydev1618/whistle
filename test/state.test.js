import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffAgents } from '../src/state.js';

const a = (id, status, title = 't') => ({ id, status, title });

test('reports added, changed and removed agents', () => {
  const prev = new Map([['x', a('x', 'working')], ['y', a('y', 'idle')], ['z', a('z', 'idle')]]);
  const next = [a('x', 'done'), a('y', 'idle'), a('n', 'working')];
  assert.deepEqual(diffAgents(prev, next), [
    { type: 'changed', agent: a('x', 'done'), from: 'working' },
    { type: 'added', agent: a('n', 'working') },
    { type: 'removed', id: 'z' },
  ]);
});

test('a title change alone counts as a change', () => {
  const prev = new Map([['x', a('x', 'working', 'old')]]);
  assert.deepEqual(diffAgents(prev, [a('x', 'working', 'new')]), [{ type: 'changed', agent: a('x', 'working', 'new'), from: 'working' }]);
});

test('no events when nothing moved', () => {
  const prev = new Map([['x', a('x', 'idle')]]);
  assert.deepEqual(diffAgents(prev, [a('x', 'idle')]), []);
});
