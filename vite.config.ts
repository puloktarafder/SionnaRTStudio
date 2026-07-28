import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Don't watch the Python venv / backend / build output — watching the
      // thousands of files under .venv exhausts the inotify limit (ENOSPC).
      watch: {
        ignored: ['**/.venv/**', '**/backend/**', '**/dist/**', '**/.git/**', '**/__pycache__/**'],
      },
      // Proxy API calls to the local FastAPI + Sionna RT backend. The port is
      // overridable (SRTS_BACKEND_PORT) for when another service holds :8000.
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.SRTS_BACKEND_PORT || 8000}`,
          changeOrigin: true,
        },
      },
    },
  };
});
