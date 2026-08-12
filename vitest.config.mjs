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
    // #339: stays on the default 'forks' pool (one real OS process per isolated
    // test file) deliberately. 'threads' was evaluated as a fix for the vitest 4
    // Windows slowdown (see tests/agy/emit.test.mjs) but rejected: worker_threads
    // share ONE process, so process.cwd() is process-global, not thread-local —
    // switching pools broke tests/lib/board.test.mjs AC-415.1/AC-415.2 (which rely
    // on process.chdir() being isolated per concurrently-running test file) and
    // introduced a race in tests/lib/lock.test.mjs. The real fix for the slow test
    // is at the test itself — see the comment on the AC-289.2 spawn helper.
  },
});
