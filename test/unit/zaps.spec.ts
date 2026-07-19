// #12: NIP-57 zap primitives — lud16 shape validation, bolt11 HRP amounts,
// and the offline zap-receipt validation matrix.
import { describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import keys from "../fixtures/keys.json";
import type { NostrEvent } from "../../src/nostr/event";
import {
  bolt11Msat,
  MAX_ZAP_MSAT,
  parseZapReceipt,
  safeLud16,
  lnurlpUrl,
} from "../../src/services/zaps";

const ALICE_PK = keys.alice.pk; // the zapped author
const BOB_SK = keys.bob.sk; // the zap sender (signs the 9734)
const BOB_PK = keys.bob.pk;
const MALLORY_SK = keys.mallory.sk; // the LNURL wallet key (signs the 9735)

const ADDRESS = `30023:${ALICE_PK}:hello-world`;
// 1,000,000 msat = 1,000 sats = 10 µBTC → HRP "lnbc10u".
const AMOUNT_MSAT = 1_000_000;
const BOLT11 = "lnbc10u1qqqqsdqqcqzysxq";

function zapRequest(
  overrides: {
    p?: string | null;
    a?: string | null;
    amount?: string | null;
    kind?: number;
  } = {},
): NostrEvent {
  const tags: string[][] = [["relays", "wss://relay.example"]];
  if (overrides.p !== null) tags.push(["p", overrides.p ?? ALICE_PK]);
  if (overrides.a !== null) tags.push(["a", overrides.a ?? ADDRESS]);
  if (overrides.amount !== null) {
    tags.push(["amount", overrides.amount ?? String(AMOUNT_MSAT)]);
  }
  return finalizeEvent(
    {
      kind: overrides.kind ?? 9734,
      created_at: 1_700_050_000,
      tags,
      content: "",
    },
    hexToBytes(BOB_SK),
  ) as NostrEvent;
}

function zapReceipt(
  overrides: {
    request?: NostrEvent;
    description?: string;
    p?: string | null;
    a?: string | null;
    bolt11?: string | null;
    created_at?: number;
  } = {},
): NostrEvent {
  const tags: string[][] = [];
  if (overrides.p !== null) tags.push(["p", overrides.p ?? ALICE_PK]);
  if (overrides.a !== null) tags.push(["a", overrides.a ?? ADDRESS]);
  if (overrides.bolt11 !== null) {
    tags.push(["bolt11", overrides.bolt11 ?? BOLT11]);
  }
  tags.push([
    "description",
    overrides.description ?? JSON.stringify(overrides.request ?? zapRequest()),
  ]);
  return finalizeEvent(
    {
      kind: 9735,
      created_at: overrides.created_at ?? 1_700_050_001,
      tags,
      content: "",
    },
    hexToBytes(MALLORY_SK),
  ) as NostrEvent;
}

describe("safeLud16", () => {
  it("accepts a plain lightning address and lowercases the domain", () => {
    expect(safeLud16("alice@Wallet.Example")).toBe("alice@wallet.example");
    expect(safeLud16("  a.b-c_d+e@sub.domain.example  ")).toBe(
      "a.b-c_d+e@sub.domain.example",
    );
  });

  it("rejects hostile or malformed values", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "no-at-sign",
      "@example.com",
      "user@",
      "user@localhost", // single label
      "user@127.0.0.1", // IPv4 literal (numeric TLD)
      "user@[::1]",
      "user@example.com:8443", // port
      "user@example.com/path",
      'user"onmouseover=x@example.com',
      "user@exa mple.com",
      "user@example.c", // 1-char TLD
      "a".repeat(320) + "@example.com", // over the length cap
    ]) {
      expect(safeLud16(bad)).toBeNull();
    }
  });

  it("builds the LUD-16 well-known URL with an encoded local part", () => {
    expect(lnurlpUrl("alice+tips@wallet.example")).toBe(
      "https://wallet.example/.well-known/lnurlp/alice%2Btips",
    );
  });
});

