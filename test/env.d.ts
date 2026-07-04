/**
 * Type augmentations for the test environment.
 *
 * `env` from `cloudflare:test` is typed as `Cloudflare.Env`; `wrangler types`
 * generates that interface empty for this project (the Worker uses its own
 * hand-written `Env` in `src/types.ts`), so we declare here the bindings the
 * tests actually touch — including the test-only `TEST_MIGRATIONS` binding fed
 * in from `vitest.config.ts`.
 */
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ADMIN_TOKEN: string;
      PROTOMAPS_KEY: string;
      /** Migrations read in vitest.config.ts, applied in apply-migrations.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
