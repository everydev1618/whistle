import os from 'node:os';
import path from 'node:path';
import { Hub } from './hub.js';
import { findSessions } from './herdr.js';
import { createServer } from './server.js';
import { findClaudeDirs } from './claude.js';

const home = os.homedir();
const herdrDir = process.env.HERDR_CONFIG_DIR || path.join(home, '.config', 'herdr');
const claudeDir = process.env.WHISTLE_CLAUDE_DIRS ? process.env.WHISTLE_CLAUDE_DIRS.split(',') : findClaudeDirs(home);
const port = Number(process.env.PORT || 7717);
const host = process.env.HOST || '127.0.0.1';
const allowedUsers = (process.env.WHISTLE_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

const hub = new Hub({ sessions: () => findSessions(herdrDir), claudeDir });
hub.start();

createServer({ hub, allowedUsers }).listen(port, host, () => {
  console.log(`whistle on http://${host}:${port}  herdr=${herdrDir}  claude=${claudeDir}  users=${allowedUsers.join(',') || 'any'}`);
});
