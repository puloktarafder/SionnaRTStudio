#!/usr/bin/env bash
# One-time setup. Makes this folder self-contained: installs Node (./.node) if
# the machine has none, the frontend deps (with the @tailwindcss/oxide
# native-binding workaround) and a local Python venv (./.venv) holding the
# Sionna RT backend deps.
#
# Portable: copy this folder anywhere, on any machine, then run:
#   ./setup.sh   &&   ./run.sh
#
# Override the backend Python instead of building a local venv:
#   SRTS_PYTHON=/path/to/python ./setup.sh
#
# Node bootstrap knobs:
#   SRTS_NODE_VERSION=22.23.1   install a different Node into ./.node
#   SRTS_NODE_INSTALL=off       never auto-install; fail if Node is missing
set -euo pipefail
cd "$(dirname "$0")"            # always operate from the project folder

# ── Prerequisite checks ──────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found. Install Python 3.11+ and re-run."; exit 1; }

# ── Node.js ──────────────────────────────────────────────────────────────────
# Vite 6 and tsx need Node 20+, and distro packages lag behind that (Ubuntu
# 24.04's `apt install nodejs` still ships 18). So instead of failing on a fresh
# machine, drop a pinned Node into ./.node the same way the backend gets its own
# ./.venv — no sudo, no system packages, and `rm -rf` on this folder undoes it.
NODE_MIN_MAJOR=20
NODE_VERSION="${SRTS_NODE_VERSION:-22.23.1}"   # current Jod LTS
NODE_DIR="$PWD/.node"

node_ok() {                     # node_ok <node-binary> — present and new enough?
  local bin="$1" major
  command -v "$bin" >/dev/null 2>&1 || return 1
  major="$("$bin" -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  [ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

install_local_node() {
  local plat arch pkg tmp
  case "$(uname -s)" in
    Linux)  plat=linux ;;
    Darwin) plat=darwin ;;
    *) echo "✗ Auto-install covers Linux and macOS only. Install Node ${NODE_MIN_MAJOR}+ manually and re-run."; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "✗ No official Node build for $(uname -m). Install Node ${NODE_MIN_MAJOR}+ manually and re-run."; exit 1 ;;
  esac
  pkg="node-v${NODE_VERSION}-${plat}-${arch}"

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "✗ Need curl or wget to download Node.  sudo apt install curl"; exit 1
  fi
  if ! command -v tar >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
    echo "✗ Need tar and xz to unpack Node.  sudo apt install tar xz-utils"; exit 1
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "Downloading ${pkg}.tar.xz from nodejs.org ..."
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$tmp/$pkg.tar.xz"    "$base/$pkg.tar.xz"
    curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  else
    wget -qO "$tmp/$pkg.tar.xz"    "$base/$pkg.tar.xz"
    wget -qO "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  fi

  # Verify against the published checksum before we execute anything from it.
  local sha=""
  if   command -v sha256sum >/dev/null 2>&1; then sha="sha256sum"
  elif command -v shasum    >/dev/null 2>&1; then sha="shasum -a 256"
  fi
  if [ -n "$sha" ]; then
    if ! (cd "$tmp" && grep " ${pkg}.tar.xz\$" SHASUMS256.txt | $sha -c - >/dev/null 2>&1); then
      echo "✗ Checksum mismatch on ${pkg}.tar.xz — refusing to install."; exit 1
    fi
    echo "Checksum verified."
  else
    echo "⚠ No sha256sum/shasum available — skipping checksum verification."
  fi

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xf "$tmp/$pkg.tar.xz" -C "$NODE_DIR" --strip-components=1
}

if node_ok "$NODE_DIR/bin/node"; then
  export PATH="$NODE_DIR/bin:$PATH"
  echo "▶ Node.js $(node -v) — project-local ./.node"
elif node_ok node && command -v npm >/dev/null 2>&1; then
  echo "▶ Node.js $(node -v) — system"
elif [ "${SRTS_NODE_INSTALL:-auto}" = "off" ]; then
  echo "✗ Node ${NODE_MIN_MAJOR}+ not found and SRTS_NODE_INSTALL=off. Install it and re-run."
  exit 1
else
  if command -v node >/dev/null 2>&1; then
    echo "Node $(node -v) is older than the required v${NODE_MIN_MAJOR}."
  else
    echo "Node.js not found."
  fi
  echo "Installing Node v${NODE_VERSION} into ./.node (local to this folder, no sudo)."
  install_local_node
  export PATH="$NODE_DIR/bin:$PATH"
  echo "▶ Node.js $(node -v) — project-local ./.node"
