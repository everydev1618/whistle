// Hold-to-talk: the phone records, this Mac turns it into text with whisper.cpp.
// ffmpeg first, because whisper only reads wav/mp3/flac and iPhones record AAC in mp4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HerdrError } from './herdr.js';

export function runCmd(bin, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

// whisper prints the text on stdout; silence comes back as [BLANK_AUDIO], noises as (music).
// On silence whisper also makes up a word or two ("you", "Thank you."); those count as nothing.
const GHOSTS = new Set(['', 'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'so']);

export function cleanTranscript(out) {
  const text = String(out || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return GHOSTS.has(text.toLowerCase().replace(/[^a-z ]/g, '').trim()) ? '' : text;
}

export class Transcriber {
  constructor({ model, whisper = 'whisper-cli', ffmpeg = 'ffmpeg', language = 'en', dir = os.tmpdir(), run = runCmd }) {
    Object.assign(this, { model, whisper, ffmpeg, language, dir, run });
  }

  async transcribe(buf, contentType = '') {
    if (!/^(audio|video)\//i.test(contentType)) throw new HerdrError('bad_audio', 'Send an audio recording.');
    if (!buf.length) throw new HerdrError('bad_audio', 'The recording is empty.');
    if (!fs.existsSync(this.model)) throw new HerdrError('voice_off', `No whisper model at ${this.model}.`);
    const stem = path.join(this.dir, `whistle-voice-${crypto.randomBytes(4).toString('hex')}`);
    const input = `${stem}.in`, wav = `${stem}.wav`;
    try {
      fs.writeFileSync(input, buf);
      await this.run(this.ffmpeg, ['-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      return cleanTranscript(await this.run(this.whisper, ['-m', this.model, '-f', wav, '-l', this.language, '-nt', '-np']));
    } catch (e) {
      if (e instanceof HerdrError) throw e;
      throw new HerdrError('transcribe_failed', `Couldn't transcribe that: ${(e.stderr || e.message || '').trim().split('\n').pop()}`);
    } finally {
      for (const f of [input, wav]) fs.rmSync(f, { force: true });
    }
  }
}
