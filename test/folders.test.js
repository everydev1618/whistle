import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Folders } from '../src/folders.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-folders-'));
const touch = (dir, ms) => { fs.mkdirSync(dir, { recursive: true }); const t = new Date(ms); fs.utimesSync(dir, t, t); };

test('lists the code folders, most recently changed first, including the extra roots and skipping dot folders', () => {
  const root = tmp();
  touch(path.join(root, 'old'), 1_000_000);
  touch(path.join(root, 'new', '.git'), 2_000_000);
  touch(path.join(root, 'new'), 3_000_000);
  touch(path.join(root, '.hidden'), 4_000_000);
  touch(path.join(root, 'su', 'api'), 2_500_000);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  const f = new Folders({ root, extraRoots: [path.join(root, 'su')] });
  assert.deepEqual(f.list().map(d => [d.name, d.git]), [['new', true], ['su/api', false], ['old', false]]);
  assert.equal(f.list()[0].path, path.join(root, 'new'));
});

test('a new repo makes a folder under the root named after the space and runs git init in it', async () => {
  const root = tmp();
  const calls = [];
  const f = new Folders({ root, exec: async (cmd, args, opts) => { calls.push([cmd, args, opts.cwd]); return ''; } });
  const dir = await f.create('My Big Idea');
  assert.equal(dir, path.join(root, 'my-big-idea'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(calls, [['git', ['init', '-q'], dir]]);
});

test('a new repo refuses a name that is taken or empty', async () => {
  const root = tmp();
  touch(path.join(root, 'lighthouse'), 1_000_000);
  const f = new Folders({ root, exec: async () => '' });
  await assert.rejects(f.create('Lighthouse'), e => e.code === 'bad_folder' && /already/.test(e.message));
  await assert.rejects(f.create('  '), e => e.code === 'bad_folder');
  assert.equal(await f.create('../escape'), path.join(root, 'escape'), 'stays under the root');
});

test('lists GitHub repos from gh, recent first, marks the ones already on this Mac, and caches them', async () => {
  const root = tmp();
  touch(path.join(root, 'whistle'), 1_000_000);
  let n = 0;
  const exec = async (cmd, args) => {
    n++;
    assert.equal(cmd, 'gh');
    assert.equal(args[0], 'api');
    return JSON.stringify([
      [{ full_name: 'me/whistle', name: 'whistle', owner: { login: 'me' }, description: 'phone', private: true, pushed_at: '2026-11-10T00:00:00Z' }],
      [{ full_name: 'Acme/api', name: 'api', owner: { login: 'Acme' }, description: null, private: false, pushed_at: '2026-11-12T00:00:00Z' }],
    ]);
  };
  const f = new Folders({ root, exec, cloneRoots: { Acme: path.join(root, 'acme') } });
  const repos = await f.repos();
  assert.deepEqual(repos.map(r => [r.full, r.local, r.private]), [['Acme/api', null, false], ['me/whistle', path.join(root, 'whistle'), true]]);
  assert.equal(repos[0].description, '');
  await f.repos();
  assert.equal(n, 1, 'cached');
});

test('cloning puts the repo under the root (or its owner\'s root) and reuses a clone already there', async () => {
  const root = tmp();
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === 'repo') fs.mkdirSync(args[3], { recursive: true }); return ''; };
  const f = new Folders({ root, exec, cloneRoots: { Acme: path.join(root, 'acme') } });
  assert.equal(await f.clone('me/whistle'), path.join(root, 'whistle'));
  assert.equal(await f.clone('Acme/api'), path.join(root, 'acme', 'api'));
  assert.deepEqual(calls, [
    ['gh', 'repo', 'clone', 'me/whistle', path.join(root, 'whistle')],
    ['gh', 'repo', 'clone', 'Acme/api', path.join(root, 'acme', 'api')],
  ]);
  touch(path.join(root, 'hop', '.git'), 1_000_000);
  assert.equal(await f.clone('etdebruin/hop'), path.join(root, 'hop'));
  assert.equal(calls.length, 2, 'existing clone reused');
});

test('cloning refuses a bad repo name or a folder in the way that is not a git repo', async () => {
  const root = tmp();
  touch(path.join(root, 'taken'), 1_000_000);
  const f = new Folders({ root, exec: async () => '' });
  await assert.rejects(f.clone('nope'), e => e.code === 'bad_repo');
  await assert.rejects(f.clone('a/../../etc'), e => e.code === 'bad_repo');
  await assert.rejects(f.clone('me/taken'), e => e.code === 'bad_folder');
});

test('a failed clone says why', async () => {
  const root = tmp();
  const f = new Folders({ root, exec: async () => { throw Object.assign(new Error('x'), { stderr: 'GraphQL: Could not resolve to a Repository' }); } });
  await assert.rejects(f.clone('me/missing'), e => e.code === 'clone_failed' && /Could not resolve/.test(e.message));
});

test('extra folders and per-owner clone folders come from the environment, relative to the code root', async () => {
  const { foldersFromEnv } = await import('../src/folders.js');
  assert.deepEqual(foldersFromEnv({}, '/code'), { extraRoots: [], cloneRoots: {} });
  assert.deepEqual(
    foldersFromEnv({ WHISTLE_EXTRA_DIRS: 'work, /abs/other', WHISTLE_CLONE_DIRS: 'AcmeCo=work, Me=/abs/mine' }, '/code'),
    { extraRoots: ['/code/work', '/abs/other'], cloneRoots: { AcmeCo: '/code/work', Me: '/abs/mine' } },
  );
});
