// Env augmentation for OPTIONAL deploy-time secrets that `wrangler types`
// cannot know about (worker-configuration.d.ts is generated from
// wrangler.jsonc vars + .dev.vars and would drop hand edits on regeneration).
// This file must stay a global script (no top-level imports/exports) so the
// interfaces merge with the generated declarations.

interface Env {
  /**
   * Admin identity for the abuse-blocklist surface (P7): the hex pubkey (or
   * npub1…) whose SESSION may use /admin. Set via
   * `wrangler secret put ADMIN_PUBKEY`; tests inject it via vitest.config.ts.
   * Unset, empty, or malformed ⇒ the admin surface is entirely disabled
   * (every /admin route 404s) — fail closed.
   */
  ADMIN_PUBKEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_PUBKEY?: string;
  }
}
