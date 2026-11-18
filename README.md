# Whistle

Steer your herdr agents from your phone with taps instead of a terminal.

Whistle runs on the Mac where [herdr](https://herdr.dev) runs. It reads every herdr session's
socket, finds each Claude pane's transcript, and serves a small API to the phone.
Your desk terminal stays the same session: the phone only sends input through herdr.

## Run

```sh
npm start                 # http://127.0.0.1:7717
npm test && npm run lint
```

## Running it for real

It runs as a LaunchAgent and is reached over [Tailscale](https://tailscale.com): `tailscale serve`
gives it an HTTPS address on your tailnet only (HTTPS matters: the phone won't share its
microphone otherwise), and `WHISTLE_ALLOWED_USERS` limits it to your Tailscale login.

```sh
cp deploy/ai.whistle.server.plist.example deploy/ai.whistle.server.plist   # once; fill in your paths and login (gitignored)
```

```sh
npm run deploy               # test, lint, install/restart the LaunchAgent, wait until it answers
tail -f ~/Library/Logs/whistle.log
tailscale serve --bg 7717    # once; `tailscale serve --https=443 off` to undo
```

The phone picks up a deploy by itself: the event stream reconnects with a new app version
(a fingerprint of `public/`), and the app reloads, or offers a Reload button if you're typing.
Pull down on either screen to reload by hand; the home-screen app has no browser controls.

`npm run deploy` reinstalls the LaunchAgent when `deploy/ai.whistle.server.plist` changed and
otherwise just restarts it. It stops before restarting if tests or lint fail.

UI changes in `public/` need no restart, just a reload. On the iPhone: open the URL in Safari,
Share → Add to Home Screen.

| Env | Default | |
|---|---|---|
| `PORT` | `7717` | |
| `HOST` | `127.0.0.1` | keep it local; `tailscale serve` is the way in |
| `HERDR_CONFIG_DIR` | `~/.config/herdr` | default session + `sessions/<name>/` |
| `WHISTLE_CLAUDE_DIRS` | every `~/.claude` and `~/.claude-*` | comma-separated |
| `WHISTLE_ALLOWED_USERS` | anyone | checked against `Tailscale-User-Login` |
| `WHISTLE_STATE_DIR` | `~/.config/whistle` | per-user settings (`prefs.json`), seen/done marks (`marks.json`), queued messages (`queue.json`), cached Haiku suggestions (`nextsteps.json`), screenshots from the phone (`uploads/`, cleared after a week) |
| `WHISTLE_NEXT_STEPS` | on | `off` disables the Haiku next-step buttons |
| `WHISTLE_VOICE` | on | `off` turns hold-to-talk off |
| `WHISTLE_WHISPER_MODEL` | `<state dir>/models/ggml-large-v3-turbo-q5_0.bin` | |
| `WHISTLE_WHISPER_BIN` | `whisper-cli` | |
| `WHISTLE_CODE_DIR` | `~/Code` | where New space finds folders and makes or clones repos |
| `WHISTLE_EXTRA_DIRS` | none | more folders to list, e.g. `work, /abs/path` (relative to the code dir) |
| `WHISTLE_CLONE_DIRS` | none | clone an owner's repos elsewhere, e.g. `YourOrg=work` |
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
| `GET /api/agents` | all agents and spaces (herdr workspaces) across sessions, plus which sessions are running |
| `POST /api/spaces/:id/agents` | `{ "label", "prompt" }` → new tab in that space, in its agents' folder, starts Claude, sends the first prompt; `{ "id" }` |
| `GET /api/agents/:id` | agent + parsed transcript (turns, steps, answer, files, pending question) |
| `POST /api/agents/:id/prompt` | `{ "text": "push it" }` → `agent.prompt` |
| `POST /api/agents/:id/keys` | `{ "keys": ["esc"] }` → `agent.send_keys` |
| `POST /api/agents/:id/queue` | `{ "text" }` → held until the agent finishes its turn, then sent |
| `DELETE /api/agents/:id/queue/:item` | cancel a queued message |
| `POST /api/transcribe` | raw audio body (`audio/mp4` from iPhone, `audio/webm`, ≤25 MB) → `{ "text" }`, via whisper.cpp on this Mac. Empty text means nothing was said |
| `POST /api/route` | `{ "text" }` → where something said on the home screen goes, picked by Haiku and checked against what's here: `{ kind: "space", spaceId }`, `{ kind: "folder", cwd }`, `{ kind: "init" }`, `{ kind: "clone", repo }` or `{ kind: "unsure" }`, each with `where`, `label` and `prompt` (what you said minus the routing words). Off when voice or next steps are off |
| `POST /api/uploads` | raw image body (`content-type: image/png\|jpeg\|gif\|webp`, ≤25 MB) → `{ "path" }` on this Mac. The app adds `[Image: <path>]` lines to the prompt so the agent reads it |
| `GET /api/events` | SSE: `snapshot`, then `change` (added / changed / removed / spaces) |
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

## Hold to talk

A space's page has a **Hold to talk** bar; each agent's composer has a mic. Hold, talk, let go.
The phone records, `POST /api/transcribe` runs ffmpeg (to 16 kHz wav) then whisper.cpp, and the text
goes out: in a space it starts a new agent with it as the first message; in an agent it's added
after anything typed and sent (or queued, if the agent is working). Slide off the button to cancel.
About 1s for a short message once the model is warm. Whisper's usual words for silence ("you",
"Thank you.") count as nothing said.

**Tap to brainstorm.** Tap any of the three mics instead of holding it and it keeps listening
hands-free until you tap it again or press Send (Cancel throws it away). The screen stays awake
meanwhile, since a locked phone stops the mic. What you said goes out with a note asking Claude to
think it through with you and change nothing until you say go; in a space the new tab is named
Brainstorm. On the home screen, a brainstorm that fits no space, folder or repo comes back as a new
repo named for the idea ("New repo ~/Code/tide-alerts"); change the name on the card, then tap to start it.
Two minutes of talk transcribes in about 3s; the limit is 15 minutes per step.

The home screen has one too, for anything: "in whistle, make the toast stay longer", "start a new
repo called tide tables and scaffold a node server", "clone hop and add a high score". Haiku gets
what you said plus every space, folder in ~/Code and GitHub repo (`POST /api/route`), and a card
says where it'll go with the message minus the routing words. A space, or a folder that gets a new
space, starts by itself after 3 seconds unless you touch the card; a new repo or a clone waits for
a tap. If it can't tell, the card asks you to pick a space or make a new one.

Setup on the Mac, once:

```sh
brew install whisper-cpp ffmpeg
mkdir -p ~/.config/whistle/models && curl -L -o ~/.config/whistle/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

## Queue

While an agent is working, the composer queues instead of sending, so a message never
lands in the middle of a turn. The hub sends the first queued message once the agent is
done or idle, then waits until it has seen the agent working again (or a minute passes)
before sending the next. Queues are saved to `queue.json` in the state dir, wait while the
agent asks a question, and are dropped only when the agent's pane is gone from a running
herdr session.

## Questions

Claude writes an AskUserQuestion to its transcript only after it is answered. While it waits,
herdr reports `blocked` and Whistle parses the question off the screen (`src/screen.js`).
Pressing the option's number answers it, so a tap sends that one key.

`:id` is `<session>/<pane>`, URL-encoded, e.g. `default%2FwY%3Ap1`.
