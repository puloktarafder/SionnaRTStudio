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
source scripts/runtime-env.sh

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

# ── Backend interpreter ──────────────────────────────────────────────────────
# Every pinned wheel covers CPython 3.9-3.14 except numpy 2.2.6, which stops at
# 3.13. On a distro whose default python3 runs past that ceiling (Ubuntu 26.04
# ships 3.14) pip falls back to compiling numpy from source and dies on a
# machine with no C toolchain. So pick an interpreter the wheels actually cover
# instead of trusting `python3`, and be explicit when none exists.
PY_MIN_MINOR=11          # oldest interpreter this project supports
PY_WHEEL_MAX_MINOR=13    # newest interpreter the pinned wheel set covers

py_minor() { "$1" -c 'import sys; print(sys.version_info[1])' 2>/dev/null; }

VENV_PY=""
for cand in python3.13 python3.12 python3.11 python3; do
  command -v "$cand" >/dev/null 2>&1 || continue
  minor="$(py_minor "$cand")" || continue
  [ -n "$minor" ] || continue
  [ "$minor" -ge "$PY_MIN_MINOR" ] || continue
  VENV_PY="$cand"
  [ "$minor" -le "$PY_WHEEL_MAX_MINOR" ] && break
done

if [ -z "$VENV_PY" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "✗ No Python 3.${PY_MIN_MINOR}+ found. Run: brew install python@3.13"
  else
    echo "✗ No Python 3.${PY_MIN_MINOR}+ found. Install one and re-run."
  fi
  exit 1
fi
VENV_PY_MINOR="$(py_minor "$VENV_PY")"

# macOS has no CUDA path, so LLVM is required. Homebrew's LLVM formula is
# keg-only; install it when absent and export its exact dylib path for Dr.Jit.
if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$(uname -m)" != "arm64" ]; then
    echo "✗ Intel macOS is unsupported: Mitsuba publishes macOS wheels for Apple Silicon only."
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "✗ Homebrew is required on macOS. Install it from https://brew.sh, then re-run ./setup.sh."
    exit 1
  fi
  if ! brew --prefix llvm >/dev/null 2>&1; then
    echo "Installing LLVM with Homebrew (required by Dr.Jit's CPU backend) ..."
    brew install llvm
  fi
  srts_configure_drjit_llvm
  if [ -z "${DRJIT_LIBLLVM_PATH:-}" ]; then
    echo "✗ Homebrew LLVM is installed, but lib/libLLVM.dylib was not found."
    echo "  Check: brew --prefix llvm"
    exit 1
  fi
  echo "▶ Dr.Jit LLVM : $DRJIT_LIBLLVM_PATH"
fi

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
  local plat arch pkg archive_ext archive tmp
  case "$(uname -s)" in
    Linux)  plat=linux;  archive_ext=tar.xz ;;
    Darwin) plat=darwin; archive_ext=tar.gz ;;
    *) echo "✗ Auto-install covers Linux and macOS only. Install Node ${NODE_MIN_MAJOR}+ manually and re-run."; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "✗ No official Node build for $(uname -m). Install Node ${NODE_MIN_MAJOR}+ manually and re-run."; exit 1 ;;
  esac
  pkg="node-v${NODE_VERSION}-${plat}-${arch}"
  archive="${pkg}.${archive_ext}"

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    if [ "$plat" = "darwin" ]; then
      echo "✗ Need curl or wget to download Node. Install Xcode command-line tools."; exit 1
    else
      echo "✗ Need curl or wget to download Node.  sudo apt install curl"; exit 1
    fi
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "✗ Need tar to unpack Node."; exit 1
  fi
  if [ "$plat" = "linux" ] && ! command -v xz >/dev/null 2>&1; then
    echo "✗ Need tar and xz to unpack Node.  sudo apt install tar xz-utils"; exit 1
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "Downloading ${archive} from nodejs.org ..."
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$tmp/$archive"       "$base/$archive"
    curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  else
    wget -qO "$tmp/$archive"       "$base/$archive"
    wget -qO "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  fi

  # Verify against the published checksum before we execute anything from it.
  local sha=""
  if   command -v sha256sum >/dev/null 2>&1; then sha="sha256sum"
  elif command -v shasum    >/dev/null 2>&1; then sha="shasum -a 256"
  fi
  if [ -n "$sha" ]; then
    if ! (cd "$tmp" && grep " ${archive}\$" SHASUMS256.txt | $sha -c - >/dev/null 2>&1); then
      echo "✗ Checksum mismatch on ${archive} — refusing to install."; exit 1
    fi
    echo "Checksum verified."
  else
    echo "⚠ No sha256sum/shasum available — skipping checksum verification."
  fi

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xf "$tmp/$archive" -C "$NODE_DIR" --strip-components=1
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
  echo "Creating local ./.venv with $("$VENV_PY" -V 2>&1) and installing"
  echo "backend/requirements.txt ..."
  echo "(Pulls Sionna/Mitsuba/Dr.Jit — uses CUDA when available, LLVM otherwise.)"
  if [ "$VENV_PY_MINOR" -gt "$PY_WHEEL_MAX_MINOR" ]; then
    echo "⚠ This is newer than the pinned wheel set (3.${PY_WHEEL_MAX_MINOR} is the"
    echo "  ceiling), so numpy resolves to a newer release than the pinned 2.2.6."
    echo "  Install any Python 3.${PY_MIN_MINOR}-3.${PY_WHEEL_MAX_MINOR} alongside it, with the matching"
    echo "  -venv package, to reproduce the exact benchmarked environment."
  fi
  "$VENV_PY" -m venv .venv || {
    echo "✗ Could not create a venv with $VENV_PY."
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "  Install a Homebrew Python 3.11-3.13 (brew install python@3.13), then re-run."
    else
      echo "  On Debian/Ubuntu the venv module is packaged separately, and a fresh"
      echo "  image needs an index refresh before the package resolves:"
      echo "      sudo apt update && sudo apt install python3-venv"
      echo "  Or the version-specific one:  python3.${VENV_PY_MINOR}-venv"
    fi
    exit 1
  }
  ./.venv/bin/pip install --upgrade pip
  if ! ./.venv/bin/pip install -r backend/requirements.txt; then
    echo
    echo "✗ Installing the backend requirements failed."
    echo "  If pip fell back to building a package from source, no prebuilt wheel"
    echo "  exists for Python 3.${VENV_PY_MINOR}. Install a Python 3.${PY_MIN_MINOR}-3.${PY_WHEEL_MAX_MINOR} and re-run,"
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "  or install Apple's command-line tools:  xcode-select --install"
    else
      echo "  or give this machine a compiler:  sudo apt install build-essential"
    fi
    exit 1
  fi
