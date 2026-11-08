import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdBlocks } from '../public/md.js';

test('splits an answer into blocks: paragraphs, lists, code, headings', () => {
  const blocks = mdBlocks('First **bold** and `code`.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\n## Next\n\n1. a\n2. b');
  assert.deepEqual(blocks.map(b => b.tag), ['p', 'ul', 'pre', 'h3', 'ol']);
  assert.equal(blocks[0].html, 'First <strong>bold</strong> and <code>code</code>.');
  assert.equal(blocks[1].html, '<li>one</li><li>two</li>');
  assert.equal(blocks[2].html, 'const a = 1;');
  assert.equal(blocks[4].html, '<li>a</li><li>b</li>');
});

test('escapes HTML and only links http(s) URLs', () => {
  const [b] = mdBlocks('<script>x</script> [site](https://a.com) [bad](javascript:void0)');
  assert.equal(b.html, '&lt;script&gt;x&lt;/script&gt; <a href="https://a.com" target="_blank" rel="noopener">site</a> bad');
});

test('keeps the plain text of each block for quoting', () => {
  const [b] = mdBlocks('Use **this** one.');
  assert.equal(b.text, 'Use this one.');
});
