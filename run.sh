#!/usr/bin/env bash
# One command to run the whole app: starts the Sionna RT backend (:8000) and the
# Vite frontend (:3000) together. Ctrl+C stops both.
#
#   ./run.sh           (or:  npm start)
#
# Portable: works from any path on any machine. Run ./setup.sh once first.
# Backend Python defaults to the local ./.venv. Override with:
#   SRTS_PYTHON=/path/to/python ./run.sh
set -euo pipefail
cd "$(dirname "$0")"            # always operate from the project folder

# ── Pick a Python that has Sionna RT installed ──────────────────────────────
PYTHON="${SRTS_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  if [ -x ".venv/bin/python" ]; then
    PYTHON="$(pwd)/.venv/bin/python"
  else
    echo "✗ No local Python environment found (./.venv is missing)."
    echo "  Run ./setup.sh first (it creates ./.venv with Sionna + FastAPI),"
    echo "  or point at an existing one:  SRTS_PYTHON=/path/to/python ./run.sh"
    exit 1
  fi
fi

if ! "$PYTHON" -c "import sionna, fastapi" >/dev/null 2>&1; then
  echo "✗ This Python is missing sionna/fastapi: $PYTHON"
  echo "  Run ./setup.sh, or:  $PYTHON -m pip install -r backend/requirements.txt"
  exit 1
fi

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
# Backend port is overridable (another service may hold :8000); the Vite proxy
# reads the same variable, so frontend and backend stay in sync.
export SRTS_BACKEND_PORT="${SRTS_BACKEND_PORT:-8000}"
echo "▶ Backend Python : $PYTHON"
echo "▶ Backend        : http://localhost:${SRTS_BACKEND_PORT}"
echo "▶ Frontend       : http://localhost:3000"
echo

# ── Start backend, stop it automatically when this script exits ─────────────
"$PYTHON" -m uvicorn backend.main:app --port "$SRTS_BACKEND_PORT" &
BACKEND_PID=$!
cleanup() { kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Give uvicorn a moment, then run the frontend in the foreground.
sleep 2
npm run dev
