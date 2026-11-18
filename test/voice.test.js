import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingType, releaseOutcome, spokenDraft, routeTitle, autoGo } from '../public/voice.js';

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

test('a routed message reads as where it will go, and only safe places go by themselves', () => {
  assert.equal(routeTitle({ kind: 'space', where: 'whistle' }), 'New agent in whistle');
  assert.equal(routeTitle({ kind: 'folder', where: 'voice' }), 'New space in ~/Code/voice');
  assert.equal(routeTitle({ kind: 'init', where: 'tide-tables' }), 'New repo ~/Code/tide-tables');
  assert.equal(routeTitle({ kind: 'clone', where: 'me/hop' }), 'Clone me/hop');
  assert.equal(routeTitle({ kind: 'unsure' }), 'Where should this go?');
  assert.equal(autoGo({ kind: 'space' }), true);
  assert.equal(autoGo({ kind: 'folder' }), true);
  assert.equal(autoGo({ kind: 'init' }), false);
  assert.equal(autoGo({ kind: 'clone' }), false);
  assert.equal(autoGo({ kind: 'unsure' }), false);
});
