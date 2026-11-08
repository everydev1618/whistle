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

Expose it to the tailnet (HTTPS, tailnet-only):

```sh
tailscale serve --bg 7717
WHISTLE_ALLOWED_USERS=<your tailscale login> npm start
```

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

`:id` is `<session>/<pane>`, URL-encoded, e.g. `default%2FwY%3Ap1`.
