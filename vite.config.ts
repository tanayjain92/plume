import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths: the same build works on GitHub Pages (/plume/) and inside the desktop app.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
