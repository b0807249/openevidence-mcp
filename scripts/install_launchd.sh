#!/usr/bin/env bash
# Install (or re-install) the macOS launchd job that syncs OpenEvidence chat
# history + collections into the local SQLite mirror once a day at 02:00.
#
# Run from the repo root:  bash scripts/install_launchd.sh
# Uninstall:               bash scripts/install_launchd.sh --uninstall
set -euo pipefail

LABEL="com.htlin.openevidence-mcp.sync"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO_DIR/scripts/collection_sync_cron.sh"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/.openevidence-mcp/logs"
HOUR="${OE_MCP_SYNC_HOUR:-2}"
MINUTE="${OE_MCP_SYNC_MINUTE:-0}"
MODE="${OE_MCP_SYNC_MODE:-}"   # empty=sync-only, --dry-run, or --auto

uninstall() {
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $PLIST"
  else
    echo "no plist at $PLIST"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

if [ ! -x "$WRAPPER" ]; then
  chmod +x "$WRAPPER"
fi
mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WRAPPER</string>$([ -n "$MODE" ] && printf '\n    <string>%s</string>' "$MODE")
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.stderr.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

# Reload (unload first to pick up edits)
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "installed $PLIST"
echo "label:    $LABEL"
echo "schedule: ${HOUR}:$(printf '%02d' "$MINUTE") daily"
echo "mode:     ${MODE:-sync-only}"
echo "logs:     $LOG_DIR/sync.log"
echo
echo "test now:"
echo "  launchctl start $LABEL && sleep 25 && tail -30 $LOG_DIR/sync.log"
echo
echo "to switch modes:"
echo "  OE_MCP_SYNC_MODE=--dry-run $0   # syncs + writes proposed plan, no apply"
echo "  OE_MCP_SYNC_MODE=--auto    $0   # full autonomous sort (sync + classify + apply)"
