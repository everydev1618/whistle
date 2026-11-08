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
| `WHISTLE_STATE_DIR` | `~/.config/whistle` | per-user settings (`prefs.json`), seen/done marks (`marks.json`), cached Haiku suggestions (`nextsteps.json`) |
| `WHISTLE_NEXT_STEPS` | on | `off` disables the Haiku next-step buttons |
| `WHISTLE_CLAUDE_BIN` | `claude` | CLI used for next steps |
| `WHISTLE_CLAUDE_CONFIG_DIR` | inherited | which Claude login the CLI uses |

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
| `GET /api/marks`, `POST /api/marks` | which agents you've seen / marked done, per turn: `{ "id", "kind": "seen"\|"done"\|"undone", "turn" }` |
| `GET` / `PUT /api/prefs` | the caller's settings, e.g. `{ "filter": "Work" }`, keyed by Tailscale login |

Each agent carries `summary`, `lastPrompt`, `live` (current step), `question` (when blocked)
and `suggestions` (buttons that send `text` as a prompt or `keys` as key presses).

## Reply buttons

Three layers, merged in this order (max 4, no repeats):

1. **The agent's state** (`src/suggest.js`): question options (sent as number keys), offers
   ("Want me to deploy it?" → **Yes, deploy it**; "push now or wait?" → one button each),
   push when files changed and nothing was pushed, deploy once pushed.
2. **Your wording** (`src/vocab.js`): learned from every `history.jsonl`, e.g. how you say push,
   and how each project gets deployed ("deploy it to vercel at pace.example.com", "ship it").
3. **Next steps from Claude Haiku 5.5** (`src/nextsteps.js`): when an agent finishes a turn, one
   `claude -p` call (structured JSON, no tools, no session saved) reads the turn and suggests up
   to 3 prompts in your voice. Cached per turn on disk (survives restarts; failures are retried), 2 at a time. About 2s and $0.0003 each.

In the session view a model button shows the prompt it will send; long-press any button to
edit its text before sending.

## Questions

Claude writes an AskUserQuestion to its transcript only after it is answered. While it waits,
herdr reports `blocked` and Whistle parses the question off the screen (`src/screen.js`).
Pressing the option's number answers it, so a tap sends that one key.

`:id` is `<session>/<pane>`, URL-encoded, e.g. `default%2FwY%3Ap1`.
