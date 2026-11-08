#!/bin/bash
# Install the daily 6 AM board-meeting launchd agent on macOS. Run from the repo root:
#   bash scripts/schedule-macos.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found — run: brew install node"; exit 1; fi

AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/com.seen-command.agent.plist"
mkdir -p "$AGENTS"

# Fill the template with this machine's real paths.
sed -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g" "$REPO/deploy/com.seen-command.agent.plist" > "$PLIST"

# Reload (unload first so re-running is safe/idempotent).
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✔ Installed: $PLIST"
echo "  Runs the board meeting daily at 6:00 AM. Logs → $REPO/data/run.log"
echo "  Run now:   launchctl start com.seen-command.agent"
echo "  Status:    launchctl list | grep seen-command"
echo "  Remove:    launchctl unload \"$PLIST\""
echo
echo "To keep the Mac awake with the lid shut (on power):  sudo pmset -c disablesleep 1"