fi
echo

echo "── Installing frontend dependencies ─────────────────────────────"
npm install
# npm has an optional-deps bug that can skip tailwind's native binding; install it
# explicitly for THIS platform so `vite` can start on whatever machine we're on.
OXIDE_VER="$(node -p "require('./node_modules/@tailwindcss/oxide/package.json').version" 2>/dev/null || echo '')"
if [ -n "$OXIDE_VER" ]; then
  PLAT="$(node -p "process.platform")"; ARCH="$(node -p "process.arch")"
  case "$PLAT-$ARCH" in
    linux-x64)    NATIVE="@tailwindcss/oxide-linux-x64-gnu" ;;
    linux-arm64)  NATIVE="@tailwindcss/oxide-linux-arm64-gnu" ;;
    darwin-arm64) NATIVE="@tailwindcss/oxide-darwin-arm64" ;;
    darwin-x64)   NATIVE="@tailwindcss/oxide-darwin-x64" ;;
    win32-x64)    NATIVE="@tailwindcss/oxide-win32-x64-msvc" ;;
    *)            NATIVE="" ;;
  esac
  if [ -n "$NATIVE" ]; then
    npm install --no-save "${NATIVE}@${OXIDE_VER}" || true
  fi
fi

echo
echo "── Backend Python (Sionna RT) ───────────────────────────────────"
if [ -n "${SRTS_PYTHON:-}" ]; then
  # User pointed us at an existing interpreter — verify and use it as-is.
  if "$SRTS_PYTHON" -c "import sionna,fastapi" >/dev/null 2>&1; then
    echo "Using SRTS_PYTHON=$SRTS_PYTHON (already has Sionna + FastAPI)."
  else
    echo "✗ SRTS_PYTHON=$SRTS_PYTHON is missing sionna/fastapi. Install them or unset SRTS_PYTHON."
    exit 1
  fi
elif [ -x ".venv/bin/python" ] && ./.venv/bin/python -c "import sionna,fastapi" >/dev/null 2>&1; then
  echo "Local ./.venv already has Sionna + FastAPI — reusing it."
else
  # No usable env. A ./.venv copied from another machine/path won't import
  # cleanly, so rebuild it fresh here.
  if [ -e ".venv" ]; then
    echo "Existing ./.venv is unusable on this machine — rebuilding it."
    rm -rf .venv
  fi
  echo "Creating local ./.venv and installing backend/requirements.txt ..."
  echo "(Pulls Sionna/Mitsuba/Dr.Jit — needs an NVIDIA GPU + CUDA at RUN time.)"
  python3 -m venv .venv || {
    echo "✗ Could not create a venv. On Debian/Ubuntu:  sudo apt install python3-venv"
    exit 1
  }
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r backend/requirements.txt
fi

echo
echo "── Ray-tracing backend check ────────────────────────────────────"
# Which Mitsuba variant this machine can actually initialize decides whether the
# backend can serve at all. Resolve it now, while we can still explain the fix,
# rather than letting the user discover it as an offline badge in the browser.
SRTS_PY="${SRTS_PYTHON:-./.venv/bin/python}"
RT_STATUS="$("$SRTS_PY" - <<'PY' 2>/dev/null || echo "error"
import mitsuba as mi
for name, label in (("cuda_ad_mono_polarized", "gpu"), ("llvm_ad_mono_polarized", "cpu")):
    if name not in mi.variants():
        continue
    try:
        mi.set_variant(name)
        print(label)
        break
    except Exception:
        continue
else:
    print("none")
PY
)"
case "$RT_STATUS" in
  gpu)  echo "✓ CUDA GPU ray tracing available." ;;
  cpu)  echo "⚠ No usable CUDA GPU — ray tracing will run on the CPU (llvm)."
        echo "  Correct results, much slower. Expected inside a VM: VirtualBox"
        echo "  and friends cannot pass the host GPU through to the guest." ;;
  none) echo "✗ Neither GPU nor CPU ray tracing can start on this machine."
        echo "  Dr.Jit's CPU path needs the LLVM runtime, which is not bundled"
        echo "  in the wheel and is missing from many clean Ubuntu images:"
        echo "      sudo apt install llvm-runtime"
        echo "  Then re-run ./setup.sh. Without it the backend will not start." ;;
  *)    echo "⚠ Could not probe Mitsuba variants; skipping this check." ;;
esac

echo
echo "✅ Setup complete.  Start everything with:   ./run.sh    (or: npm start)"
