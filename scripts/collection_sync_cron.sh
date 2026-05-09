#!/usr/bin/env bash
# Headless sync wrapper for launchd / cron.
# Runs sync-history + sync-collections, appends one summary block to the log.
# Idempotent — incremental sync stops once it catches up to known articles.
#
# Logs to ${OE_MCP_LOG_DIR:-$HOME/.openevidence-mcp/logs}/sync.log
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${OE_MCP_LOG_DIR:-$HOME/.openevidence-mcp/logs}"
PYTHON="${OE_MCP_PYTHON:-python3}"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"

{
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==== $TS ===="
  echo "[sync-history]"
  "$PYTHON" scripts/collection_sort.py sync-history \
    || echo "  sync-history FAILED ($?)"
  echo "[sync-collections]"
  "$PYTHON" scripts/collection_sort.py sync-collections \
    || echo "  sync-collections FAILED ($?)"
  echo "[summary]"
  "$PYTHON" scripts/collection_sort.py summary
  echo
} >> "$LOG_DIR/sync.log" 2>&1
