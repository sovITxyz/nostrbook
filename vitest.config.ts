import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  // Read D1 migrations so every test isolate can apply them (test/apply-migrations.ts).
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        // main worker + bindings come from wrangler.jsonc
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // wrangler.jsonc ships ENVIRONMENT=production (fail closed);
            // tests exercise the dev-only X-Forwarded-Host affordance, and
            // CI has no .dev.vars, so override it here.
            ENVIRONMENT: "development",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
