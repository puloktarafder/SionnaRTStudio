"""Platform-specific native runtime discovery.

Shell launchers normally configure this first. This module also covers direct
``python -m uvicorn backend.main:app`` launches on macOS.
"""
from __future__ import annotations

import os
from pathlib import Path
import platform
import shutil
import subprocess


def configure_drjit_llvm_path() -> str | None:
    """Point Dr.Jit at Homebrew's keg-only LLVM library when on macOS."""
    configured = os.environ.get("DRJIT_LIBLLVM_PATH")
    if configured or platform.system() != "Darwin":
        return configured

    prefixes: list[Path] = []
    brew = shutil.which("brew")
    if brew:
        result = subprocess.run(
            [brew, "--prefix", "llvm"],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            prefixes.append(Path(result.stdout.strip()))

    # Also work when Homebrew is installed but not present on a GUI app's PATH.
    prefixes.extend((Path("/opt/homebrew/opt/llvm"), Path("/usr/local/opt/llvm")))
    for prefix in prefixes:
        library = prefix / "lib" / "libLLVM.dylib"
        if library.is_file():
            os.environ["DRJIT_LIBLLVM_PATH"] = str(library)
            return str(library)
    return None