describe("bolt11Msat", () => {
  it("parses HRP amounts across multipliers", () => {
    expect(bolt11Msat("lnbc10u1qqq")).toBe(1_000_000); // 10 µBTC
    expect(bolt11Msat("lnbc1m1qqq")).toBe(100_000_000); // 1 mBTC
    expect(bolt11Msat("lnbc2500u1qqq")).toBe(250_000_000);
    expect(bolt11Msat("lnbc100n1qqq")).toBe(10_000); // 100 nBTC = 10 sats
    expect(bolt11Msat("lnbc250p1qqq")).toBe(25); // 250 pBTC = 25 msat
    expect(bolt11Msat("LNBC10U1QQQ")).toBe(1_000_000); // case-insensitive
  });

  it("digits containing the separator character parse correctly", () => {
    // amount 11 BTC → "lnbc11" + separator "1" + data (bech32 data has no '1')
    expect(bolt11Msat("lnbc111qqq")).toBe(11 * 100_000_000_000);
  });

  it("rejects amount-less, sub-msat, non-mainnet, and oversized invoices", () => {
    expect(bolt11Msat(undefined)).toBeNull();
    expect(bolt11Msat("lnbc1pvjluezqqq")).toBeNull(); // no amount digits
    expect(bolt11Msat("lnbc25p1qqq")).toBeNull(); // 2.5 msat — sub-msat
    expect(bolt11Msat("lntb10u1qqq")).toBeNull(); // testnet
    expect(bolt11Msat("lnbc99999991qqq")).toBeNull(); // 9,999,999 BTC > cap
  });
});

describe("parseZapReceipt", () => {
  it("accepts a fully consistent receipt", () => {
    const parsed = parseZapReceipt(zapReceipt(), ALICE_PK);
    expect(parsed).not.toBeNull();
    expect(parsed?.address).toBe(ADDRESS);
    expect(parsed?.dTag).toBe("hello-world");
    expect(parsed?.authorPubkey).toBe(ALICE_PK);
    expect(parsed?.senderPubkey).toBe(BOB_PK);
    expect(parsed?.amountMsat).toBe(AMOUNT_MSAT);
  });

  it("rejects structural mismatches", () => {
    const cases: [string, NostrEvent][] = [
      ["receipt p is not the author", zapReceipt({ p: BOB_PK })],
      ["receipt has no a tag", zapReceipt({ a: null })],
      [
        "a addresses another author",
        zapReceipt({ a: `30023:${BOB_PK}:hello-world` }),
      ],
      ["a is not kind 30023", zapReceipt({ a: `1:${ALICE_PK}:x` })],
      ["description is not JSON", zapReceipt({ description: "not json" })],
      ["description is not a 9734", zapReceipt({ request: zapRequest({ kind: 1 }) })],
      ["request p mismatch", zapReceipt({ request: zapRequest({ p: BOB_PK }) })],
      [
        "request a mismatch",
        zapReceipt({ request: zapRequest({ a: `30023:${ALICE_PK}:other` }) }),
      ],
      [
        "bolt11 disagrees with the request amount",
        zapReceipt({ bolt11: "lnbc20u1qqq" }),
      ],
      ["missing bolt11", zapReceipt({ bolt11: null })],
      [
        "amount over the ceiling",
        zapReceipt({
          request: zapRequest({ amount: String(MAX_ZAP_MSAT * 10) }),
        }),
      ],
    ];
    for (const [label, ev] of cases) {
      expect(parseZapReceipt(ev, ALICE_PK), label).toBeNull();
    }
  });

  it("accepts a request WITHOUT an amount tag — the invoice is authoritative", () => {
    // NIP-57 makes the 9734 amount optional; equality is only enforced when
    // both exist. Wallets that omit it must still count.
    const parsed = parseZapReceipt(
      zapReceipt({ request: zapRequest({ amount: null }) }),
      ALICE_PK,
    );
    expect(parsed?.amountMsat).toBe(AMOUNT_MSAT); // from the bolt11 HRP
  });

  it("rejects non-9735 kinds outright", () => {
    const note = { ...zapReceipt(), kind: 1 };
    expect(parseZapReceipt(note, ALICE_PK)).toBeNull();
  });
});
