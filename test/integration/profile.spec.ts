// #11: configurable Nostr profile — the /dashboard/profile editor page
// (prefill from the stored kind 0, config JSON, XSS discipline) and the
// /api/mirror kind 0 path (tenant isolation, lud16 persistence, replaceable
// newest-wins semantics).
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import {
  ALICE_PK,
  BOB_SK,
  resetMirrorState,
  resetRateLimits,
  seedAlice,
  sessionCookieFor,
  signProfileEvent,
} from "../helpers";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";
import {
  getProfile,
  PROFILE_FIELD_MAX,
  storedProfileContent,
} from "../../src/services/profiles";

const aliceProfile = fixtures.profiles.alice as NostrEvent;

function getProfilePage(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch("https://nbread.lol/dashboard/profile", {
    headers: { "CF-Connecting-IP": "203.0.113.77", ...headers },
    redirect: "manual",
  });
}

function postMirror(
  event: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch("https://nbread.lol/api/mirror", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.77",
      ...headers,
    },
    body: JSON.stringify(event),
  });
}

/** The embedded profile-config JSON blob of a rendered page. */
function extractConfig(html: string): {
  pubkey: string;
  relays: string[];
  prevCreatedAt: number | null;
  extra: Record<string, unknown>;
} {
  const m =
    /<script type="application\/json" id="profile-config">([\s\S]*?)<\/script>/.exec(
      html,
    );
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
}

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await seedAlice();
});

