"""Tests for platform-specific native runtime discovery."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend.runtime_env import configure_drjit_llvm_path


class RuntimeEnvTests(unittest.TestCase):
    def test_preserves_explicit_override(self) -> None:
        with patch.dict(os.environ, {"DRJIT_LIBLLVM_PATH": "/custom/libLLVM.dylib"}):
            self.assertEqual(configure_drjit_llvm_path(), "/custom/libLLVM.dylib")

    def test_non_macos_does_nothing(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("backend.runtime_env.platform.system", return_value="Linux"),
        ):
            self.assertIsNone(configure_drjit_llvm_path())
            self.assertNotIn("DRJIT_LIBLLVM_PATH", os.environ)

    def test_uses_homebrew_prefix_on_macos(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            library = Path(temp_dir) / "lib" / "libLLVM.dylib"
            library.parent.mkdir()
            library.touch()
            completed = subprocess.CompletedProcess(
                args=["brew", "--prefix", "llvm"],
                returncode=0,
                stdout=f"{temp_dir}\n",
                stderr="",
            )
            with (
                patch.dict(os.environ, {}, clear=True),
                patch("backend.runtime_env.platform.system", return_value="Darwin"),
                patch("backend.runtime_env.shutil.which", return_value="/opt/homebrew/bin/brew"),
                patch("backend.runtime_env.subprocess.run", return_value=completed),
            ):
                self.assertEqual(configure_drjit_llvm_path(), str(library))
                self.assertEqual(os.environ["DRJIT_LIBLLVM_PATH"], str(library))


if __name__ == "__main__":
    unittest.main()
