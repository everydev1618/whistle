import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcriber, cleanTranscript } from '../src/transcribe.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-tx-'));
const model = () => { const p = path.join(tmp(), 'model.bin'); fs.writeFileSync(p, 'm'); return p; };

test('cleanTranscript joins lines and drops whisper noise markers', () => {
  assert.equal(cleanTranscript(' Add a dark mode toggle.\n And push it.\n'), 'Add a dark mode toggle. And push it.');
  assert.equal(cleanTranscript('[BLANK_AUDIO]\n'), '');
  assert.equal(cleanTranscript(' (music) Fix the login bug [inaudible]'), 'Fix the login bug');
  assert.equal(cleanTranscript(''), '');
});

test('converts the recording with ffmpeg, then runs whisper on the wav', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'ffmpeg') { fs.writeFileSync(args.at(-1), 'wav'); return ''; }
    return ' Ship it.\n';
  };
  const t = new Transcriber({ model: model(), dir: tmp(), run });
  assert.equal(await t.transcribe(Buffer.from('audio'), 'audio/mp4'), 'Ship it.');
  const [ff, wh] = calls;
  assert.equal(ff[0], 'ffmpeg');
  assert.ok(ff[1].includes('16000'));
  assert.equal(wh[0], 'whisper-cli');
  assert.equal(wh[1][wh[1].indexOf('-f') + 1], ff[1].at(-1));
  assert.ok(wh[1].includes('-nt'));
});

test('cleans up its temp files, even when whisper fails', async () => {
  const dir = tmp();
  const ok = new Transcriber({ model: model(), dir, run: async (bin, args) => { if (bin === 'ffmpeg') fs.writeFileSync(args.at(-1), 'w'); return 'hi'; } });
  await ok.transcribe(Buffer.from('a'), 'audio/webm');
  const bad = new Transcriber({ model: model(), dir, run: async bin => { if (bin !== 'ffmpeg') throw new Error('boom'); } });
  await assert.rejects(bad.transcribe(Buffer.from('a'), 'audio/webm'), { code: 'transcribe_failed' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('refuses empty or non-audio bodies', async () => {
  const t = new Transcriber({ model: model(), dir: tmp(), run: async () => '' });
  await assert.rejects(t.transcribe(Buffer.alloc(0), 'audio/mp4'), { code: 'bad_audio' });
  await assert.rejects(t.transcribe(Buffer.from('x'), 'image/png'), { code: 'bad_audio' });
});

test('says where the model should be when it is missing', async () => {
  const t = new Transcriber({ model: '/nope/model.bin', dir: tmp(), run: async () => '' });
  await assert.rejects(t.transcribe(Buffer.from('x'), 'audio/mp4'), e => e.code === 'voice_off' && e.message.includes('/nope/model.bin'));
});

test('whisper\'s usual words for silence count as nothing said', () => {
  for (const ghost of ['you', ' You.', 'Thank you.', 'Thanks for watching!', '.', 'Bye.']) assert.equal(cleanTranscript(ghost), '', ghost);
  assert.equal(cleanTranscript('Thank you, now push it.'), 'Thank you, now push it.');
});
