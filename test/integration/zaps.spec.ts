// #12: zap ingestion + rendering — the cron receipt pass (LNURL nostrPubkey
// binding, dedup, watermark), the rollup, the JS-free zap affordance on post
// pages, and feed counts.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixtures from "../fixtures/events.json";
import {
  ALICE_PK,
  BOB_SK,
  MALLORY_PK,
  MALLORY_SK,
  resetDiscoverCache,
  resetMirrorState,
  resetRateLimits,
  resetUsers,
  seedAlice,
  signProfileEvent,
} from "../helpers";
import { serveEvents, resetMockRelay } from "../mock-relay";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";
import { getUserByPubkey, type User } from "../../src/services/users";
import {
  parseZapReceipt,
  readZapSince,
  refreshZapsForUser,
  resolveNostrPubkey,
  setLnurlFetcherForTests,
  storeZapReceipt,
  zapTotals,
} from "../../src/services/zaps";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const ADDRESS = `30023:${ALICE_PK}:hello-world`;
const AMOUNT_MSAT = 1_000_000; // 1,000 sats ↔ lnbc10u
const BOLT11 = "lnbc10u1qqqqsdqqcqzysxq";
const LUD16 = "alice@wallet.example";

function zapRequest(address = ADDRESS): NostrEvent {
  return finalizeEvent(
    {
      kind: 9734,
      created_at: 1_700_050_000,
      tags: [
        ["relays", "wss://relay.example"],
        ["p", ALICE_PK],
        ["a", address],
        ["amount", String(AMOUNT_MSAT)],
      ],
      content: "",
    },
    hexToBytes(BOB_SK),
  ) as NostrEvent;
}

function zapReceipt(
  opts: { address?: string; created_at?: number; sk?: string } = {},
): NostrEvent {
  const address = opts.address ?? ADDRESS;
  return finalizeEvent(
    {
      kind: 9735,
      created_at: opts.created_at ?? 1_700_050_001,
      tags: [
        ["p", ALICE_PK],
        ["a", address],
        ["bolt11", BOLT11],
        ["description", JSON.stringify(zapRequest(address))],
      ],
      content: "",
    },
    hexToBytes(opts.sk ?? MALLORY_SK),
  ) as NostrEvent;
}

async function aliceUser(): Promise<User> {
  const user = await getUserByPubkey(env, ALICE_PK);
  expect(user).not.toBeNull();
  return user!;
}

/** Mirror alice's kind 0 (with the given lud16) and her hello-world post. */
async function seedProfileAndPost(lud16: string = LUD16): Promise<void> {
  expect(
    await mirrorEvent(
      env,
      signProfileEvent({
        created_at: 1_700_000_100,
        content: { name: "alice", lud16 },
      }),
    ),
  ).toBe("stored");
  expect(await mirrorEvent(env, aliceHello)).toBe("stored");
}

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await resetUsers();
  await seedAlice();
  await resetDiscoverCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM zaps"),
    env.DB.prepare("DELETE FROM zap_totals"),
    env.DB.prepare("DELETE FROM lnurl_cache"),
  ]);
});

afterEach(() => {
  resetMockRelay();
  setLnurlFetcherForTests(null);
});

describe("storeZapReceipt / zapTotals", () => {
  it("dedupes by receipt id and rolls up totals idempotently", async () => {
    const first = parseZapReceipt(zapReceipt(), ALICE_PK)!;
    const second = parseZapReceipt(
      zapReceipt({ created_at: 1_700_050_010 }),
      ALICE_PK,
    )!;
    await storeZapReceipt(env, first);
    await storeZapReceipt(env, first); // replay — must not double-count
    await storeZapReceipt(env, second);
    expect(await zapTotals(env, ADDRESS)).toEqual({
      msatTotal: 2 * AMOUNT_MSAT,
      zapCount: 2,
    });
    expect(await zapTotals(env, `30023:${ALICE_PK}:other`)).toBeNull();
  });
});

