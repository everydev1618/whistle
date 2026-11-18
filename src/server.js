// HTTP API for the phone. Meant to sit on 127.0.0.1 behind `tailscale serve`,
// which adds the Tailscale-User-Login header we check against allowedUsers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { HerdrError } from './herdr.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const STATUS_FOR = { voice_off: 503, route_off: 503, agent_blocked: 409, agent_not_ready: 409, agent_not_found: 404, not_found: 404, unreachable: 503, timeout: 504 };

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, code, errCode, message) => send(res, code, { error: { code: errCode, message } });

// A fingerprint of every file in the app folder. The phone compares it across
// reconnects and reloads itself when a deploy changed the app.
export function appVersion(dir = PUBLIC) {
  const hash = crypto.createHash('sha1');
  const walk = d => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else hash.update(path.relative(dir, p)).update('\0').update(fs.readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HerdrError('too_large', 'request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 64 * 1024);
  try { return JSON.parse(body.toString() || '{}'); } catch { throw new HerdrError('bad_json', 'body is not JSON'); }
}

export function createServer({ hub, folders = null, allowedUsers = [], prefs = null, marks = null, uploads = null, transcriber = null, router = null, version = appVersion(), log = console.log }) {
  return http.createServer(async (req, res) => {
    if (allowedUsers.length && !allowedUsers.includes(req.headers['tailscale-user-login'])) {
      return fail(res, 403, 'forbidden', 'This tailnet user is not allowed.');
    }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] !== 'api') return serveStatic(url.pathname, res);

      if (req.method === 'GET' && parts[1] === 'agents' && parts.length === 2) {
        return send(res, 200, { agents: hub.agents(), sessions: hub.sessions?.() ?? [], spaces: hub.spaces?.() ?? [], version });
      }
      if (req.method === 'GET' && parts[1] === 'events' && parts.length === 2) return events(req, res, hub, version);

      if (parts[1] === 'prefs' && parts.length === 2 && prefs) {
        const user = req.headers['tailscale-user-login'] || '';
        if (req.method === 'GET') return send(res, 200, prefs.get(user));
        if (req.method === 'PUT') return send(res, 200, prefs.set(user, await readJson(req)));
      }

      if (req.method === 'POST' && parts[1] === 'uploads' && parts.length === 2 && uploads) {
        const file = uploads.save(await readBody(req, 25 * 1024 * 1024), req.headers['content-type']);
        log(`${req.headers['tailscale-user-login'] || 'local'} uploaded ${path.basename(file)}`);
        return send(res, 201, { path: file });
      }

      if (req.method === 'POST' && parts[1] === 'transcribe' && parts.length === 2) {
        if (!transcriber) return fail(res, 503, 'voice_off', 'Voice is off on this Mac.');
        const text = await transcriber.transcribe(await readBody(req, 25 * 1024 * 1024), req.headers['content-type'] || '');
        log(`${req.headers['tailscale-user-login'] || 'local'} spoke ${JSON.stringify(text.slice(0, 80))}`);
        return send(res, 200, { text });
      }

      if (req.method === 'POST' && parts[1] === 'route' && parts.length === 2) {
        if (!router) return fail(res, 503, 'route_off', 'Routing is off on this Mac.');
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'empty_prompt', 'Nothing to route.');
        const route = await router.route(text.trim());
        log(`${req.headers['tailscale-user-login'] || 'local'} routed ${JSON.stringify(text.slice(0, 80))} → ${route.kind} ${route.where || ''}`);
        return send(res, 200, route);
      }

      if (req.method === 'POST' && parts[1] === 'spaces' && parts.length === 2) {
        const body = await readJson(req);
        const { session = '', label = '', prompt = '', init = false, clone = '' } = body;
        let { cwd = '' } = body;
        if (![session, label, cwd, prompt, clone].every(v => typeof v === 'string')) return fail(res, 400, 'bad_space', 'session, label, cwd, prompt and clone must be text.');
        if ((init || clone) && !folders) return fail(res, 400, 'bad_space', 'Making folders is off.');
        if (init) cwd = await folders.create(label);
        else if (clone) cwd = await folders.clone(clone);
        const made = await hub.newSpace({ session, label, cwd, prompt });
        log(`${req.headers['tailscale-user-login'] || 'local'} new space ${made.spaceId} in ${cwd}`);
        return send(res, 201, made);
      }

      if (req.method === 'GET' && parts[1] === 'folders' && parts.length === 2 && folders) return send(res, 200, { root: folders.root, folders: folders.list() });
      if (req.method === 'GET' && parts[1] === 'repos' && parts.length === 2 && folders) return send(res, 200, { repos: await folders.repos() });

      if (req.method === 'DELETE' && parts[1] === 'spaces' && parts[2] && parts.length === 3) {
        const spaceId = decodeURIComponent(parts[2]);
        await hub.closeSpace(spaceId);
        log(`${req.headers['tailscale-user-login'] || 'local'} closed space ${spaceId}`);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && parts[1] === 'spaces' && parts[2] && parts[3] === 'agents' && parts.length === 4) {
        const spaceId = decodeURIComponent(parts[2]);
        const { label = '', prompt = '' } = await readJson(req);
        if (typeof label !== 'string' || typeof prompt !== 'string') return fail(res, 400, 'bad_agent', 'label and prompt must be text.');
        const made = await hub.newAgent(spaceId, { label, prompt });
        log(`${req.headers['tailscale-user-login'] || 'local'} → ${spaceId} new agent ${made.id} ${JSON.stringify(label || prompt.slice(0, 60))}`);
        return send(res, 201, made);
      }

      if (parts[1] === 'marks' && parts.length === 2 && marks) {
        const user = req.headers['tailscale-user-login'] || '';
        if (req.method === 'GET') return send(res, 200, marks.get(user));
        if (req.method === 'POST') {
          const { id, kind, turn } = await readJson(req);
          try { return send(res, 200, marks.mark(user, id, kind, turn)); } catch (e) { return fail(res, 400, 'bad_mark', e.message); }
        }
      }

      if (parts[1] === 'agents' && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        const who = req.headers['tailscale-user-login'] || 'local';
        const said = t => JSON.stringify(t.length > 80 ? t.slice(0, 79) + '…' : t);
        if (req.method === 'GET' && parts.length === 3) {
          const d = await hub.detail(id);
          return d ? send(res, 200, d) : fail(res, 404, 'not_found', `No agent ${id}`);
        }
        if (req.method === 'POST' && parts[3] === 'prompt') {
          const { text } = await readJson(req);
          if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'empty_prompt', 'Prompt text is empty.');
          await hub.prompt(id, text);
          log(`${who} → ${id} prompt ${said(text)}`);
          return send(res, 202, { ok: true });
        }
        if (req.method === 'POST' && parts[3] === 'queue' && parts.length === 4) {
          const { text } = await readJson(req);
          if (typeof text !== 'string') return fail(res, 400, 'bad_queue', 'text must be a string.');
          const item = hub.enqueue(id, text);
          log(`${who} → ${id} queue ${said(text)}`);
          return send(res, 201, item);
        }
        if (req.method === 'DELETE' && parts[3] === 'queue' && parts.length === 5) {
          return hub.unqueue(id, decodeURIComponent(parts[4])) ? send(res, 200, { ok: true }) : fail(res, 404, 'not_found', 'No such queued message.');
        }
        if (req.method === 'POST' && parts[3] === 'keys') {
          const { keys } = await readJson(req);
          if (!Array.isArray(keys) || !keys.length || !keys.every(k => typeof k === 'string')) return fail(res, 400, 'bad_keys', 'keys must be a list of key names.');
          await hub.keys(id, keys);
          log(`${who} → ${id} keys ${keys.join(' ')}`);
          return send(res, 202, { ok: true });
        }
      }
      return fail(res, 404, 'not_found', 'No such endpoint.');
    } catch (e) {
      if (e instanceof HerdrError) {
        const code = STATUS_FOR[e.code] ?? (['too_large', 'bad_json', 'bad_queue', 'bad_image', 'bad_audio', 'bad_folder', 'bad_space', 'bad_repo'].includes(e.code) ? 400 : 502);
        return fail(res, code, e.code, e.message);
      }
      console.error(e);
      return fail(res, 500, 'internal', 'Something broke in whistle. Check its log.');
    }
  });
}

function events(req, res, hub, version) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('snapshot', { agents: hub.agents(), sessions: hub.sessions?.() ?? [], spaces: hub.spaces?.() ?? [], version });
  const onChange = ev => write('change', ev);
  hub.on('change', onChange);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); hub.off('change', onChange); });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 404, 'not_found', 'Not found.');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'not_found', 'Not found.');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}
