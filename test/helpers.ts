import { env } from "cloudflare:test";
import keys from "./fixtures/keys.json";

export const ALICE_PK = keys.alice.pk;
export const BOB_PK = keys.bob.pk;
export const MALLORY_PK = keys.mallory.pk;

/** Seed alice as a claimed user (handle "alice") into the test D1. */
export async function seedAlice(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
  )
    .bind(ALICE_PK, "alice", new Date().toISOString())
    .run();
}

/** Seed a blocked user (mallory, handle "blocked") into the test D1. */
export async function seedBlockedMallory(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at, blocked) VALUES (?, ?, ?, 1)",
  )
    .bind(MALLORY_PK, "blocked", new Date().toISOString())
    .run();
}

/**
 * Wipe all mirror state (events, posts_fts, profiles, gen counters).
 * Storage persists across `it` blocks within a test file, so specs that
 * assert exact counts/generations reset explicitly in beforeEach.
 */
export async function resetMirrorState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM posts_fts"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM profiles"),
  ]);
  await Promise.all(
    [ALICE_PK, BOB_PK, MALLORY_PK].map((pk) => env.KV.delete(`gen:${pk}`)),
  );
}

/** All real tags (`<...>`) in an HTML string. Escaped text can't contain `<`. */
export function extractTags(html: string): string[] {
  return html.match(/<[a-zA-Z/!][^>]*>?/g) ?? [];
}

/**
 * Scan HTML output for XSS vectors. Returns a list of offending findings
 * (empty = clean). Checks:
 *   - forbidden elements anywhere (script/iframe/object/embed/form/style...);
 *   - on* attributes inside any tag;
 *   - javascript:/vbscript:/data: URLs in href/src attributes.
 * Text-level occurrences of e.g. "onerror=" or "javascript:" are fine — they
 * are inert once the `<` that would open a tag is escaped.
 */
export function findXssVectors(
  html: string,
  mode: "fragment" | "page" = "fragment",
): string[] {
  const findings: string[] = [];
  const lower = html.toLowerCase();
  // A full page legitimately contains <style> (sanitized theme CSS), <link>
  // and <meta> from the layout; sanitized post FRAGMENTS may contain none.
  const forbidden =
    mode === "fragment"
      ? [
          "<script",
          "<iframe",
          "<object",
          "<embed",
          "<form",
          "<style",
          "<svg",
          "<math",
          "<base",
          "<link",
          "<meta",
        ]
      : ["<script", "<iframe", "<object", "<embed", "<form", "<svg", "<math", "<base"];
  for (const el of forbidden) {
    if (lower.includes(el)) findings.push(`forbidden element: ${el}`);
  }
  for (const tag of extractTags(html)) {
    if (/\son[a-z0-9]+\s*=/i.test(tag)) {
      findings.push(`event handler attr in tag: ${tag}`);
    }
    if (
      /(?:href|src|action|formaction|xlink:href|data)\s*=\s*["']?\s*(?:javascript|vbscript|data)\s*:/i.test(
        tag,
      )
    ) {
      findings.push(`dangerous URL in tag: ${tag}`);
    }
  }
  return findings;
}
