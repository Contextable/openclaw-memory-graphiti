#!/usr/bin/env bash
# -------------------------------------------------------------------
# dev-start.sh — Start FalkorDB + SpiceDB + Graphiti MCP server
#
# Services run in the background; logs go to .dev/logs/.
# PID files are written to .dev/pids/.
#
# Environment variables:
#   OPENAI_API_KEY        Required by Graphiti for entity extraction (unless using local models)
#   SPICEDB_TOKEN         Pre-shared key (default: dev_token)
#   SPICEDB_PORT          gRPC port (default: 50051)
#   SPICEDB_DATASTORE     "memory" (default) or "postgres"
#   SPICEDB_DB_URI        Postgres connection URI (when SPICEDB_DATASTORE=postgres)
#   FALKORDB_PORT         Redis port (default: 6379)
#   GRAPHITI_PORT         HTTP port (default: 8000)
#   GRAPHITI_PATH         Path to Graphiti git clone (default: ../graphiti)
#   EPISODE_ID_PREFIX     Prefix for Graphiti episode UUIDs (default: epi-)
#
# Optional: Use local models instead of OpenAI
#   LLM_PROVIDER          "openai_generic" (enables custom LLM endpoint)
#   LLM_MODEL             Model name (e.g., "nvidia/Qwen3-Next-80B-A3B-Instruct-NVFP4")
#   LLM_API_URL           Custom LLM endpoint (e.g., "http://dgx-spark:8000/v1")
#   EMBEDDER_MODEL        Embedding model (e.g., "nomic-embed-text:v1.5")
#   EMBEDDER_DIMENSIONS   Embedding dimensions (e.g., 768 for nomic, 1536 for OpenAI)
#   EMBEDDER_API_URL      Custom embedder endpoint (e.g., "http://minisforum:11434/v1")
#   RERANKER_PROVIDER     Reranker provider: "openai", "gemini", or "bge" (default: bge)
# -------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$PROJECT_DIR/.dev"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

SPICEDB_TOKEN="${SPICEDB_TOKEN:-dev_token}"
SPICEDB_PORT="${SPICEDB_PORT:-50051}"
SPICEDB_DATASTORE="${SPICEDB_DATASTORE:-memory}"
SPICEDB_DB_URI="${SPICEDB_DB_URI:-postgres://spicedb:spicedb_dev@127.0.0.1:5432/spicedb?sslmode=disable}"
FALKORDB_PORT="${FALKORDB_PORT:-6379}"
GRAPHITI_PORT="${GRAPHITI_PORT:-8000}"
GRAPHITI_PATH="${GRAPHITI_PATH:-$PROJECT_DIR/../graphiti}"

# Local model endpoints (for your dev environment)
LLM_PROVIDER="${LLM_PROVIDER:-openai_generic}"
LLM_MODEL="${LLM_MODEL:-nvidia/Qwen3-Next-80B-A3B-Instruct-NVFP4}"
LLM_API_URL="${LLM_API_URL:-http://dgx-spark:8000/v1}"
LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-8192}"
EMBEDDER_MODEL="${EMBEDDER_MODEL:-nomic-embed-text:v1.5}"
EMBEDDER_DIMENSIONS="${EMBEDDER_DIMENSIONS:-768}"
EMBEDDER_API_URL="${EMBEDDER_API_URL:-http://minisforum:11434/v1}"
RERANKER_PROVIDER="${RERANKER_PROVIDER:-bge}"

mkdir -p "$DEV_DIR/logs" "$DEV_DIR/pids" "$DEV_DIR/data/falkordb"

# Ensure uv is on PATH
export PATH="$HOME/.local/bin:$DEV_DIR/bin:$PATH"

# -------------------------------------------------------------------
# Helper: check if a process is already running
# -------------------------------------------------------------------
is_running() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    rm -f "$pidfile"
  fi
  return 1
}

