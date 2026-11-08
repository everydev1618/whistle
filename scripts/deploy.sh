#!/bin/sh
# Deploy Whistle on this Mac: test, lint, (re)install the LaunchAgent, restart it,
# and wait until it answers. Run with `npm run deploy`.
set -eu
cd "$(dirname "$0")/.."

LABEL=ai.whistle.server
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "→ tests"
npm test --silent >/dev/null 2>&1 || { npm test; exit 1; }
echo "→ lint"
npm run lint --silent

if ! cmp -s "deploy/$LABEL.plist" "$PLIST"; then
  echo "→ installing LaunchAgent (config changed)"
  cp "deploy/$LABEL.plist" "$PLIST"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  i=0
  while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  launchctl bootstrap "$DOMAIN" "$PLIST"
else
  echo "→ restarting"
  launchctl kickstart -k "$DOMAIN/$LABEL"
fi

PORT=$(plutil -extract EnvironmentVariables.PORT raw "$PLIST" 2>/dev/null || echo 7717)
i=0
until code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") && { [ "$code" = 200 ] || [ "$code" = 403 ]; }; do
  i=$((i + 1))
  if [ $i -ge 20 ]; then
    echo "✗ Whistle did not come up on port $PORT. Last log lines:" >&2
    tail -20 "$HOME/Library/Logs/whistle.log" >&2
    exit 1
  fi
  sleep 0.5
done

PID=$(launchctl print "$DOMAIN/$LABEL" | awk '/pid =/{print $3}')
echo "✓ Whistle is up on port $PORT (pid $PID, $(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo ', uncommitted changes'))"
