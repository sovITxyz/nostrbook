// P5: /api/mirror (session-gated publish/delete with tenant isolation),
// editor pages, server-rendered preview parity, and the full
// publish → edit → delete loop observed through the tenant views.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import {
  ALICE_PK,
  BOB_PK,
  MALLORY_SK,
  resetMirrorState,
  resetRateLimits,
  seedAlice,
  sessionCookieFor,
  signDeleteEvent,
  signPostEvent,
  findXssVectors,
} from "../helpers";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceHelloEdit = fixtures.extras.aliceHelloEdit as NostrEvent;
const aliceTorture = fixtures.posts.aliceTorture as NostrEvent;
const aliceXss = fixtures.posts.aliceXss as NostrEvent;
const bobFirst = fixtures.posts.bobFirst as NostrEvent;
const aliceProfile = fixtures.profiles.alice as NostrEvent;
const deleteByAlice = fixtures.delete as NostrEvent;
const tampered = fixtures.tampered as { reason: string; event: NostrEvent }[];

function postMirror(
  event: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch("https://nostrbook.net/api/mirror", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.55",
      ...headers,
    },
    body: JSON.stringify(event),
  });
}

function postPreview(
  markdown: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch("https://nostrbook.net/dashboard/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.55",
      ...headers,
    },
    body: JSON.stringify({ markdown }),
  });
}

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await seedAlice();
});

describe("POST /api/mirror — auth gates", () => {
  it("rejects without a session (401)", async () => {
    const res = await postMirror(aliceHello);
    expect(res.status).toBe(401);
  });

  it("rejects a valid event signed by ANOTHER key (tenant isolation, 403)", async () => {
    // bob's perfectly valid post replayed through alice's session must die.
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(bobFirst, { Cookie: cookie });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
      .bind(bobFirst.id)
      .first();
    expect(row).toBeNull();
  });

  it("rejects a mallory-signed forgery on alice's session (403)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const malloryPost = signPostEvent({
      sk: MALLORY_SK,
      d: "hostile",
      title: "Not alice",
      content: "mallory was here",
      created_at: 1_700_009_000,
    });
    const res = await postMirror(malloryPost, { Cookie: cookie });
    expect(res.status).toBe(403);
  });

  it("returns invalid for a bad signature on the OWN pubkey (422)", async () => {
    const badSig = tampered.find((t) => t.reason === "bad_sig")!.event;
    expect(badSig.pubkey).toBe(ALICE_PK); // passes the pubkey gate on purpose
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(badSig, { Cookie: cookie });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ result: "invalid" });
    const row = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
      .bind(badSig.id)
      .first();
    expect(row).toBeNull();
  });

  it("rejects kinds other than 30023 and 5 (400)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(aliceProfile, { Cookie: cookie });
    expect(res.status).toBe(400);
  });

  it("rejects non-event JSON (400)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror({ not: "an event" }, { Cookie: cookie });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin POST even with a valid session (CSRF, 403)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(aliceHello, {
      Cookie: cookie,
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
      .bind(aliceHello.id)
      .first();
    expect(row).toBeNull();
  });

  it("rate limits mirror writes per pubkey (429, nothing stored)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    // Pre-fill the current fixed window to the cap (MIRROR_MAX = 30/5min,
    // src/routes/api.ts) instead of looping 31 real requests.
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)",
    )
      .bind(`mirror:pk:${ALICE_PK}`, 30, now - (now % 300))
      .run();
    const res = await postMirror(aliceHello, { Cookie: cookie });
    expect(res.status).toBe(429);
    const row = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
      .bind(aliceHello.id)
      .first();
    expect(row).toBeNull();
  });

  it("an alice-signed kind 5 addressing BOB's post cannot hide it", async () => {
    // Bob's post arrives through the normal sync path and his blog is live.
    await mirrorEvent(env, bobFirst);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, 'bob', ?)",
    )
      .bind(BOB_PK, new Date().toISOString())
      .run();

    // Alice signs the delete HERSELF (so the pubkey gate passes) but points
    // its e/a tags at bob's post — applyDelete must scope every side effect
    // to the signer's own rows.
    const cookie = await sessionCookieFor(ALICE_PK);
    const hostile = signDeleteEvent({
      eventId: bobFirst.id,
      address: `30023:${BOB_PK}:bob-first`,
      created_at: bobFirst.created_at + 100,
    }); // default sk = alice
    const res = await postMirror(hostile, { Cookie: cookie });
    expect(res.status).toBe(200); // accepted: it IS alice's own signed event

    const row = await env.DB.prepare(
      "SELECT deleted FROM events WHERE id = ?",
    )
      .bind(bobFirst.id)
      .first<{ deleted: number }>();
    expect(row!.deleted).toBe(0); // bob's row untouched
    const page = await SELF.fetch("https://bob.nostrbook.net/bob-first");
    expect(page.status).toBe(200); // and his blog still serves it
  });
});

