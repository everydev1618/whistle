import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingType, releaseOutcome, spokenDraft } from '../public/voice.js';

test('records in the first type the browser supports', () => {
  assert.equal(recordingType(t => t === 'audio/mp4'), 'audio/mp4'); // iPhone Safari
  assert.equal(recordingType(t => t.startsWith('audio/webm')), 'audio/webm;codecs=opus'); // Chrome
  assert.equal(recordingType(() => false), '');
});

test('a quick tap is not a recording, sliding away cancels, otherwise it sends', () => {
  assert.equal(releaseOutcome({ ms: 200, dx: 0, dy: 0 }), 'short');
  assert.equal(releaseOutcome({ ms: 2000, dx: 0, dy: -120 }), 'cancel');
  assert.equal(releaseOutcome({ ms: 2000, dx: 100, dy: 0 }), 'cancel');
  assert.equal(releaseOutcome({ ms: 2000, dx: 20, dy: -30 }), 'send');
});

test('spoken words follow anything already typed', () => {
  assert.equal(spokenDraft('', 'Ship it.'), 'Ship it.');
  assert.equal(spokenDraft('Look at the header ', 'and make it sticky.'), 'Look at the header and make it sticky.');
  assert.equal(spokenDraft('> quoted\n\nWhy? ', 'Explain the cache.'), '> quoted\n\nWhy? Explain the cache.');
});
