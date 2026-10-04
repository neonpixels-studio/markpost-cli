import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.{test,spec}.{ts,js}'],
  },
  resolve: {
    alias: {
      '#src': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
