import { env, SELF } from "cloudflare:test";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import keys from "./fixtures/keys.json";
import type { NostrEvent } from "../src/nostr/event";
import { createSession } from "../src/services/sessions";
import { defaultCache } from "../src/middleware/cache";
import { discoverCacheKey } from "../src/routes/main";
import { DISCOVER_MAX_PAGE } from "../src/services/events";

export const ALICE_PK = keys.alice.pk;
export const BOB_PK = keys.bob.pk;
export const MALLORY_PK = keys.mallory.pk;
export const ALICE_SK = keys.alice.sk;
export const BOB_SK = keys.bob.sk;
export const MALLORY_SK = keys.mallory.sk;

/** Seed alice as a claimed user (handle "alice") into the test D1. */
export async function seedAlice(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
  )
    .bind(ALICE_PK, "alice", new Date().toISOString())
    .run();
}

/** Seed bob as a claimed user (handle "bob") into the test D1. */
export async function seedBob(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
  )
    .bind(BOB_PK, "bob", new Date().toISOString())
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
 * Wipe all mirror state (events, posts_fts, profiles, delete horizons, gen
 * counters). Storage persists across `it` blocks within a test file, so specs
 * that assert exact counts/generations reset explicitly in beforeEach.
 */
export async function resetMirrorState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM posts_fts"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM profiles"),
    env.DB.prepare("DELETE FROM delete_horizons"),
  ]);
  await Promise.all(
    [ALICE_PK, BOB_PK, MALLORY_PK].map((pk) => env.KV.delete(`gen:${pk}`)),
  );
}

/**
 * Wipe rate-limit counters. The D1 rate_limits table persists across `it`
 * blocks within a file; auth/claim specs reset it so unrelated tests never
 * trip each other's per-IP windows.
 */
export async function resetRateLimits(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits").run();
}

/** Wipe all users (claim specs need a clean slate per test). */
export async function resetUsers(): Promise<void> {
  await env.DB.prepare("DELETE FROM users").run();
}

/**
 * Purge every possible discover-feed Cache API entry (pages
 * 1..DISCOVER_MAX_PAGE). The Cache API persists across `it` blocks within a
 * file, so specs that mutate posts and re-fetch /discover must purge or
 * they read the previous test's page (review fix: /discover is now cached
 * through caches.default, not just an advisory s-maxage header).
 */
export async function resetDiscoverCache(): Promise<void> {
  await Promise.all(
    Array.from({ length: DISCOVER_MAX_PAGE }, (_, i) =>
      defaultCache().delete(discoverCacheKey(i + 1)),
    ),
  );
}

/**
 * Sign a kind 22242 login event for a challenge with one of the committed
 * throwaway fixture keys (nostr-tools). Overrides let tests build the
 * rejection cases (wrong kind, stale created_at, forged fields, missing or
 * misbound relay tag — pass `relay: null` to omit the tag entirely).
 */
