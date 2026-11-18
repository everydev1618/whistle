import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, buildRoutePrompt, cleanRoute } from '../src/route.js';

const ctx = {
  spaces: [
    { id: 'default/w1', label: 'whistle', cwd: '/code/whistle' },
    { id: 'default/w2', label: 'Lighthouse', cwd: '/code/lighthouse' },
  ],
  folders: [
    { name: 'whistle', path: '/code/whistle' },
    { name: 'lighthouse', path: '/code/lighthouse' },
    { name: 'voice', path: '/code/voice' },
  ],
  repos: [
    { full: 'me/hop', description: 'a hopping game', local: null },
    { full: 'me/voice', description: '', local: '/code/voice' },
  ],
};

test('the prompt lists what was said, every space, folder and repo', () => {
  const p = buildRoutePrompt({ text: 'in whistle make the toast stay longer', ...ctx });
  for (const s of ['in whistle make the toast stay longer', 'default/w1', 'whistle', '/code/whistle', 'Lighthouse', '/code/voice', 'me/hop', 'a hopping game']) assert.ok(p.includes(s), s);
});

test('a known space goes to that space with the routing words dropped', () => {
  assert.deepEqual(
    cleanRoute({ kind: 'space', target: 'default/w1', label: 'Toast', prompt: 'make the toast stay longer' }, ctx, 'in whistle make the toast stay longer'),
    { kind: 'space', spaceId: 'default/w1', where: 'whistle', label: 'Toast', prompt: 'make the toast stay longer' },
  );
});

test('a folder that already has a space goes to the space instead', () => {
  assert.deepEqual(
    cleanRoute({ kind: 'folder', target: '/code/lighthouse', label: '', prompt: 'add a status page' }, ctx, 'x'),
    { kind: 'space', spaceId: 'default/w2', where: 'Lighthouse', label: '', prompt: 'add a status page' },
  );
});

test('a folder without a space becomes a new space there', () => {
  assert.deepEqual(
    cleanRoute({ kind: 'folder', target: '/code/voice', label: 'Voice', prompt: 'tighten the checker' }, ctx, 'x'),
    { kind: 'folder', cwd: '/code/voice', where: 'voice', label: 'Voice', prompt: 'tighten the checker' },
  );
});

test('a new repo gets a name, and a name already in ~/Code means that folder', () => {
  assert.deepEqual(
    cleanRoute({ kind: 'init', target: 'Tide Tables', label: '', prompt: 'scaffold a node server' }, ctx, 'x'),
    { kind: 'init', label: 'Tide Tables', where: 'tide-tables', prompt: 'scaffold a node server' },
  );
  assert.equal(cleanRoute({ kind: 'init', target: 'voice', label: '', prompt: 'p' }, ctx, 'x').kind, 'folder');
  assert.equal(cleanRoute({ kind: 'init', target: '!!!', label: '', prompt: 'p' }, ctx, 'x').kind, 'unsure');
});

test('a clone must be a repo the account can see; one already cloned with a space goes there', () => {
  assert.deepEqual(
    cleanRoute({ kind: 'clone', target: 'me/hop', label: '', prompt: 'add a high score' }, ctx, 'x'),
    { kind: 'clone', repo: 'me/hop', where: 'me/hop', label: '', prompt: 'add a high score' },
  );
  assert.equal(cleanRoute({ kind: 'clone', target: 'someone/else', label: '', prompt: 'p' }, ctx, 'x').kind, 'unsure');
  assert.equal(cleanRoute({ kind: 'clone', target: 'me/voice', label: '', prompt: 'p' }, ctx, 'x').kind, 'folder');
});

test('anything unknown or malformed is unsure and keeps what was said', () => {
  assert.deepEqual(cleanRoute({ kind: 'space', target: 'default/w9', prompt: '' }, ctx, 'do the thing'), { kind: 'unsure', label: '', prompt: 'do the thing' });
  assert.deepEqual(cleanRoute(null, ctx, 'do the thing'), { kind: 'unsure', label: '', prompt: 'do the thing' });
  assert.equal(cleanRoute({ kind: 'space', target: 'default/w1', prompt: '   ' }, ctx, 'in whistle fix it').prompt, 'in whistle fix it');
});

test('the router gathers spaces from the hub, with each space\'s folder from its agents', async () => {
  let asked = '';
  const hub = {
    spaces: () => [{ id: 'default/w1', label: 'whistle' }],
    agents: () => [{ spaceId: 'default/w1', cwd: '/code/whistle' }],
  };
  const folders = { list: () => ctx.folders, repos: async () => ctx.repos };
  const r = new Router({ hub, folders, run: async p => { asked = p; return { kind: 'space', target: 'default/w1', label: '', prompt: 'fix it' }; } });
  assert.deepEqual(await r.route('in whistle fix it'), { kind: 'space', spaceId: 'default/w1', where: 'whistle', label: '', prompt: 'fix it' });
  assert.ok(asked.includes('/code/whistle'));
});

test('the router still works when GitHub cannot be reached, and says unsure when the model fails', async () => {
  const hub = { spaces: () => [], agents: () => [] };
  const folders = { list: () => ctx.folders, repos: async () => { throw new Error('gh down'); } };
  const ok = new Router({ hub, folders, run: async () => ({ kind: 'folder', target: '/code/voice', label: '', prompt: 'p' }) });
  assert.equal((await ok.route('p')).kind, 'folder');
  const bad = new Router({ hub, folders, run: async () => { throw new Error('boom'); }, log: () => {} });
  assert.deepEqual(await bad.route('do it'), { kind: 'unsure', label: '', prompt: 'do it' });
});
