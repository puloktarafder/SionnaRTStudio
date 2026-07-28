#!/usr/bin/env bash
# One-time setup. Makes this folder self-contained: installs the frontend deps
# (with the @tailwindcss/oxide native-binding workaround) and a local Python
# venv (./.venv) holding the Sionna RT backend deps.
#
# Portable: copy this folder anywhere, on any machine, then run:
#   ./setup.sh   &&   ./run.sh
#
# Override the backend Python instead of building a local venv:
#   SRTS_PYTHON=/path/to/python ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"            # always operate from the project folder

# ── Prerequisite checks ──────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "✗ Node.js not found. Install Node 18+ and re-run."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found. Install Node.js (includes npm) and re-run."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found. Install Python 3.11+ and re-run."; exit 1; }

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
echo "✅ Setup complete.  Start everything with:   ./run.sh    (or: npm start)"
