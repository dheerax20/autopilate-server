import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  css: {
    // Override postcss discovery so Vite doesn't walk up to the root
    // postcss.config.js (which requires tailwindcss not installed here)
    postcss: {},
  },
});
