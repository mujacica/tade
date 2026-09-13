import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    testTimeout: 10_000,
    // Tests build real git repos in tmp dirs; keep them isolated per file.
    pool: 'forks',
  },
})
