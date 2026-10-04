import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own process: the server modules capture
    // os.homedir() at import time, and tests point HOME / cwd at a sandbox.
    pool: 'forks',
    testTimeout: 30_000,
  },
})
