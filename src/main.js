import os from 'node:os';
import path from 'node:path';
import { Hub } from './hub.js';
import { findSessions } from './herdr.js';
import { createServer } from './server.js';
import { findClaudeDirs } from './claude.js';
import { loadVocab } from './vocab.js';
import { NextSteps, runClaude } from './nextsteps.js';
import { Prefs } from './prefs.js';
import { Marks } from './marks.js';
import { Queue } from './queue.js';
import { Uploads } from './uploads.js';
import { Folders } from './folders.js';

const home = os.homedir();
const herdrDir = process.env.HERDR_CONFIG_DIR || path.join(home, '.config', 'herdr');
const claudeDir = process.env.WHISTLE_CLAUDE_DIRS ? process.env.WHISTLE_CLAUDE_DIRS.split(',') : findClaudeDirs(home);
const port = Number(process.env.PORT || 7717);
const host = process.env.HOST || '127.0.0.1';
const stateDir = process.env.WHISTLE_STATE_DIR || path.join(home, '.config', 'whistle');
// New spaces live under ~/Code; Acme repos clone into ~/Code/su.
const codeRoot = process.env.WHISTLE_CODE_DIR || path.join(home, 'Code');
const folders = new Folders({ root: codeRoot, extraRoots: [path.join(codeRoot, 'su')], cloneRoots: { AcmeCo: path.join(codeRoot, 'su') } });
const allowedUsers = (process.env.WHISTLE_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

// Next-step buttons from Haiku via the `claude` CLI. WHISTLE_NEXT_STEPS=off turns them off.
const nextSteps = process.env.WHISTLE_NEXT_STEPS === 'off' ? null : new NextSteps({
  file: path.join(stateDir, 'nextsteps.json'),
  run: prompt => runClaude(prompt, { bin: process.env.WHISTLE_CLAUDE_BIN || 'claude', configDir: process.env.WHISTLE_CLAUDE_CONFIG_DIR }),
});

const hub = new Hub({ sessions: () => findSessions(herdrDir), claudeDir, vocab: loadVocab(claudeDir), nextSteps, queue: new Queue(path.join(stateDir, 'queue.json')) });
setInterval(() => { hub.vocab = loadVocab(claudeDir); }, 10 * 60 * 1000).unref();
hub.start();

createServer({ hub, folders, allowedUsers, prefs: new Prefs(path.join(stateDir, 'prefs.json')), marks: new Marks(path.join(stateDir, 'marks.json')), uploads: new Uploads(path.join(stateDir, 'uploads')) }).listen(port, host, () => {
  console.log(`whistle on http://${host}:${port}  herdr=${herdrDir}  claude=${claudeDir}  users=${allowedUsers.join(',') || 'any'}  next-steps=${nextSteps ? 'on' : 'off'}`);
});
