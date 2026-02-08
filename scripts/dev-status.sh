#!/usr/bin/env bash
# -------------------------------------------------------------------
# dev-status.sh — Check status of dev services
# -------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.dev"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

check_service() {
  local name="$1"
  local pidfile="$DEV_DIR/pids/${name}.pid"
  local health_url="$2"

  printf "  %-20s" "$name:"

  # Check PID
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      printf "${GREEN}running${NC} (pid %s)" "$pid"
    else
      printf "${RED}dead${NC} (stale pid %s)" "$pid"
      rm -f "$pidfile"
      echo ""
      return
    fi
  else
    printf "${RED}stopped${NC}"
    echo ""
    return
  fi

  # Check health endpoint
  if [ -n "$health_url" ]; then
    if curl -sf "$health_url" >/dev/null 2>&1; then
      printf "  ${GREEN}healthy${NC}"
    else
      printf "  ${RED}unhealthy${NC}"
    fi
  fi

  echo ""
}

echo ""
echo "Dev service status:"
echo ""
check_service "falkordb" ""
check_service "spicedb"  "http://localhost:8443/healthz"
check_service "graphiti" "http://localhost:8000/health"
echo ""