# -------------------------------------------------------------------
# 1. FalkorDB (Redis + module)
# -------------------------------------------------------------------
if is_running "$DEV_DIR/pids/falkordb.pid"; then
  echo "==> FalkorDB already running (pid $(cat "$DEV_DIR/pids/falkordb.pid"))"
else
  echo "==> Starting FalkorDB on port $FALKORDB_PORT..."
  # Redis 8.x requires a valid locale; default to C.utf8 if LANG is unset
  export LC_ALL="${LC_ALL:-C.utf8}"
  redis-server \
    --loadmodule "$DEV_DIR/lib/falkordb.so" \
    --port "$FALKORDB_PORT" \
    --dir "$DEV_DIR/data/falkordb" \
    --daemonize no \
    --save "300 10 60 1000" \
    --appendonly yes \
    --appendfsync everysec \
    --loglevel notice \
    > "$DEV_DIR/logs/falkordb.log" 2>&1 &
  echo $! > "$DEV_DIR/pids/falkordb.pid"
  echo "    PID: $(cat "$DEV_DIR/pids/falkordb.pid") — log: .dev/logs/falkordb.log"

  # Wait for FalkorDB to be ready
  echo -n "    Waiting for FalkorDB..."
  for i in $(seq 1 30); do
    if redis-cli -p "$FALKORDB_PORT" PING 2>/dev/null | grep -q PONG; then
      echo " ready!"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo " timeout! Check .dev/logs/falkordb.log"
      exit 1
    fi
    sleep 0.5
    echo -n "."
  done
fi

# -------------------------------------------------------------------
# 2. PostgreSQL (when SPICEDB_DATASTORE=postgres)
# -------------------------------------------------------------------
if [ "$SPICEDB_DATASTORE" = "postgres" ]; then
  if pg_isready -q 2>/dev/null; then
    echo "==> PostgreSQL already running"
  else
    echo "==> Starting PostgreSQL..."
    sudo pg_ctlcluster 15 main start 2>&1
    echo -n "    Waiting for PostgreSQL..."
    for i in $(seq 1 20); do
      if pg_isready -q 2>/dev/null; then
        echo " ready!"
        break
      fi
      if [ "$i" -eq 20 ]; then
        echo " timeout!"
        exit 1
      fi
      sleep 0.5
      echo -n "."
    done
  fi

  # Ensure database and user exist (idempotent)
  sudo su - postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='spicedb'\" | grep -q 1" 2>/dev/null \
    || sudo su - postgres -c "psql -c \"CREATE USER spicedb WITH PASSWORD 'spicedb_dev';\"" 2>/dev/null
  sudo su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='spicedb'\" | grep -q 1" 2>/dev/null \
    || sudo su - postgres -c "psql -c \"CREATE DATABASE spicedb OWNER spicedb;\"" 2>/dev/null

  # Run SpiceDB migrations
  echo "==> Running SpiceDB migrations..."
  "$DEV_DIR/bin/spicedb" migrate head \
    --datastore-engine=postgres \
    "--datastore-conn-uri=$SPICEDB_DB_URI" \
    > "$DEV_DIR/logs/spicedb-migrate.log" 2>&1
  echo "    Migrations complete"
fi

# -------------------------------------------------------------------
# 3. SpiceDB
# -------------------------------------------------------------------
if is_running "$DEV_DIR/pids/spicedb.pid"; then
  echo "==> SpiceDB already running (pid $(cat "$DEV_DIR/pids/spicedb.pid"))"