describe("GET /dashboard/profile", () => {
  it("redirects to /login without a session", async () => {
    const res = await getProfilePage();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("renders empty fields + suggested nip05 when no profile is stored", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await getProfilePage({ Cookie: cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="profile-form"');
    // Claimed handle → the nip05 field pre-fills with the nbread identifier.
    expect(html).toContain('value="alice@nbread.lol"');
    const config = extractConfig(html);
    expect(config.pubkey).toBe(ALICE_PK);
    expect(config.prevCreatedAt).toBeNull();
    expect(config.extra).toEqual({});
    expect(config.relays[0]).toBe("wss://nbread.lol/relay");
  });

  it("prefills every field from the stored kind 0, including non-column fields", async () => {
    const ev = signProfileEvent({
      created_at: 1_700_000_100,
      content: {
        name: "alice",
        display_name: "Alice A.",
        about: "hello world",
        picture: "https://example.com/a.png",
        banner: "https://example.com/b.png",
        website: "https://alice.example",
        nip05: "alice@nbread.lol",
        lud16: "alice@wallet.example",
        lud06: "lnurl1dp68gurn8ghj7um9wfmxjcm99e5k7",
        // Custom key the form does not edit — must survive via config.extra.
        foo: { custom: true },
      },
    });
    expect(await mirrorEvent(env, ev)).toBe("stored");

    const cookie = await sessionCookieFor(ALICE_PK);
    const html = await (await getProfilePage({ Cookie: cookie })).text();
    expect(html).toContain('value="Alice A."');
    expect(html).toContain('value="https://example.com/b.png"');
    expect(html).toContain('value="https://alice.example"');
    expect(html).toContain('value="alice@wallet.example"');
    expect(html).toContain('value="lnurl1dp68gurn8ghj7um9wfmxjcm99e5k7"');
    expect(html).toContain("hello world</textarea>");
    const config = extractConfig(html);
    expect(config.prevCreatedAt).toBe(1_700_000_100);
    expect(config.extra).toEqual({ foo: { custom: true } });
  });

  it("neutralizes hostile stored profile values (XSS)", async () => {
    const hostile = '</script><script>alert(1)</script>';
    const ev = signProfileEvent({
      created_at: 1_700_000_100,
      content: {
        name: '"><img src=x onerror=alert(1)>',
        about: hostile,
        picture: "javascript:alert(1)",
        // Unknown key → lands raw in the config JSON blob; the `<` escaping
        // must keep it from closing the non-executable script tag.
        evil: hostile,
      },
    });
    expect(await mirrorEvent(env, ev)).toBe("stored");

    const cookie = await sessionCookieFor(ALICE_PK);
    const html = await (await getProfilePage({ Cookie: cookie })).text();
    // Attribute/text prefills render escaped — the raw payloads never appear
    // as markup ("onerror=" as inert TEXT inside a quoted, entity-escaped
    // value attribute is fine; the `"` that would close the attribute and the
    // `<` that would open a tag are both escaped).
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    // Every `<` inside the config blob is <-escaped, so the hostile
    // value cannot close the non-executable script tag…
    const blob =
      /<script type="application\/json" id="profile-config">([\s\S]*?)<\/script>/.exec(
        html,
      )![1];
    expect(blob).not.toContain("<");
    // …yet round-trips intact once parsed.
    expect(extractConfig(html).extra).toEqual({ evil: hostile });
  });
});

describe("POST /api/mirror — kind 0 (#11)", () => {
  it("stores the OWN kind 0 and upserts the profiles row (incl. lud16)", async () => {
    const ev = signProfileEvent({
      created_at: 1_700_000_200,
      content: { name: "alice", lud16: "alice@wallet.example" },
    });
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(ev, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored" });

    const profile = await getProfile(env, ALICE_PK);
    expect(profile?.name).toBe("alice");
    expect(profile?.lud16).toBe("alice@wallet.example");
    // The event landed in the single replaceable (pubkey, 0, '') slot.
    const row = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND kind = 0 AND d_tag = ''",
    )
      .bind(ALICE_PK)
      .first<{ id: string }>();
    expect(row?.id).toBe(ev.id);
  });

  it("rejects a kind 0 signed by ANOTHER key (tenant isolation, 403)", async () => {
    const bobProfile = signProfileEvent({
      sk: BOB_SK,
      created_at: 1_700_000_200,
      content: { name: "not alice" },
    });
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(bobProfile, { Cookie: cookie });
    expect(res.status).toBe(403);
    expect(await getProfile(env, ALICE_PK)).toBeNull();
  });

  it("an older kind 0 cannot roll back a newer stored profile", async () => {
    const newer = signProfileEvent({
      created_at: 1_700_000_300,
      content: { name: "current" },
    });
    const older = signProfileEvent({
      created_at: 1_700_000_100,
      content: { name: "stale" },
    });
    const cookie = await sessionCookieFor(ALICE_PK);
    expect((await postMirror(newer, { Cookie: cookie })).status).toBe(200);
    const res = await postMirror(older, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stale" });
    expect((await getProfile(env, ALICE_PK))?.name).toBe("current");
  });

  it("caps stored lud16 at PROFILE_FIELD_MAX.lud16", async () => {
    const long = "a".repeat(PROFILE_FIELD_MAX.lud16 + 100) + "@wallet.example";
    const ev = signProfileEvent({
      created_at: 1_700_000_200,
      content: { lud16: long },
    });
    const cookie = await sessionCookieFor(ALICE_PK);
    expect((await postMirror(ev, { Cookie: cookie })).status).toBe(200);
    const profile = await getProfile(env, ALICE_PK);
    expect(profile?.lud16).toBe(long.slice(0, PROFILE_FIELD_MAX.lud16));
  });

  it("the committed alice profile fixture flows end to end", async () => {
    const cookie = await sessionCookieFor(ALICE_PK);
    const res = await postMirror(aliceProfile, { Cookie: cookie });
    expect(res.status).toBe(200);
    const profile = await getProfile(env, ALICE_PK);
    expect(profile?.name).toBe("alice-test");
    expect(profile?.lud16).toBeNull();
  });
});

describe("storedProfileContent", () => {
  it("splits known fields from extra keys with caps applied", () => {
    const raw = JSON.stringify({
      content: JSON.stringify({
        name: "  padded  ",
        about: "x".repeat(PROFILE_FIELD_MAX.about + 50),
        custom: 42,
      }),
    });
    const { fields, extra } = storedProfileContent(raw);
    expect(fields.name).toBe("padded");
    expect(fields.about).toHaveLength(PROFILE_FIELD_MAX.about);
    expect(fields.lud16).toBe("");
    expect(extra).toEqual({ custom: 42 });
  });

  it("returns empty prefill on malformed raw or content JSON", () => {
    for (const raw of ["", "not json", "[]", '{"content":"not json"}', '{"content":"[1]"}']) {
      const { fields, extra } = storedProfileContent(raw);
      expect(fields.name).toBe("");
      expect(extra).toEqual({});
    }
  });

  it("ignores non-string values for known string fields", () => {
    const raw = JSON.stringify({
      content: JSON.stringify({ name: 42, lud16: ["a"] }),
    });
    const { fields } = storedProfileContent(raw);
    expect(fields.name).toBe("");
    expect(fields.lud16).toBe("");
  });
});
