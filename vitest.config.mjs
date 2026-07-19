import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    watch: false,
    // Point the forge-control base at a clean temp dir so tests never read the real
    // machine kill switch (~/.forge/control/paused) — otherwise an engaged pause makes
    // deriveSituation-based tests fail locally while CI (clean machines) passes (#93).
    // Tests that exercise paused inject their own base and are unaffected.
    env: { FORGE_CONTROL_BASE: join(tmpdir(), 'forge-vitest-no-control') },
  },
});
