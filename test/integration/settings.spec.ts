// P5: dashboard settings (theme CSS sanitized at WRITE time, about, relay
// list) merged into users.settings via json_set — the cron sync watermark
// ($.sync.since) must survive every save — plus the dashboard page itself
// (post list, edit links, new-post button, settings form).
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import {
  ALICE_PK,
  BOB_PK,
  MALLORY_PK,
  resetMirrorState,
  resetRateLimits,
  resetUsers,
  seedAlice,
  seedBlockedMallory,
  sessionCookieFor,
} from "../helpers";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";
import { SETTINGS_MAX } from "../../src/routes/dashboard";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;

function postSettings(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch("https://nbread.lol/dashboard/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": "203.0.113.66",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

async function settingsRow(pubkey: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "SELECT settings FROM users WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ settings: string }>();
  return JSON.parse(row!.settings) as Record<string, unknown>;
}

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await resetUsers();
  await seedAlice();
});

describe("POST /dashboard/settings", () => {
  it("rejects without a session (401)", async () => {
    const res = await postSettings({ css: "body{}" });
    expect(res.status).toBe(401);
  });

  it("rejects a cross-origin POST (CSRF, 403)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postSettings(
      { css: "body{color:red}" },
      { Cookie: cookie, Origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("stores hostile theme CSS DECLAWED (sanitized at write time)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const hostile =
      "@import url(https://evil.example/x.css);\n" +
      "body { background: url('https://evil.example/beacon.png') }\n" +
      "</style><script>alert(1)</script>\n" +
      "h1 { color: expression(alert(2)); behavior: url(x.htc) }\n" +
      "p { color: red }";
    const res = await postSettings({ css: hostile }, { Cookie: cookie });
    expect(res.status).toBe(303);

    const settings = await settingsRow(ALICE_PK);
    const stored = settings.css as string;
    // Declawed in D1 — not merely at render time.
    expect(stored).not.toContain("@import");
    expect(stored).not.toMatch(/url\s*\(/i);
    expect(stored).not.toContain("<");
    expect(stored).not.toMatch(/expression\s*\(/i);
    expect(stored).not.toContain("behavior:");
    // Benign CSS survives.
    expect(stored).toContain("color: red");
  });

  it("stores about text and a validated relay list", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postSettings(
      {
        about: "  words about my blog  ",
        relays: "wss://relay.damus.io\n wss://nos.lol \n",
        css: "",
      },
      { Cookie: cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard?saved=1");

    const settings = await settingsRow(ALICE_PK);
    expect(settings.about).toBe("words about my blog");
    expect(settings.relays).toEqual(["wss://relay.damus.io/", "wss://nos.lol/"]);
  });

  it("rejects non-wss relay URLs wholesale (400, nothing stored)", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    for (const bad of [
      "http://relay.damus.io",
      "wss://good.example\njavascript:alert(1)",
      "not a url",
      "wss://user:pass@relay.example",
    ]) {
      const res = await postSettings(
        { relays: bad, about: "x", css: "" },
        { Cookie: cookie },
      );
      expect(res.status, bad).toBe(400);
    }
    const settings = await settingsRow(ALICE_PK);
    expect(settings.relays).toBeUndefined();
  });

  it("preserves the cron sync watermark ($.sync.since) across saves", async () => {
    await env.DB.prepare("UPDATE users SET settings = ? WHERE pubkey = ?")
      .bind('{"sync":{"since":12345},"css":"old { }"}', ALICE_PK)
      .run();
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postSettings(
      { css: "body { color: blue }", about: "hi", relays: "" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(303);

    const settings = await settingsRow(ALICE_PK);
    expect(settings.sync).toEqual({ since: 12345 }); // NOT clobbered
    expect(settings.css).toBe("body { color: blue }");
    expect(settings.about).toBe("hi");
  });

  it("bumps gen:<pubkey> so the cached blog refreshes", async () => {
    const before = await env.KV.get(`gen:${ALICE_PK}`);
    const cookie = await sessionCookieFor(ALICE_PK);
    await postSettings({ css: "body{}", about: "", relays: "" }, { Cookie: cookie });
    const after = await env.KV.get(`gen:${ALICE_PK}`);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("creates the users row for a signed-in key that never claimed", async () => {
    const cookie = await sessionCookieFor(BOB_PK); // bob has no users row
    const res = await postSettings(
      { about: "bob was here", relays: "", css: "" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(303);
    const settings = await settingsRow(BOB_PK);
    expect(settings.about).toBe("bob was here");
    const row = await env.DB.prepare(
      "SELECT handle FROM users WHERE pubkey = ?",
    )
      .bind(BOB_PK)
      .first<{ handle: string | null }>();
    expect(row?.handle).toBeNull(); // settings save never grants a handle
  });

  it("the saved theme CSS actually reaches the blog page (sanitized)", async () => {
    await mirrorEvent(env, aliceHello);
    const cookie = await sessionCookieFor(ALICE_PK);
    await postSettings(
      { css: "body { background: #fffdf5 }", about: "", relays: "" },
      { Cookie: cookie },
    );
    const page = await SELF.fetch("https://alice.nbread.lol/");
    const html = await page.text();
    expect(html).toContain("background: #fffdf5");
  });
});

describe("GET /dashboard — post list + settings form", () => {
  it("shows the user's posts with edit links, the new-post button, and the settings form", async () => {
    await mirrorEvent(env, aliceHello);
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello world"); // own post listed
    expect(html).toContain('href="/dashboard/editor?slug=hello-world"'); // edit link
    expect(html).toContain('href="/dashboard/posts/new"'); // new post button
    expect(html).toContain('action="/dashboard/settings"'); // settings form
    expect(html).toContain('name="css"');
    expect(html).toContain('name="about"');
    expect(html).toContain('name="relays"');
  });

  it("does not list other users' posts", async () => {
    await mirrorEvent(env, fixtures.posts.bobFirst as NostrEvent);
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: cookie },
    });
    const html = await res.text();
    expect(html).not.toContain("Bob&#39;s first post");
    expect(html).not.toContain("bob-first");
  });

  it("round-trips saved settings back into the form", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    await postSettings(
      { css: "body { color: teal }", about: "hello about", relays: "wss://nos.lol" },
      { Cookie: cookie },
    );
    const res = await SELF.fetch("https://nbread.lol/dashboard?saved=1", {
      headers: { Cookie: cookie },
    });
    const html = await res.text();
    expect(html).toContain("Settings saved.");
    expect(html).toContain("body { color: teal }");
    expect(html).toContain("hello about");
    expect(html).toContain("wss://nos.lol/");
  });
});

// --- P5 review fixes -------------------------------------------------------------

describe("POST /dashboard/settings — review-fix hardening", () => {
  it(`rate limits saves (429 after ${SETTINGS_MAX} in the window)`, async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    for (let i = 0; i < SETTINGS_MAX; i++) {
      const res = await postSettings(
        { css: "", about: `v${i}`, relays: "" },
        { Cookie: cookie },
      );
      expect(res.status, `save ${i + 1}`).toBe(303);
    }
    const res = await postSettings(
      { css: "", about: "over the limit", relays: "" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(429);
    // The over-limit save persisted nothing.
    const settings = await settingsRow(ALICE_PK);
    expect(settings.about).toBe(`v${SETTINGS_MAX - 1}`);
  });

  it("rejects a blocked user's save (403, nothing persisted)", async () => {
    await seedBlockedMallory();
    const cookie = await sessionCookieFor(MALLORY_PK); // live session, blocked key
    const res = await postSettings(
      { css: "body{}", about: "still here?", relays: "" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(403);
    const settings = await settingsRow(MALLORY_PK);
    expect(settings.about).toBeUndefined();
  });

  it("a no-op save and a relays-only change cost zero KV gen bumps", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    await postSettings(
      { css: "body { color: teal }", about: "hi", relays: "" },
      { Cookie: cookie },
    );
    const gen = await env.KV.get(`gen:${ALICE_PK}`);
    expect(gen).not.toBeNull(); // first save changed css/about → bumped

    // Byte-identical save: no bump (KV writes are the scarce resource).
    await postSettings(
      { css: "body { color: teal }", about: "hi", relays: "" },
      { Cookie: cookie },
    );
    expect(await env.KV.get(`gen:${ALICE_PK}`)).toBe(gen);

    // Relays-only change: persisted, but relays never render on the blog —
    // still no bump.
    const res = await postSettings(
      { css: "body { color: teal }", about: "hi", relays: "wss://nos.lol" },
      { Cookie: cookie },
    );
    expect(res.status).toBe(303);
    expect(await env.KV.get(`gen:${ALICE_PK}`)).toBe(gen);
    const settings = await settingsRow(ALICE_PK);
    expect(settings.relays).toEqual(["wss://nos.lol/"]);
  });

  it("the saved about text reaches the blog and overrides the profile bio", async () => {
    await mirrorEvent(env, aliceHello);
    await mirrorEvent(env, fixtures.profiles.alice as NostrEvent); // kind 0 carries its own about
    const cookie = await sessionCookieFor(ALICE_PK);
    await postSettings(
      { css: "", about: "about from settings", relays: "" },
      { Cookie: cookie },
    );

    for (const path of ["/", "/hello-world"]) {
      const page = await SELF.fetch(`https://alice.nbread.lol${path}`);
      expect(page.status, path).toBe(200);
      const html = await page.text();
      expect(html, path).toContain("about from settings");
      // The kind-0 bio is REPLACED, not shown alongside.
      expect(html, path).not.toContain(
        "nbread.lol throwaway test profile (alice)",
      );
    }
  });
});