export function signLoginEvent(
  challenge: string,
  opts: {
    sk?: string;
    kind?: number;
    created_at?: number;
    relay?: string | null;
  } = {},
): NostrEvent {
  const tags: string[][] = [];
  if (opts.relay !== null) {
    tags.push(["relay", opts.relay ?? "wss://nbread.lol"]);
  }
  tags.push(["challenge", challenge]);
  return finalizeEvent(
    {
      kind: opts.kind ?? 22242,
      created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/** Fetch a login challenge nonce from the worker. */
export async function getChallenge(ip = "10.0.0.1"): Promise<string> {
  const res = await SELF.fetch("https://nbread.lol/login/challenge", {
    headers: { "CF-Connecting-IP": ip },
  });
  if (res.status !== 200) {
    throw new Error(`challenge request failed: ${res.status}`);
  }
  const body = (await res.json()) as { challenge: string };
  return body.challenge;
}

/** POST a login event to /login. */
export function postLogin(
  event: unknown,
  opts: { ip?: string; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": opts.ip ?? "10.0.0.1",
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return SELF.fetch("https://nbread.lol/login", {
    method: "POST",
    headers,
    body: typeof event === "string" ? event : JSON.stringify(event),
  });
}

/**
 * Mint a real KV-backed session for a pubkey and return the Cookie header
 * value. P5 dashboard/editor/API specs authenticate with this.
 */
export async function sessionCookieFor(pubkey: string): Promise<string> {
  const token = await createSession(env, pubkey);
  return `sid=${token}`;
}

/**
 * Sign a kind 30023 long-form post with a committed fixture key
 * (nostr-tools). Mirrors the tag shape public/js/editor.js produces:
 * d + title + published_at (+ summary when given).
 */
export function signPostEvent(opts: {
  sk?: string;
  d: string;
  title: string;
  summary?: string;
  content: string;
  created_at: number;
  published_at?: number;
}): NostrEvent {
  const tags: string[][] = [
    ["d", opts.d],
    ["title", opts.title],
    ["published_at", String(opts.published_at ?? opts.created_at)],
  ];
  if (opts.summary !== undefined) tags.push(["summary", opts.summary]);
  return finalizeEvent(
    {
      kind: 30023,
      created_at: opts.created_at,
      tags,
      content: opts.content,
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/**
 * Sign a kind 0 profile with a committed fixture key. `content` may be the
 * metadata object (stringified here, like public/js/profile.js does) or a
 * raw string for malformed-content tests.
 */
export function signProfileEvent(opts: {
  sk?: string;
  content: string | Record<string, unknown>;
  created_at: number;
  tags?: string[][];
}): NostrEvent {
  return finalizeEvent(
    {
      kind: 0,
      created_at: opts.created_at,
      tags: opts.tags ?? [],
      content:
        typeof opts.content === "string"
          ? opts.content
          : JSON.stringify(opts.content),
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/**
 * Sign an event of an arbitrary kind with a fixture key — rejection-path
 * tests (kinds the mirror/relay must refuse) build their probes with this.
 */
export function signRawEvent(opts: {
  sk?: string;
  kind: number;
  created_at: number;
  tags?: string[][];
  content?: string;
}): NostrEvent {
  return finalizeEvent(
    {
      kind: opts.kind,
      created_at: opts.created_at,
      tags: opts.tags ?? [],
      content: opts.content ?? "",
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/**
 * Sign a kind 5 delete with a committed fixture key. Mirrors editor.js:
 * e-tag the stored event id, a-tag the replaceable address.
 */
export function signDeleteEvent(opts: {
  sk?: string;
  eventId?: string;
  address?: string;
  created_at: number;
}): NostrEvent {
  const tags: string[][] = [];
  if (opts.eventId !== undefined) tags.push(["e", opts.eventId]);
  if (opts.address !== undefined) tags.push(["a", opts.address]);
  return finalizeEvent(
    {
      kind: 5,
      created_at: opts.created_at,
      tags,
      content: "Deleted via nbread.lol",
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/**
 * Hostile FTS5 MATCH corpus (P6 brief: `"`, `*`, `NEAR(`, `-`, `a OR b`,
 * `title:x`, `(`, `a"b`, bare operators) + extras. Shared by the sanitizer
 * unit spec (output shape) and the search integration spec (HTTP 200, never
 * a 5xx).
 */
export const MATCH_INJECTION_CORPUS = [
  '"',
  "*",
  "NEAR(",
  "-",
  "a OR b",
  "title:x",
  "(",
  'a"b',
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "^first",
  "a* b*",
  "-excluded term",
  '"unbalanced phrase',
  "((()))",
  "title : x",
  "content:secret OR summary:hidden",
  'a AND -b OR (c NEAR/2 d)* ^e "f',
  "{col}:x + y",
  '\\" OR 1=1 --',
];

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
