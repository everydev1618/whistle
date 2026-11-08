// Screenshots sent from the phone. They land on this Mac so an agent can read
// them by path; anything older than a week is cleared out on the next save.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HerdrError } from './herdr.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const KEEP_MS = 7 * 86400_000;

export class Uploads {
  constructor(dir) { this.dir = dir; }

  save(buf, contentType = '') {
    const ext = EXT[contentType.split(';')[0].trim().toLowerCase()];
    if (!ext) throw new HerdrError('bad_image', 'Send a PNG, JPEG, GIF or WebP image.');
    if (!buf.length) throw new HerdrError('bad_image', 'The image is empty.');
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(this.dir, `screenshot-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  }

  prune(now = Date.now()) {
    for (const name of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, name);
      try { if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch { /* gone already */ }
    }
  }
}