describe("resolveNostrPubkey", () => {
  it("caches lookups (positive and negative) in D1", async () => {
    let calls = 0;
    setLnurlFetcherForTests(async () => {
      calls++;
      return MALLORY_PK;
    });
    expect(await resolveNostrPubkey(env, LUD16)).toBe(MALLORY_PK);
    expect(await resolveNostrPubkey(env, LUD16)).toBe(MALLORY_PK);
    expect(calls).toBe(1);

    let deadCalls = 0;
    setLnurlFetcherForTests(async () => {
      deadCalls++;
      return null;
    });
    expect(await resolveNostrPubkey(env, "dead@wallet.example")).toBeNull();
    expect(await resolveNostrPubkey(env, "dead@wallet.example")).toBeNull();
    expect(deadCalls).toBe(1);
  });
});

describe("refreshZapsForUser", () => {
  it("stores only wallet-signed, valid receipts and advances the watermark", async () => {
    await seedProfileAndPost();
    let lnurlCalls = 0;
    setLnurlFetcherForTests(async () => {
      lnurlCalls++;
      return MALLORY_PK;
    });
    const valid = zapReceipt();
    const wrongWallet = zapReceipt({ sk: BOB_SK, created_at: 1_700_050_002 });
    serveEvents([valid, wrongWallet]);

    await refreshZapsForUser(env, ["wss://mock.local"], await aliceUser());

    expect(await zapTotals(env, ADDRESS)).toEqual({
      msatTotal: AMOUNT_MSAT,
      zapCount: 1,
    });
    expect(lnurlCalls).toBe(1);
    const user = await aliceUser();
    expect(readZapSince(user.settings)).toBe(valid.created_at);

    // Second run over the same relay contents: dedup, no new rows, cached
    // LNURL lookup.
    await refreshZapsForUser(env, ["wss://mock.local"], user);
    expect(await zapTotals(env, ADDRESS)).toEqual({
      msatTotal: AMOUNT_MSAT,
      zapCount: 1,
    });
    expect(lnurlCalls).toBe(1);
  });

  it("skips receipts for posts that are not mirrored", async () => {
    await seedProfileAndPost();
    setLnurlFetcherForTests(async () => MALLORY_PK);
    serveEvents([zapReceipt({ address: `30023:${ALICE_PK}:not-mirrored` })]);
    await refreshZapsForUser(env, ["wss://mock.local"], await aliceUser());
    expect(await zapTotals(env, `30023:${ALICE_PK}:not-mirrored`)).toBeNull();
  });

  it("does nothing for a user without a valid lud16", async () => {
    await seedProfileAndPost("not a lightning address");
    let calls = 0;
    setLnurlFetcherForTests(async () => {
      calls++;
      return MALLORY_PK;
    });
    serveEvents([zapReceipt()]);
    await refreshZapsForUser(env, ["wss://mock.local"], await aliceUser());
    expect(calls).toBe(0);
    expect(await zapTotals(env, ADDRESS)).toBeNull();
  });
});

describe("zap affordance on blog pages (JS-free)", () => {
  it("renders the zap link, tip link, and totals on the post page", async () => {
    await seedProfileAndPost();
    await storeZapReceipt(env, parseZapReceipt(zapReceipt(), ALICE_PK)!);

    const res = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("⚡ Zap this post");
    expect(html).toContain('href="https://njump.me/naddr1');
    expect(html).toContain(`href="lightning:${LUD16}"`);
    expect(html).toContain("1,000 sats");
    expect(html).toContain("1 zap");
    // Still zero scripts on blog markup (BLOG_CSP contract).
    expect(html).not.toContain("<script");
  });

  it("omits the affordance entirely without a lud16", async () => {
    await seedProfileAndPost("");
    const html = await (
      await SELF.fetch("https://alice.nbread.lol/hello-world")
    ).text();
    expect(html).not.toContain("post-zap");
    expect(html).not.toContain("njump.me");
  });

  it("never builds hrefs from a hostile lud16", async () => {
    await seedProfileAndPost('x"onmouseover=alert(1)@127.0.0.1');
    const html = await (
      await SELF.fetch("https://alice.nbread.lol/hello-world")
    ).text();
    expect(html).not.toContain("post-zap");
    expect(html).not.toContain("lightning:");
  });

  it("shows zap counts on the discover feed", async () => {
    await seedProfileAndPost();
    await storeZapReceipt(env, parseZapReceipt(zapReceipt(), ALICE_PK)!);
    const html = await (await SELF.fetch("https://nbread.lol/discover")).text();
    expect(html).toContain("⚡ 1,000 sats");
    expect(html).toContain("1 zap");
  });
});
