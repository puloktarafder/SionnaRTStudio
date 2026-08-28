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
source scripts/runtime-env.sh
srts_configure_drjit_llvm

# WSL1 emulates Linux syscalls instead of running a kernel, and Dr.Jit's native
# extension does not load there. WSL2 carries "WSL2" in its kernel release.
on_wsl1() {
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || return 1
  ! grep -qi wsl2 /proc/sys/kernel/osrelease 2>/dev/null
}

wsl1_note() {
  echo "  This is WSL1, which cannot load Dr.Jit or Mitsuba. Switch the distro"
  echo "  to WSL2 from PowerShell, then re-run ./setup.sh:"
  echo "      wsl --set-default-version 2"
  echo "      wsl --set-version <distro> 2      # e.g. Ubuntu-24.04"
}

# ── Node: prefer the project-local one ./setup.sh may have installed ────────
if [ -x ".node/bin/node" ]; then
  export PATH="$(pwd)/.node/bin:$PATH"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm not found. Run ./setup.sh first — it installs Node into ./.node"
  echo "  if the system has none."
  exit 1
fi

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

# `import sionna` loads Dr.Jit's native extension, so this import can fail on a
# machine where pip reports every requirement satisfied. Keep the real error
# rather than blaming the packages for what is a native-library problem.
if ! IMPORT_ERR="$("$PYTHON" -c "import sionna, fastapi" 2>&1)"; then
  echo "✗ The backend Python cannot import sionna/fastapi:"
  echo "    $PYTHON"
  echo
  if [ -n "$IMPORT_ERR" ]; then
    printf '%s\n' "$IMPORT_ERR" | tail -n 3 | sed 's/^/    /'
  else
    echo "    (no output — the interpreter crashed during import)"
  fi
  echo
  case "$IMPORT_ERR" in
    *"No module named 'sionna'"*|*"No module named 'fastapi'"*)
      echo "  The packages are not installed. Run ./setup.sh, or:"
      echo "      $PYTHON -m pip install -r backend/requirements.txt" ;;
    *)
      echo "  The packages are installed, but a native library failed to load."
      if on_wsl1; then
        wsl1_note
      elif [ "$(uname -s)" = "Darwin" ]; then
        echo "  Dr.Jit's CPU backend needs Homebrew LLVM. Run ./setup.sh; it"
        echo "  installs LLVM when needed and configures libLLVM.dylib automatically."
      else
        echo "  On a machine with no CUDA GPU this is usually the missing LLVM"
        echo "  runtime that Dr.Jit dlopens:  sudo apt install llvm-runtime"
      fi ;;
  esac
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
