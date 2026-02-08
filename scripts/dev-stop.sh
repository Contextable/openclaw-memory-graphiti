#!/usr/bin/env bash
# -------------------------------------------------------------------
# dev-stop.sh — Stop all dev services
# -------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.dev"

stop_service() {
  local name="$1"
  local pidfile="$DEV_DIR/pids/${name}.pid"

  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      echo "==> Stopping $name (pid $pid)..."
      kill "$pid"
      # Wait up to 5 seconds for graceful shutdown
      for _ in $(seq 1 10); do
        if ! kill -0 "$pid" 2>/dev/null; then
          break
        fi
        sleep 0.5
      done
      # Force kill if still running
      if kill -0 "$pid" 2>/dev/null; then
        echo "    Force-killing $name..."
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "    $name stopped."
    else
      echo "==> $name not running (stale pid file)."
    fi
    rm -f "$pidfile"
  else
    echo "==> $name not running (no pid file)."
  fi
}

stop_service "graphiti"
stop_service "spicedb"
stop_service "falkordb"

echo ""
echo "==> All services stopped."
