import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    watch: false,
    // CI runs on self-hosted runners of variable speed (the ephemeral container
    // runner is ~1.3x slower than a dev box), so the default 5s timeout flakes on
    // borderline tests (e.g. the graph reindex test, ~6.6s on the runner). Give
    // generous headroom — still far below any real hang. See #251.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
