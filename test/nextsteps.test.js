import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextSteps, buildPrompt, cleanSuggestions } from '../src/nextsteps.js';

const ctx = {
  project: 'site',
  turn: { prompt: 'fix the slider', steps: [{ label: 'Edited slider.ts' }, { label: 'Ran npm test' }], answer: 'Fixed it. Tests pass.', files: { '/r/slider.ts': { added: 3, removed: 1 } } },
  existing: [{ label: 'Push it', text: 'push it' }],
  vocab: { examples: ['yes', 'send it', 'ship it'] },
};
const tick = () => new Promise(r => setImmediate(r));

test('the prompt carries the turn, the buttons already shown and the user\'s voice', () => {
  const p = buildPrompt(ctx);
  for (const s of ['fix the slider', 'Edited slider.ts', 'Fixed it. Tests pass.', 'slider.ts (+3 -1)', 'push it', 'send it', 'site']) assert.ok(p.includes(s), s);
});

test('long answers are kept to their tail', () => {
  const p = buildPrompt({ ...ctx, turn: { ...ctx.turn, answer: 'x'.repeat(10000) + 'THE END' } });
  assert.ok(p.includes('THE END'));
  assert.ok(p.length < 6000);
});

test('model output is cleaned: valid strings only, short labels, at most 3', () => {
  assert.deepEqual(cleanSuggestions({ suggestions: [
    { label: 'Add tests', text: 'add tests for it' },
    { label: '', text: 'x' },
    { label: 'L', text: 7 },
    { label: 'A very long label that keeps going on', text: 'b' },
    { label: 'C', text: 'c' },
    { label: 'D', text: 'd' },
  ] }), [
    { label: 'Add tests', text: 'add tests for it' },
    { label: 'A very long label that ke…', text: 'b' },
    { label: 'C', text: 'c' },
  ]);
  assert.deepEqual(cleanSuggestions(null), []);
  assert.deepEqual(cleanSuggestions({ suggestions: 'no' }), []);
});

test('asks once per turn, caches the answer and reports when it lands', async () => {
  const calls = [];
  const run = async prompt => { calls.push(prompt); return { suggestions: [{ label: 'Add tests', text: 'add tests' }] }; };
  const ns = new NextSteps({ run });
  const ready = [];
  assert.equal(ns.get('k1', ctx, () => ready.push('k1')), null);
  assert.equal(ns.get('k1', ctx, () => ready.push('again')), null);
  await tick();
  assert.deepEqual(ready, ['k1']);
  assert.deepEqual(ns.get('k1', ctx, () => ready.push('x')), [{ label: 'Add tests', text: 'add tests' }]);
  assert.equal(calls.length, 1);
});

test('a failed run caches nothing useful and is not retried for that turn', async () => {
  let n = 0;
  const ns = new NextSteps({ run: async () => { n++; throw new Error('boom'); }, log: () => {} });
  ns.get('k', ctx, () => {});
  await tick();
  assert.deepEqual(ns.get('k', ctx, () => {}), []);
  assert.equal(n, 1);
});

test('runs at most `concurrency` at once', async () => {
  let active = 0, peak = 0;
  const run = async () => { active++; peak = Math.max(peak, active); await tick(); await tick(); active--; return { suggestions: [] }; };
  const ns = new NextSteps({ run, concurrency: 2 });
  const done = [];
  for (const k of ['a', 'b', 'c', 'd', 'e']) ns.get(k, ctx, () => done.push(k));
  for (let i = 0; i < 20 && done.length < 5; i++) await tick();
  assert.equal(done.length, 5);
  assert.equal(peak, 2);
});
