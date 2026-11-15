import { defineConfig } from "vitest/config";

// The ledger integration tests shell out to real `bd`, and `bd init` creates
// a Dolt database — seconds, not milliseconds. Fast tests still finish fast;
// only the ceiling moves.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
