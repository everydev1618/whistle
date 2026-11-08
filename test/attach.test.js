import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withImages } from '../public/attach.js';

test('adds each image path after the text so the agent reads them', () => {
  assert.equal(withImages('why is this red?', ['/u/a.png']), 'why is this red?\n\n[Image: /u/a.png]');
  assert.equal(withImages('', ['/u/a.png', '/u/b.png']), 'Look at these screenshots.\n\n[Image: /u/a.png]\n[Image: /u/b.png]');
  assert.equal(withImages('', ['/u/a.png']), 'Look at this screenshot.\n\n[Image: /u/a.png]');
  assert.equal(withImages('hi', []), 'hi');
});
