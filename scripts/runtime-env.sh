#!/usr/bin/env bash
# Runtime environment shared by setup.sh and run.sh.
# Homebrew keeps LLVM keg-only, so Dr.Jit cannot discover libLLVM.dylib from
# PATH. Resolve the actual keg path on every invocation; no shell-profile edit
# is needed and both Apple Silicon (/opt/homebrew) and Intel prefixes work.

srts_configure_drjit_llvm() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ -z "${DRJIT_LIBLLVM_PATH:-}" ] || return 0
  command -v brew >/dev/null 2>&1 || return 0

  local llvm_prefix llvm_library
  llvm_prefix="$(brew --prefix llvm 2>/dev/null)" || return 0
  llvm_library="$llvm_prefix/lib/libLLVM.dylib"
  [ -f "$llvm_library" ] || return 0
  export DRJIT_LIBLLVM_PATH="$llvm_library"
}
