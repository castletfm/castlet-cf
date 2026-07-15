import { applyD1Migrations, env } from "cloudflare:test";

// Apply all D1 migrations before each test file runs, so tests always see
// the schema from migrations/.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
