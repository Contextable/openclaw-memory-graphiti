#!/usr/bin/env bash
# -------------------------------------------------------------------
# dev-setup.sh — One-time installation of native dev services
#
# Installs:
#   Redis 8.x        from packages.redis.io (>= 7.2 required by FalkorDB)
#   FalkorDB module   prebuilt .so from GitHub releases
#   SpiceDB           prebuilt binary from GitHub releases
#   Graphiti MCP      cloned from GitHub, deps via uv
#
# Everything goes into .dev/ (project-local, gitignored) except
# Redis which is installed system-wide via apt.
#
# Requirements: curl, git, python3 (>= 3.10), sudo (for apt)
# -------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$PROJECT_DIR/.dev"

SPICEDB_VERSION="${SPICEDB_VERSION:-1.49.0}"
FALKORDB_VERSION="${FALKORDB_VERSION:-4.16.3}"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) ARCH_SUFFIX="arm64"; FALKOR_ARCH="arm64v8" ;;
  x86_64|amd64)  ARCH_SUFFIX="amd64"; FALKOR_ARCH="x64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "==> Setting up dev environment in $DEV_DIR"
mkdir -p "$DEV_DIR/bin" "$DEV_DIR/lib" "$DEV_DIR/data/falkordb" "$DEV_DIR/logs" "$DEV_DIR/pids"

# -------------------------------------------------------------------
# 1. Redis (system-wide via apt — FalkorDB needs >= 7.2)
# -------------------------------------------------------------------
REDIS_OK=false
if command -v redis-server &>/dev/null; then
  REDIS_MAJOR="$(redis-server --version | grep -oP 'v=\K[0-9]+')"
  if [ "$REDIS_MAJOR" -ge 8 ] 2>/dev/null; then
    REDIS_OK=true
    echo "==> Redis already installed: $(redis-server --version | grep -oP 'v=\S+')"
  fi
fi

if [ "$REDIS_OK" = false ]; then
  echo "==> Installing Redis >= 7.2 from packages.redis.io..."
  curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg 2>/dev/null
  echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs 2>/dev/null || echo bookworm) main" \
    | sudo tee /etc/apt/sources.list.d/redis.list >/dev/null
  sudo apt-get update -qq 2>&1 | tail -1
  sudo apt-get install -y -qq redis-server libgomp1 2>&1 | tail -3
  echo "    Installed: $(redis-server --version | grep -oP 'v=\S+')"
fi

# Ensure libgomp1 is present (FalkorDB dependency)
dpkg -l libgomp1 >/dev/null 2>&1 || sudo apt-get install -y -qq libgomp1

# -------------------------------------------------------------------
# 2. FalkorDB module (.so)
# -------------------------------------------------------------------
if [ -f "$DEV_DIR/lib/falkordb.so" ]; then
  echo "==> FalkorDB module already downloaded"
else
  echo "==> Downloading FalkorDB v${FALKORDB_VERSION} module (${FALKOR_ARCH})..."
  curl -fsSL -o "$DEV_DIR/lib/falkordb.so" \
    "https://github.com/FalkorDB/FalkorDB/releases/download/v${FALKORDB_VERSION}/falkordb-${FALKOR_ARCH}.so"
  chmod +x "$DEV_DIR/lib/falkordb.so"
  echo "    Downloaded: $DEV_DIR/lib/falkordb.so"
fi

# -------------------------------------------------------------------
# 3. PostgreSQL (optional — persistent datastore for SpiceDB)
# -------------------------------------------------------------------
if command -v pg_isready &>/dev/null; then
  echo "==> PostgreSQL already installed: $(psql --version 2>/dev/null | head -1)"
else
  echo "==> Installing PostgreSQL..."
  sudo apt-get update -qq 2>&1 | tail -1
  sudo apt-get install -y -qq postgresql postgresql-client 2>&1 | tail -3
  echo "    Installed: $(psql --version 2>/dev/null | head -1)"
fi

# -------------------------------------------------------------------
# 4. SpiceDB
# -------------------------------------------------------------------
if [ -x "$DEV_DIR/bin/spicedb" ]; then
  echo "==> SpiceDB already installed: $("$DEV_DIR/bin/spicedb" version 2>/dev/null || echo 'unknown')"
else
  echo "==> Downloading SpiceDB v${SPICEDB_VERSION} (${ARCH_SUFFIX})..."
  SPICEDB_URL="https://github.com/authzed/spicedb/releases/download/v${SPICEDB_VERSION}/spicedb_${SPICEDB_VERSION}_linux_${ARCH_SUFFIX}.tar.gz"
  curl -fsSL "$SPICEDB_URL" | tar xz -C "$DEV_DIR/bin" spicedb
  chmod +x "$DEV_DIR/bin/spicedb"
  echo "    Installed: $("$DEV_DIR/bin/spicedb" version 2>/dev/null || echo "v${SPICEDB_VERSION}")"
fi

# -------------------------------------------------------------------
# 5. uv (Python package manager)
# -------------------------------------------------------------------
if command -v uv &>/dev/null; then
  echo "==> uv already installed: $(uv --version)"
elif [ -x "$HOME/.local/bin/uv" ]; then
  echo "==> uv already installed at ~/.local/bin/uv"
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "==> Installing uv (Python package manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  echo "    Installed: $(uv --version)"
fi

# -------------------------------------------------------------------
# 6. Graphiti MCP Server
# -------------------------------------------------------------------
GRAPHITI_DIR="$DEV_DIR/graphiti"
if [ -d "$GRAPHITI_DIR/mcp_server" ]; then
  echo "==> Graphiti repo already cloned, pulling latest..."
  git -C "$GRAPHITI_DIR" pull --ff-only 2>/dev/null || echo "    (pull skipped — detached or dirty)"
else
  echo "==> Cloning Graphiti repo..."
  git clone --depth 1 https://github.com/getzep/graphiti.git "$GRAPHITI_DIR"
fi

echo "==> Installing Graphiti MCP server dependencies..."
cd "$GRAPHITI_DIR/mcp_server"
if command -v uv &>/dev/null; then
  uv sync 2>&1 | tail -3
else
  "$HOME/.local/bin/uv" sync 2>&1 | tail -3
fi
cd "$PROJECT_DIR"

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo "==> Dev environment ready!"
echo ""
echo "    Redis:    $(redis-server --version | grep -oP 'v=\S+')"
echo "    FalkorDB: $DEV_DIR/lib/falkordb.so (v${FALKORDB_VERSION})"
echo "    SpiceDB:  $DEV_DIR/bin/spicedb"
echo "    Graphiti: $GRAPHITI_DIR/mcp_server/"
echo ""
echo "    Next: run ./scripts/dev-start.sh to start services"
