/**
 * Test setup: apply the D1 schema before each test file.
 *
 * Each test file runs in its own isolated storage, so we (re)apply the
 * migrations up front. `applyD1Migrations` records applied migrations in a
 * bookkeeping table, so calling it repeatedly is a no-op after the first run.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