fi

echo
echo "── Ray-tracing backend check ────────────────────────────────────"
# Which Mitsuba variant this machine can actually initialize decides whether the
# backend can serve at all. Resolve it now, while we can still explain the fix,
# rather than letting the user discover it as an offline badge in the browser.
SRTS_PY="${SRTS_PYTHON:-./.venv/bin/python}"
RT_ERR="$(mktemp)"
trap 'rm -f "$RT_ERR"' EXIT
RT_STATUS="$("$SRTS_PY" - 2>"$RT_ERR" <<'PY' || echo "error"
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
        if on_wsl1; then
          wsl1_note
        elif [ "$(uname -s)" = "Darwin" ]; then
          echo "  Dr.Jit's CPU path needs Homebrew LLVM. Run:"
          echo "      brew install llvm"
          echo "  setup.sh will find its keg-only libLLVM.dylib automatically."
        else
          echo "  Dr.Jit's CPU path needs the LLVM runtime, which is not bundled"
          echo "  in the wheel and is missing from many clean Ubuntu images:"
          echo "      sudo apt install llvm-runtime"
          echo "  Then re-run ./setup.sh. Without it the backend will not start."
        fi ;;
  *)    echo "✗ Mitsuba could not be imported, so the backend will not start."
        if [ -s "$RT_ERR" ]; then
          tail -n 3 "$RT_ERR" | sed 's/^/    /'
        else
          echo "    (no output — the interpreter crashed during import)"
        fi
        if on_wsl1; then
          wsl1_note
        elif [ "$(uname -s)" = "Darwin" ]; then
          echo "  Apple Silicon requires Homebrew LLVM: brew install llvm"
          echo "  setup.sh configures its libLLVM.dylib automatically."
        else
          echo "  Check that the wheel matches this platform. Linux x86-64 needs glibc 2.28+."
        fi ;;
esac

echo
case "$RT_STATUS" in
  gpu|cpu) echo "✅ Setup complete.  Start everything with:   ./run.sh    (or: npm start)" ;;
  *)       echo "⚠ Setup finished, but ray tracing cannot start yet. Fix the above"
           echo "  first — ./run.sh will refuse to launch the backend until then." ;;
esac
