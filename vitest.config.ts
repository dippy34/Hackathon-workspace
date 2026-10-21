import { defineConfig } from 'vitest/config';

// Pure rules-engine tests only (src/core). Kept separate from vite.config.ts so
// the IWSDK dev plugin never loads under Node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