describe("POST /api/mirror — publish / edit / delete loop", () => {
  it("stores an own valid post and the tenant view serves it", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(aliceHello, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored" });

    const page = await SELF.fetch("https://alice.nostrbook.net/hello-world");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hello world");
  });

  it("an edit produces a replaceable update visible via the tenant provider", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    expect((await postMirror(aliceHello, { Cookie: cookie })).status).toBe(200);
    const edit = await postMirror(aliceHelloEdit, { Cookie: cookie });
    expect(await edit.json()).toEqual({ result: "stored" });

    const home = await SELF.fetch("https://alice.nostrbook.net/");
    const html = await home.text();
    expect(html).toContain("Hello world (edited)");
    // The old version is GONE (replaceable slot), not listed alongside.
    const rows = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND kind = 30023 AND d_tag = 'hello-world'",
    )
      .bind(ALICE_PK)
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual([aliceHelloEdit.id]);
  });

  it("replaying the older version after an edit reports stale", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    await postMirror(aliceHelloEdit, { Cookie: cookie });
    const res = await postMirror(aliceHello, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stale" });
  });

  it("a signed kind 5 delete hides the post from all tenant views", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    await postMirror(aliceHello, { Cookie: cookie });
    expect(
      (await SELF.fetch("https://alice.nostrbook.net/hello-world")).status,
    ).toBe(200);

    // Committed kind 5 fixture: e-tags aliceHello.id, a-tags its address —
    // the exact shape editor.js signs for the delete button.
    const res = await postMirror(deleteByAlice, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored" });

    expect(
      (await SELF.fetch("https://alice.nostrbook.net/hello-world")).status,
    ).toBe(404);
    const home = await SELF.fetch("https://alice.nostrbook.net/");
    expect(await home.text()).not.toContain("Hello world");
  });

  it("a freshly signed delete (helper) also hides the post", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    await postMirror(aliceHelloEdit, { Cookie: cookie });
    const del = signDeleteEvent({
      eventId: aliceHelloEdit.id,
      address: `30023:${ALICE_PK}:hello-world`,
      created_at: aliceHelloEdit.created_at + 1,
    });
    const res = await postMirror(del, { Cookie: cookie });
    expect(await res.json()).toEqual({ result: "stored" });
    expect(
      (await SELF.fetch("https://alice.nostrbook.net/hello-world")).status,
    ).toBe(404);
  });
});

describe("editor pages", () => {
  it("redirects anonymous users to /login", async () => {
    for (const path of ["/dashboard/posts/new", "/dashboard/editor?slug=hello-world"]) {
      const res = await SELF.fetch(`https://nostrbook.net${path}`, {
        redirect: "manual",
      });
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
    }
  });

  it("serves the blank editor at /dashboard/posts/new", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch("https://nostrbook.net/dashboard/posts/new", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New post");
    expect(html).toContain('id="editor-form"');
    expect(html).toContain("/js/editor.js");
    expect(html).toContain('id="editor-config"');
  });

  it("loads an existing post into the editor by slug", async () => {
    await mirrorEvent(env, aliceHello);
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch(
      "https://nostrbook.net/dashboard/editor?slug=hello-world",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Edit post");
    expect(html).toContain("This is **alice**"); // markdown source in the textarea
    expect(html).toContain('value="Hello world"');
    expect(html).toContain('id="delete-button"');
  });

  it("404s on an unknown slug and on ANOTHER user's slug", async () => {
    await mirrorEvent(env, bobFirst); // bob's post exists in the mirror
    const cookie = await sessionCookieFor(ALICE_PK);
    for (const slug of ["no-such-post", "bob-first"]) {
      const res = await SELF.fetch(
        `https://nostrbook.net/dashboard/editor?slug=${slug}`,
        { headers: { Cookie: cookie } },
      );
      expect(res.status, slug).toBe(404);
    }
  });

  it("neutralizes hostile post metadata in the editor page", async () => {
    await mirrorEvent(env, aliceXss);
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch(
      "https://nostrbook.net/dashboard/editor?slug=xss-test",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The XSS title/summary/content must arrive entity-escaped, never as tags.
    expect(html).not.toContain("<script>alert(");
    expect(html).not.toContain("<img src=x onerror=");
  });
});

describe("POST /dashboard/preview — parity with the publish pipeline", () => {
  it("rejects without a session (401)", async () => {
    const res = await postPreview("# hi");
    expect(res.status).toBe(401);
  });

  it("rejects a non-string body shape (400)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch("https://nostrbook.net/dashboard/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ markdown: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin preview (CSRF, 403)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postPreview("# hi", {
      Cookie: cookie,
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("preview HTML === published (ingest-rendered) HTML, byte for byte", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    // aliceXss included on purpose: parity must hold for hostile markdown
    // too, or the preview would lie about what publishing produces.
    for (const post of [aliceHello, aliceTorture, aliceXss]) {
      await mirrorEvent(env, post);
      const stored = await env.DB.prepare(
        "SELECT rendered FROM events WHERE id = ?",
      )
        .bind(post.id)
        .first<{ rendered: string }>();
      const res = await postPreview(post.content, { Cookie: cookie });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(stored!.rendered);
    }
  });

  it("sanitizes hostile markdown exactly like publishing does", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postPreview(aliceXss.content, { Cookie: cookie });
    const html = await res.text();
    expect(findXssVectors(html, "fragment")).toEqual([]);
  });
});
