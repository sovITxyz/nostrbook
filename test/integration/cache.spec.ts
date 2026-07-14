// Edge cache middleware: Cache API keyed on host+path+generation, public
// tenant GETs only, invalidated by KV gen bumps (mirrorEvent side effect).
//
// Storage (D1, KV, Cache API) persists across tests in this file, so each
// test pins a UNIQUE gen baseline via KV before its first fetch — its cache
// keys can never collide with entries another test created.
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { seedAlice, ALICE_PK } from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import { CACHE_STATUS_HEADER } from "../../src/middleware/cache";
import type { NostrEvent } from "../../src/nostr/event";

const aliceProfile = fixtures.profiles.alice as NostrEvent;
const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceTorture = fixtures.posts.aliceTorture as NostrEvent;

const setGen = (gen: number) => env.KV.put(`gen:${ALICE_PK}`, String(gen));

describe("tenant edge cache (Cache API + gen keys)", () => {
  beforeAll(async () => {
    await seedAlice();
    expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
  });

  it("misses cold, hits warm, with s-maxage=3600 on the cached response", async () => {
    await setGen(1000);
    const r1 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r1.status).toBe(200);
    expect(r1.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(r1.headers.get("Cache-Control")).toContain("s-maxage=3600");
    const body1 = await r1.text();
    expect(body1).toContain("Hello world");

    const r2 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r2.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(await r2.text()).toBe(body1);
  });

  it("caches per path (post page and home are separate entries)", async () => {
    await setGen(1100);
    const post1 = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(post1.status).toBe(200);
    expect(post1.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    const post2 = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(post2.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    const home = await SELF.fetch("https://alice.nbread.lol/");
    expect(home.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
  });

  it("mirrorEvent's gen bump invalidates cached pages (new post appears)", async () => {
    await setGen(1200);
    const r1 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r1.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await r1.text()).not.toContain("Markdown torture test");
    expect(
      (await SELF.fetch("https://alice.nbread.lol/")).headers.get(
        CACHE_STATUS_HEADER,
      ),
    ).toBe("hit");

    expect(await mirrorEvent(env, aliceTorture)).toBe("stored"); // gen → new unique value

    const r2 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r2.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await r2.text()).toContain("Markdown torture test");
  });

  it("does not cache 404s", async () => {
    await setGen(1300);
    const r1 = await SELF.fetch("https://alice.nbread.lol/nope");
    expect(r1.status).toBe(404);
    expect(r1.headers.get(CACHE_STATUS_HEADER)).toBeNull();
    const r2 = await SELF.fetch("https://alice.nbread.lol/nope");
    expect(r2.headers.get(CACHE_STATUS_HEADER)).toBeNull();
  });

  it("never caches apex (main site) responses", async () => {
    const res = await SELF.fetch("https://nbread.lol/");
    expect(res.status).toBe(200);
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  // Mutates alice's posts — keep LAST in the file.
  it("keeps serving the cached page until the generation moves", async () => {
    await setGen(1400);
    const r1 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r1.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await r1.text()).toContain("Hello world");

    // Change D1 WITHOUT a gen bump — the stale page must keep coming back
    // (this is what proves the cached copy is actually served).
    await env.DB.prepare(
      "UPDATE events SET deleted = 1 WHERE pubkey = ? AND kind = 30023",
    )
      .bind(ALICE_PK)
      .run();
    const r2 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r2.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(await r2.text()).toContain("Hello world");

    // Bump the generation → new key → fresh (empty) content.
    await setGen(1401);
    const r3 = await SELF.fetch("https://alice.nbread.lol/");
    expect(r3.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await r3.text()).toContain("No posts yet.");
  });
});
