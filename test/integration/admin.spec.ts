// P7 abuse-blocklist admin: /admin exists ONLY for the ADMIN_PUBKEY session
// (bob in tests — vitest.config.ts injects the binding); everyone else gets
// an indistinguishable 404, and an unset/malformed ADMIN_PUBKEY disables the
// surface entirely. Blocking must take effect EVERYWHERE: blog host + npub
// views 404 (previously-cached pages die via the gen bump), the author drops
// out of discover/search and NIP-05 nostr.json, and writes/claims refuse.
// Unblocking restores.
import { SELF, env, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import {
  ALICE_PK,
  ALICE_SK,
  BOB_PK,
  MALLORY_PK,
  seedAlice,
  sessionCookieFor,
  signPostEvent,
  resetDiscoverCache,
} from "../helpers";
import { app } from "../../src/app";
import { mirrorEvent } from "../../src/services/mirror";
import { npubEncode } from "../../src/nostr/nip19";
import {
  ADMIN_ACTION_MAX,
  ADMIN_ACTION_WINDOW_SECONDS,
  adminPubkeyOf,
} from "../../src/routes/admin";
import type { NostrEvent } from "../../src/nostr/event";

const aliceProfile = fixtures.profiles.alice as NostrEvent;
const aliceHello = fixtures.posts.aliceHello as NostrEvent;

let adminCookie: string;
let aliceCookie: string;
let malloryCookie: string;

/** POST an /admin action as form data. */
function postAdmin(
  path: string,
  target: string,
  opts: { cookie?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin) headers.Origin = opts.origin;
  return SELF.fetch(`https://nbread.lol${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ target }),
    redirect: "manual",
  });
}

/** Pin a rate_limits counter to a count in the CURRENT window. */
async function seedCounter(
  key: string,
  count: number,
  windowSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = excluded.count, window_start = excluded.window_start`,
  )
    .bind(key, count, windowStart)
    .run();
}

beforeAll(async () => {
  await seedAlice();
  expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
  expect(await mirrorEvent(env, aliceHello)).toBe("stored");
  adminCookie = await sessionCookieFor(BOB_PK);
  aliceCookie = await sessionCookieFor(ALICE_PK);
  malloryCookie = await sessionCookieFor(MALLORY_PK);
});

describe("admin gate", () => {
  it("test env wires bob as the admin", () => {
    expect(adminPubkeyOf(env)).toBe(BOB_PK);
  });

  it("resolves npub-form ADMIN_PUBKEY and fails closed on garbage", () => {
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: npubEncode(BOB_PK) })).toBe(
      BOB_PK,
    );
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: BOB_PK.toUpperCase() })).toBe(
      BOB_PK,
    );
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: "" })).toBeNull();
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: "   " })).toBeNull();
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: "npub1zzzz" })).toBeNull();
    expect(adminPubkeyOf({ ...env, ADMIN_PUBKEY: "deadbeef" })).toBeNull();
  });

  it("anonymous callers get 404", async () => {
    const res = await SELF.fetch("https://nbread.lol/admin");
    expect(res.status).toBe(404);
  });

  it("non-admin sessions (mallory) get 404 on GET and POST", async () => {
    const page = await SELF.fetch("https://nbread.lol/admin", {
      headers: { Cookie: malloryCookie },
    });
    expect(page.status).toBe(404);
    const action = await postAdmin("/admin/block", "alice", {
      cookie: malloryCookie,
    });
    expect(action.status).toBe(404);
  });

  it("the admin session gets the page", async () => {
    const res = await SELF.fetch("https://nbread.lol/admin", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Block a user");
  });

  it("unset ADMIN_PUBKEY disables the surface entirely (even for the admin)", async () => {
    for (const value of ["", "not-a-key"]) {
      const res = await app.fetch(
        new Request("https://nbread.lol/admin", {
          headers: { Cookie: adminCookie },
        }),
        { ...env, ADMIN_PUBKEY: value },
        createExecutionContext(),
      );
      expect(res.status).toBe(404);
    }
  });

  it("CSRF: cross-origin admin POSTs are rejected before the handler", async () => {
    const res = await postAdmin("/admin/block", "alice", {
      cookie: adminCookie,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("admin actions are rate limited per admin key", async () => {
    await seedCounter(
      `admin:pk:${BOB_PK}`,
      ADMIN_ACTION_MAX,
      ADMIN_ACTION_WINDOW_SECONDS,
    );
    const res = await postAdmin("/admin/block", "alice", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(429);
    // Clear the counter so the flow tests below are unaffected.
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?")
      .bind(`admin:pk:${BOB_PK}`)
      .run();
  });

  it("rejects unresolvable targets", async () => {
    const missing = await postAdmin("/admin/block", "no-such-handle", {
      cookie: adminCookie,
    });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("No user with that handle");

    const badNpub = await postAdmin(
      "/admin/block",
      `npub1${"z".repeat(58)}`,
      { cookie: adminCookie },
    );
    expect(badNpub.status).toBe(400);

    const empty = await postAdmin("/admin/block", "   ", {
      cookie: adminCookie,
    });
    expect(empty.status).toBe(400);
  });

  it("refuses to block the admin key itself", async () => {
    const res = await postAdmin("/admin/block", npubEncode(BOB_PK), {
      cookie: adminCookie,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Refusing to block the admin key");
  });
});

describe("block → everywhere → unblock (alice, claimed)", () => {
  it("runs the full lifecycle", async () => {
    // --- Pre-block state: everything visible -----------------------------
    const warm1 = await SELF.fetch("https://alice.nbread.lol/");
    expect(warm1.status).toBe(200);
    const warm2 = await SELF.fetch("https://alice.nbread.lol/");
    expect(warm2.headers.get("X-Nbread-Cache")).toBe("hit"); // page is CACHED

    await resetDiscoverCache();
    const discoverBefore = await SELF.fetch("https://nbread.lol/discover");
    expect(await discoverBefore.text()).toContain("Hello world");

    const searchBefore = await SELF.fetch(
      "https://nbread.lol/search?q=hello",
      { headers: { "CF-Connecting-IP": "10.1.1.1" } },
    );
    expect(await searchBefore.text()).toContain("Hello world");

    const nip05Before = await SELF.fetch(
      "https://nbread.lol/.well-known/nostr.json?name=alice",
    );
    expect(((await nip05Before.json()) as { names: Record<string, string> }).names.alice).toBe(
      ALICE_PK,
    );

    const genBefore = await env.KV.get(`gen:${ALICE_PK}`);

    // --- Block (by handle) ------------------------------------------------
    const block = await postAdmin("/admin/block", "alice", {
      cookie: adminCookie,
    });
    expect(block.status).toBe(303);
    expect(block.headers.get("Location")).toBe("/admin?ok=blocked");

    // Gen bumped → previously-cached pages are stranded.
    expect(await env.KV.get(`gen:${ALICE_PK}`)).not.toBe(genBefore);

    // Blog host 404s — INCLUDING the page that was just served from cache.
    const blog = await SELF.fetch("https://alice.nbread.lol/");
    expect(blog.status).toBe(404);
    const post = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(post.status).toBe(404);

    // npub view 404s (claimed handles normally redirect; blocked → 404).
    const npubView = await SELF.fetch(
      `https://nbread.lol/${npubEncode(ALICE_PK)}`,
      { headers: { "CF-Connecting-IP": "10.1.1.2" } },
    );
    expect(npubView.status).toBe(404);

    // Dropped from discover (page cache purged → fresh query) and search.
    await resetDiscoverCache();
    const discoverAfter = await SELF.fetch("https://nbread.lol/discover");
    expect(await discoverAfter.text()).not.toContain("Hello world");
    const searchAfter = await SELF.fetch(
      "https://nbread.lol/search?q=hello",
      { headers: { "CF-Connecting-IP": "10.1.1.1" } },
    );
    expect(await searchAfter.text()).not.toContain("Hello world");

    // NIP-05: blocked users are DROPPED from nostr.json (documented policy).
    const nip05After = await SELF.fetch(
      "https://nbread.lol/.well-known/nostr.json?name=alice",
    );
    expect((await nip05After.json()) as object).toEqual({ names: {} });

    // Writes refuse: editor mirror (P5 gate)…
    const signed = signPostEvent({
      sk: ALICE_SK,
      d: "while-blocked",
      title: "Nope",
      content: "should not land",
      created_at: Math.floor(Date.now() / 1000),
    });
    const mirror = await SELF.fetch("https://nbread.lol/api/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify(signed),
    });
    expect(mirror.status).toBe(403);

    // …settings (P5 gate)…
    const settings = await SELF.fetch(
      "https://nbread.lol/dashboard/settings",
      {
        method: "POST",
        headers: { Cookie: aliceCookie },
        body: new URLSearchParams({ css: "", about: "", relays: "" }),
      },
    );
    expect(settings.status).toBe(403);

    // …the server-rendered preview (P7 review fix: the one endpoint allowed
    // to run renderPost on the request path refuses blocked keys — blocked
    // identities must not spend request-path CPU)…
    const preview = await SELF.fetch(
      "https://nbread.lol/dashboard/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({ markdown: "# nope" }),
      },
    );
    expect(preview.status).toBe(403);

    // …and claim (P4 gate — alice already holds a handle, but the blocked
    // check fires first and hides even the "already claimed" signal).
    const claim = await SELF.fetch("https://nbread.lol/dashboard/claim", {
      method: "POST",
      headers: { Cookie: aliceCookie, "CF-Connecting-IP": "10.1.1.3" },
      body: new URLSearchParams({ handle: "alice2" }),
    });
    expect(claim.status).toBe(403);
    expect(await claim.text()).toContain("blocked");

    // --- Unblock (by npub, exercising the second target form) -------------
    const unblock = await postAdmin(
      "/admin/unblock",
      npubEncode(ALICE_PK),
      { cookie: adminCookie },
    );
    expect(unblock.status).toBe(303);

    const restored = await SELF.fetch("https://alice.nbread.lol/");
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain("Hello world");

    // Preview works again post-unblock (blocked gate, not a lingering state).
    const previewRestored = await SELF.fetch(
      "https://nbread.lol/dashboard/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({ markdown: "# back" }),
      },
    );
    expect(previewRestored.status).toBe(200);

    const nip05Restored = await SELF.fetch(
      "https://nbread.lol/.well-known/nostr.json?name=alice",
    );
    expect(
      ((await nip05Restored.json()) as { names: Record<string, string> })
        .names.alice,
    ).toBe(ALICE_PK);

    await resetDiscoverCache();
    const discoverRestored = await SELF.fetch(
      "https://nbread.lol/discover",
    );
    expect(await discoverRestored.text()).toContain("Hello world");
  });
});

describe("block by npub (mallory, never claimed)", () => {
  it("pre-emptively blocks an unclaimed key: npub 404s and claim refuses", async () => {
    const block = await postAdmin(
      "/admin/block",
      npubEncode(MALLORY_PK),
      { cookie: adminCookie },
    );
    expect(block.status).toBe(303);

    // The npub view 404s WITHOUT any relay contact (resolveNpub checks the
    // users row first).
    const view = await SELF.fetch(
      `https://nbread.lol/${npubEncode(MALLORY_PK)}`,
      { headers: { "CF-Connecting-IP": "10.1.2.1" } },
    );
    expect(view.status).toBe(404);

    // The blocked key cannot claim a handle.
    const claim = await SELF.fetch("https://nbread.lol/dashboard/claim", {
      method: "POST",
      headers: { Cookie: malloryCookie, "CF-Connecting-IP": "10.1.2.2" },
      body: new URLSearchParams({ handle: "mallory" }),
    });
    expect(claim.status).toBe(403);
    expect(await claim.text()).toContain("blocked");

    // The admin page lists the blocked key for later unblocking.
    const page = await SELF.fetch("https://nbread.lol/admin", {
      headers: { Cookie: adminCookie },
    });
    expect(await page.text()).toContain(npubEncode(MALLORY_PK));

    const unblock = await postAdmin(
      "/admin/unblock",
      npubEncode(MALLORY_PK),
      { cookie: adminCookie },
    );
    expect(unblock.status).toBe(303);
    const claim2 = await SELF.fetch("https://nbread.lol/dashboard/claim", {
      method: "POST",
      headers: { Cookie: malloryCookie, "CF-Connecting-IP": "10.1.2.3" },
      body: new URLSearchParams({ handle: "mallory" }),
    });
    // The blocked gate no longer fires — the claim proceeds to the NEXT
    // check (Turnstile, which 403s here because no token is supplied, with
    // a different message).
    const claim2Body = await claim2.text();
    expect(claim2Body).not.toContain("This account is blocked");
    expect(claim2Body).toContain("Human verification failed");
  });
});

describe("block by handle that starts with npub1 (review fix)", () => {
  // HANDLE_REGEX admits handles like "npub1spam" (2–31 chars; real npubs are
  // 63 and can never match), and a hostile user can deliberately claim one so
  // that the admin pasting the handle from the abusive blog URL hits a
  // "npub does not decode" dead end during an incident. resolveTarget must
  // fall through to the handle lookup.
  const CAROL_PK = "c0".repeat(32); // synthetic never-logged-in key

  it("resolves an npub1-prefixed CLAIMED handle through the handle lookup", async () => {
    await env.DB.prepare(
      "INSERT INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
    )
      .bind(CAROL_PK, "npub1spam", new Date().toISOString())
      .run();

    const block = await postAdmin("/admin/block", "npub1spam", {
      cookie: adminCookie,
    });
    expect(block.status).toBe(303);
    let row = await env.DB.prepare(
      "SELECT blocked FROM users WHERE pubkey = ?",
    )
      .bind(CAROL_PK)
      .first<{ blocked: number }>();
    expect(row?.blocked).toBe(1);

    // Unblock resolves through the same fallback.
    const unblock = await postAdmin("/admin/unblock", "npub1spam", {
      cookie: adminCookie,
    });
    expect(unblock.status).toBe(303);
    row = await env.DB.prepare("SELECT blocked FROM users WHERE pubkey = ?")
      .bind(CAROL_PK)
      .first<{ blocked: number }>();
    expect(row?.blocked).toBe(0);
  });

  it("npub1-prefixed handle-shaped NON-handles report the handle error", async () => {
    const res = await postAdmin("/admin/block", "npub1nobody", {
      cookie: adminCookie,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No user with that handle");
  });

  it("full-length undecodable npubs still get the decode error", async () => {
    const res = await postAdmin("/admin/block", `npub1${"z".repeat(58)}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That npub does not decode");
  });
});
