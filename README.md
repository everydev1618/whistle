# Whistle

Steer your herdr agents from your phone with taps instead of a terminal.

Whistle runs on the Mac where herdr runs (my-mac). It reads every herdr session's
socket, finds each Claude pane's transcript, and serves a small API to the phone.
Your desk terminal stays the same session: the phone only sends input through herdr.

## Run

```sh
npm start                 # http://127.0.0.1:7717
npm test && npm run lint
```

## Running on my-mac

It runs as a LaunchAgent and is served on the tailnet at **https://your-mac.your-tailnet.ts.net**
(tailnet only, locked to `you@example.com`).

```sh
cp deploy/ai.whistle.server.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.whistle.server.plist
launchctl kickstart -k gui/$(id -u)/ai.whistle.server   # restart after server changes
tail -f ~/Library/Logs/whistle.log
tailscale serve --bg 7717                                 # once; `tailscale serve --https=443 off` to undo
```

UI changes in `public/` need no restart, just a reload. On the iPhone: open the URL in Safari,
Share → Add to Home Screen.

| Env | Default | |
|---|---|---|
| `PORT` | `7717` | |
| `HOST` | `127.0.0.1` | keep it local; `tailscale serve` is the way in |
| `HERDR_CONFIG_DIR` | `~/.config/herdr` | default session + `sessions/<name>/` |
| `WHISTLE_CLAUDE_DIRS` | every `~/.claude` and `~/.claude-*` | comma-separated |
| `WHISTLE_ALLOWED_USERS` | anyone | checked against `Tailscale-User-Login` |

## How a pane becomes a transcript

`pane.process_info` gives the pane's `claude` pid. `<claude dir>/sessions/<pid>.json`
gives its `sessionId`. The transcript is `<claude dir>/projects/*/<sessionId>.jsonl`.
Each herdr session can use its own `CLAUDE_CONFIG_DIR`, so every `~/.claude*` folder is searched.

herdr's socket takes one JSON request per connection. Agent-status subscriptions are
per pane, so Whistle polls `agent.list` on every session every 1.5s and diffs.

## API

| | |
|---|---|
| `GET /api/agents` | all agents across sessions, plus which sessions are running |
| `GET /api/agents/:id` | agent + parsed transcript (turns, steps, answer, files, pending question) |
| `POST /api/agents/:id/prompt` | `{ "text": "push it" }` → `agent.prompt` |
| `POST /api/agents/:id/keys` | `{ "keys": ["esc"] }` → `agent.send_keys` |
| `GET /api/events` | SSE: `snapshot`, then `change` (added / changed / removed) |

Each agent carries `summary`, `lastPrompt`, `live` (current step), `question` (when blocked)
and `suggestions` (buttons that send `text` as a prompt or `keys` as key presses).

## Questions

Claude writes an AskUserQuestion to its transcript only after it is answered. While it waits,
herdr reports `blocked` and Whistle parses the question off the screen (`src/screen.js`).
Pressing the option's number answers it, so a tap sends that one key.

`:id` is `<session>/<pane>`, URL-encoded, e.g. `default%2FwY%3Ap1`.
