import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Uploads } from '../src/uploads.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-up-'));

test('saves an image under the folder with an extension from its type', () => {
  const dir = tmp();
  const u = new Uploads(dir);
  const p = u.save(Buffer.from('png-bytes'), 'image/png');
  assert.equal(path.dirname(p), dir);
  assert.match(path.basename(p), /^screenshot-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'png-bytes');
  assert.match(u.save(Buffer.from('x'), 'image/jpeg; charset=binary'), /\.jpg$/);
});

test('refuses types Claude cannot read and empty files', () => {
  const u = new Uploads(tmp());
  assert.throws(() => u.save(Buffer.from('x'), 'image/heic'), { code: 'bad_image' });
  assert.throws(() => u.save(Buffer.from('x'), 'text/plain'), { code: 'bad_image' });
  assert.throws(() => u.save(Buffer.alloc(0), 'image/png'), { code: 'bad_image' });
});

test('clears out uploads older than a week when saving', () => {
  const dir = tmp();
  const u = new Uploads(dir);
  const old = u.save(Buffer.from('a'), 'image/png');
  const weekAgo = (Date.now() - 8 * 86400_000) / 1000;
  fs.utimesSync(old, weekAgo, weekAgo);
  const fresh = u.save(Buffer.from('b'), 'image/png');
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});