else
  SPICEDB_ARGS=(
    serve
    "--grpc-preshared-key=$SPICEDB_TOKEN"
    "--grpc-addr=:$SPICEDB_PORT"
    "--datastore-engine=$SPICEDB_DATASTORE"
    --http-enabled=true
  )
  if [ "$SPICEDB_DATASTORE" = "postgres" ]; then
    SPICEDB_ARGS+=("--datastore-conn-uri=$SPICEDB_DB_URI")
  fi

  echo "==> Starting SpiceDB on port $SPICEDB_PORT (datastore: $SPICEDB_DATASTORE)..."
  "$DEV_DIR/bin/spicedb" "${SPICEDB_ARGS[@]}" \
    > "$DEV_DIR/logs/spicedb.log" 2>&1 &
  echo $! > "$DEV_DIR/pids/spicedb.pid"
  echo "    PID: $(cat "$DEV_DIR/pids/spicedb.pid") — log: .dev/logs/spicedb.log"

  # Wait for SpiceDB to be ready
  echo -n "    Waiting for SpiceDB..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:8443/healthz >/dev/null 2>&1; then
      echo " ready!"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo " timeout! Check .dev/logs/spicedb.log"
      exit 1
    fi
    sleep 0.5
    echo -n "."
  done
fi

# -------------------------------------------------------------------
# 4. Graphiti MCP Server (FalkorDB backend)
# -------------------------------------------------------------------
if is_running "$DEV_DIR/pids/graphiti.pid"; then
  echo "==> Graphiti MCP server already running (pid $(cat "$DEV_DIR/pids/graphiti.pid"))"
else
  echo "==> Starting Graphiti MCP server on port $GRAPHITI_PORT..."
  echo "    LLM:               $LLM_PROVIDER / $LLM_MODEL"
  echo "    LLM endpoint:      $LLM_API_URL"
  echo "    Embedder:          $EMBEDDER_MODEL (${EMBEDDER_DIMENSIONS}d)"
  echo "    Embedder endpoint: $EMBEDDER_API_URL"
  echo "    Reranker:          $RERANKER_PROVIDER"

  GRAPHITI_DIR="$GRAPHITI_PATH/mcp_server"

  # Set environment for Graphiti
  export OPENAI_API_KEY="${OPENAI_API_KEY:-not-needed}"
  export FALKORDB_URI="redis://localhost:$FALKORDB_PORT"
  export EPISODE_ID_PREFIX="${EPISODE_ID_PREFIX:-epi-}"

  # Export local model configuration
  export LLM_PROVIDER
  export LLM_MODEL
  export LLM_API_URL
  export LLM_MAX_TOKENS
  export EMBEDDER_MODEL
  export EMBEDDER_DIMENSIONS
  export EMBEDDER_API_URL
  export RERANKER_PROVIDER

  cd "$GRAPHITI_DIR"
  uv run main.py \
    --transport http \
    --port "$GRAPHITI_PORT" \
    > "$DEV_DIR/logs/graphiti.log" 2>&1 &
  echo $! > "$DEV_DIR/pids/graphiti.pid"
  cd "$PROJECT_DIR"

  echo "    PID: $(cat "$DEV_DIR/pids/graphiti.pid") — log: .dev/logs/graphiti.log"

  # Wait for Graphiti to be ready
  echo -n "    Waiting for Graphiti..."
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:$GRAPHITI_PORT/health" >/dev/null 2>&1; then
      echo " ready!"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo " timeout! Check .dev/logs/graphiti.log"
      exit 1
    fi
    sleep 1
    echo -n "."
  done
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "==> All services running:"
echo "    FalkorDB:        localhost:$FALKORDB_PORT (Redis protocol)"
echo "    SpiceDB gRPC:    localhost:$SPICEDB_PORT (datastore: $SPICEDB_DATASTORE)"
echo "    SpiceDB HTTP:    localhost:8443"
echo "    Graphiti MCP:    http://localhost:$GRAPHITI_PORT"
echo "    Graphiti health: http://localhost:$GRAPHITI_PORT/health"
echo ""
echo "    Stop with: ./scripts/dev-stop.sh"
echo "    Status:    ./scripts/dev-status.sh"
echo "    Logs:      tail -f .dev/logs/*.log"
echo ""
echo "    Run e2e tests:"
echo "      OPENCLAW_LIVE_TEST=1 pnpm vitest run e2e.test.ts"
