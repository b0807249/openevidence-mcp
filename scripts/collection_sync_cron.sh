#!/usr/bin/env bash
# Headless sync wrapper for launchd / cron.
#
# Modes (via $1):
#   (default)   sync-history + sync-collections + summary
#   --dry-run   above + classify (writes proposed-plan.json, NO bulk-apply)
#   --auto      above + classify + bulk-apply (full autonomous sort)
#
# Idempotent everywhere — incremental sync stops on first all-known page;
# bulk-apply skips memberships already in the local DB.
#
# Logs to ${OE_MCP_LOG_DIR:-$HOME/.openevidence-mcp/logs}/sync.log
set -euo pipefail

MODE="${1:-default}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${OE_MCP_LOG_DIR:-$HOME/.openevidence-mcp/logs}"
PYTHON="${OE_MCP_PYTHON:-python3}"
THRESHOLD="${OE_MCP_AUTO_THRESHOLD:-12}"   # tighter default for headless
TOP_K="${OE_MCP_AUTO_TOP_K:-3}"
PLAN="$LOG_DIR/proposed-plan.json"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"

{
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "==== $TS  mode=$MODE ===="
  echo "[sync-history]"
  "$PYTHON" scripts/collection_sort.py sync-history \
    || echo "  sync-history FAILED ($?)"
  echo "[sync-collections]"
  "$PYTHON" scripts/collection_sort.py sync-collections \
    || echo "  sync-collections FAILED ($?)"

  if [ "$MODE" = "--dry-run" ] || [ "$MODE" = "--auto" ]; then
    echo "[classify  threshold=$THRESHOLD top_k=$TOP_K]"
    "$PYTHON" scripts/classify.py --threshold "$THRESHOLD" --top-k "$TOP_K" \
      classify --output "$PLAN" \
      || echo "  classify FAILED ($?)"
  fi
  if [ "$MODE" = "--auto" ]; then
    echo "[bulk-apply]"
    "$PYTHON" scripts/collection_sort.py --rate 0.5 bulk-apply "$PLAN" \
      || echo "  bulk-apply FAILED ($?)"
    echo "[sync-collections again — reconcile]"
    "$PYTHON" scripts/collection_sort.py sync-collections \
      || echo "  reconcile FAILED ($?)"
  fi

  echo "[summary]"
  "$PYTHON" scripts/collection_sort.py summary
  echo
} >> "$LOG_DIR/sync.log" 2>&1
