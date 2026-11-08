import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAgents, isSeen, isDone, turnKey, spaceTiles, spaceAgents } from '../public/herd.js';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const ago = h => new Date(NOW - h * 3600e3).toISOString();
const ag = (id, status, hoursAgo, extra = {}) => ({ id, status, session: 'default', endedAt: ago(hoursAgo), ...extra });
const ids = list => list.map(a => a.id);

test('a turn is identified by when it ended', () => {
  assert.equal(turnKey(ag('a', 'done', 1)), ago(1));
  assert.equal(turnKey({ id: 'a', endedAt: null, lastPrompt: 'go' }), 'go');
});

test('seen: idle in herdr, or opened in whistle for this same turn', () => {
  const a = ag('a', 'done', 1);
  assert.equal(isSeen(a, {}), false);
  assert.equal(isSeen(a, { a: { seen: ago(1) } }), true);
  assert.equal(isSeen(a, { a: { seen: ago(5) } }), false, 'seen an older turn');
  assert.equal(isSeen(ag('b', 'idle', 1), {}), true);
});

test('done only counts for the turn it was marked on', () => {
  const a = ag('a', 'done', 1);
  assert.equal(isDone(a, { a: { done: ago(1) } }), true);
  assert.equal(isDone(a, { a: { done: ago(5) } }), false);
});

test('groups: asking, finished (recent, not done; unseen first), working, earlier', () => {
  const agents = [
    ag('ask', 'blocked', 2),
    ag('seenNew', 'idle', 1),
    ag('unseenOld', 'done', 3),
    ag('doneIt', 'done', 0.5),
    ag('stale', 'done', 30),
    ag('run', 'working', 0.1),
    ag('askDone', 'blocked', 1),
  ];
  const marks = { doneIt: { done: ago(0.5) }, askDone: { done: ago(1) } };
  const g = groupAgents(agents, marks, NOW);
  assert.deepEqual(ids(g.asking), ['askDone', 'ask'], 'asking ignores done marks');
  assert.deepEqual(ids(g.finished), ['unseenOld', 'seenNew']);
  assert.deepEqual(ids(g.working), ['run']);
  assert.deepEqual(ids(g.earlier), ['doneIt', 'stale']);
});

test('a done agent comes back to finished when it ends a new turn', () => {
  const marks = { a: { done: ago(5), seen: ago(5) } };
  const g = groupAgents([ag('a', 'done', 1)], marks, NOW);
  assert.deepEqual(ids(g.finished), ['a']);
  assert.equal(isSeen(g.finished[0], marks), false);
});

test('a space tile counts what needs you: asking, new finishes, working', () => {
  const spaces = [{ id: 'default/w1', session: 'default', label: 'demo', number: 1 }, { id: 'default/w2', session: 'default', label: 'quiet', number: 2 }];
  const agents = [
    ag('default/w1:p1', 'blocked', 1, { spaceId: 'default/w1' }),
    ag('default/w1:p2', 'done', 1, { spaceId: 'default/w1' }),
    ag('default/w1:p3', 'done', 2, { spaceId: 'default/w1' }),
    ag('default/w1:p4', 'working', 0, { spaceId: 'default/w1' }),
    ag('default/w1:p5', 'idle', 3, { spaceId: 'default/w1' }),
    ag('default/w2:p1', 'idle', 30, { spaceId: 'default/w2' }),
  ];
  const marks = { 'default/w1:p3': { seen: ago(2) } };
  const tiles = spaceTiles(spaces, agents, marks);
  assert.deepEqual(tiles.map(t => [t.space.label, t.total, t.asking, t.fresh, t.working, t.endedAt]), [
    ['demo', 5, 1, 1, 1, ago(0)],
    ['quiet', 1, 0, 0, 0, ago(30)],
  ]);
});

test('a space lists its agents: asking, working, new, then the rest by recency', () => {
  const agents = [
    ag('s/w1:p1', 'idle', 5, { spaceId: 's/w1' }),
    ag('s/w1:p2', 'done', 1, { spaceId: 's/w1' }),
    ag('s/w1:p3', 'working', 2, { spaceId: 's/w1' }),
    ag('s/w1:p4', 'blocked', 3, { spaceId: 's/w1' }),
    ag('s/w1:p5', 'done', 4, { spaceId: 's/w1' }),
    ag('s/w2:p1', 'blocked', 1, { spaceId: 's/w2' }),
  ];
  const marks = { 's/w1:p2': { seen: ago(1) } };
  assert.deepEqual(ids(spaceAgents(agents, 's/w1', marks)), ['s/w1:p4', 's/w1:p3', 's/w1:p5', 's/w1:p2', 's/w1:p1']);
});
