import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import keys from "./test/fixtures/keys.json";

export default defineConfig(async () => {
  // Read D1 migrations so every test isolate can apply them (test/apply-migrations.ts).
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        // main worker + bindings come from wrangler.jsonc
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // TEST ONLY (not in wrangler.jsonc): lets integration tests invoke
          // the cron entry point via SELF.scheduled().
          compatibilityFlags: ["service_binding_extra_handlers"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // wrangler.jsonc ships ENVIRONMENT=production (fail closed);
            // tests exercise the dev-only X-Forwarded-Host affordance, and
            // CI has no .dev.vars, so override it here.
            ENVIRONMENT: "development",
            // Cloudflare's official always-passing Turnstile TEST secret —
            // CI has no .dev.vars, and the turnstile unit spec asserts the
            // exact form body the default verifier POSTs.
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            // P7 admin surface: bob is the admin persona in tests (a
            // committed throwaway fixture key). Production gets this via
            // `wrangler secret put ADMIN_PUBKEY`; wrangler dev leaves it
            // unset (admin disabled — smoke asserts the 404).
            ADMIN_PUBKEY: keys.bob.pk,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
