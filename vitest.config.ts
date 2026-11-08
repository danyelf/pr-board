import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  // The tests use a config with a different owner, so a name written into the code shows up as a failure.
  resolve: {
    alias: [{ find: /^.*\/pr-board\.config\.json$/, replacement: fileURLToPath(new URL('test/fixtures/pr-board.config.json', import.meta.url)) }],
  },
});
