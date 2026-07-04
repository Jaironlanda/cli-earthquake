/**
 * Vitest configuration for the Earthquake CLI Worker tests.
 *
 * Tests run *inside* the Workers runtime via `@cloudflare/vitest-pool-workers`
 * (workerd + Miniflare), so they get the real `DB` (D1), `TERMINAL_HUB`
 * (Durable Object) and `ASSETS` bindings declared in `wrangler.jsonc` — no
 * mocking of the platform. See `docs/API.md` for the surface under test.
 */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Config is async so we can read the D1 migrations at load time (Node context)
// and hand them to the test Worker as a binding. `test/apply-migrations.ts`
// applies them before each test file runs, so every test starts against the
// real schema. (Async-function form avoids top-level await, unsupported here.)
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
    plugins: [
      cloudflareTest({
        // Reuse the project's Wrangler config so bindings/compat match production.
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Pin secrets/vars for hermetic tests rather than inheriting a
          // developer's `.dev.vars`: a deterministic `ADMIN_TOKEN` and an empty
          // `PROTOMAPS_KEY` (its documented default). `DB`, `TERMINAL_HUB` and
          // `ASSETS` come from wrangler.jsonc.
          bindings: {
            ADMIN_TOKEN: "test-admin-token",
            PROTOMAPS_KEY: "",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
  };
});
