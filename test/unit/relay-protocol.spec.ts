// PR2 packet 1: relay wire protocol — parseClientMessage matrix, frame
// builder exactness, NIP-42 validateAuthEvent, plus the pure url/nip11
// helpers. Committed throwaway fixture keys only; env is a plain cast (the
// helpers only read MAIN_HOST / ENVIRONMENT / ADMIN_PUBKEY).
import { describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import keys from "../fixtures/keys.json";
import type { NostrEvent } from "../../src/nostr/event";
import {
  authFrame,
  closedFrame,
  eoseFrame,
  eventFrame,
  MAX_MESSAGE_LENGTH,
  MAX_SUBID_LENGTH,
  noticeFrame,
  okFrame,
  parseClientMessage,
  validateAuthEvent,
} from "../../src/relay/protocol";
import { nip11Document } from "../../src/relay/nip11";
import { isSelfRelayHost, selfRelayUrl } from "../../src/relay/url";

const fakeEnv = (over: Record<string, unknown> = {}): Env =>
  ({
    MAIN_HOST: "nbread.lol",
    ENVIRONMENT: "production",
    ...over,
  }) as unknown as Env;

/** Fixed "now" so skew cases are deterministic. */
const NOW = 1_700_000_000;
const CHALLENGE = "ab".repeat(32);

/** Sign a kind-22242 AUTH event like test/helpers.ts signLoginEvent does. */
function signAuth(
  opts: {
    sk?: string;
    kind?: number;
    created_at?: number;
    /** `null` omits the tag entirely. */
    relay?: string | null;
    /** `null` omits the tag entirely. */
    challenge?: string | null;
  } = {},
): NostrEvent {
  const tags: string[][] = [];
  if (opts.relay !== null) {
    tags.push(["relay", opts.relay ?? "wss://nbread.lol"]);
  }
  if (opts.challenge !== null) {
    tags.push(["challenge", opts.challenge ?? CHALLENGE]);
  }
  return finalizeEvent(
    {
      kind: opts.kind ?? 22242,
      created_at: opts.created_at ?? NOW,
      tags,
      content: "",
    },
    hexToBytes(opts.sk ?? keys.alice.sk),
  ) as NostrEvent;
}

const parse = (raw: string) => parseClientMessage(raw, MAX_MESSAGE_LENGTH);

describe("parseClientMessage — valid frames", () => {
  it("parses a valid EVENT frame", () => {
    const ev = signAuth();
    const msg = parse(JSON.stringify(["EVENT", ev]));
    expect(msg.type).toBe("event");
    if (msg.type !== "event") return;
    expect(msg.event.id).toBe(ev.id);
    expect(msg.event.pubkey).toBe(keys.alice.pk);
  });

  it("parses a valid REQ frame, filters returned raw and in order", () => {
    const msg = parse(
      JSON.stringify(["REQ", "sub1", { kinds: [30023] }, { ids: [] }]),
    );
    expect(msg.type).toBe("req");
    if (msg.type !== "req") return;
    expect(msg.subId).toBe("sub1");
    expect(msg.filters).toEqual([{ kinds: [30023] }, { ids: [] }]);
  });

  it("parses a valid CLOSE frame", () => {
    const msg = parse(JSON.stringify(["CLOSE", "sub1"]));
    expect(msg).toEqual({ type: "close", subId: "sub1" });
  });

  it("parses a valid AUTH frame", () => {
    const ev = signAuth();
    const msg = parse(JSON.stringify(["AUTH", ev]));
    expect(msg.type).toBe("auth");
    if (msg.type !== "auth") return;
    expect(msg.event.kind).toBe(22242);
  });

  it("accepts a subId of exactly MAX_SUBID_LENGTH chars", () => {
    const subId = "s".repeat(MAX_SUBID_LENGTH);
    const msg = parse(JSON.stringify(["CLOSE", subId]));
    expect(msg.type).toBe("close");
  });
});

describe("parseClientMessage — rejection matrix (never throws)", () => {
  const invalidCases: [string, string][] = [
    ["junk text", "not json at all"],
    ["empty string", ""],
    ["JSON object", "{}"],
    ["empty array", "[]"],
    ["non-string verb", "[42]"],
    ["JSON scalar", '"EVENT"'],
    ["unknown verb", '["COUNT","sub1",{}]'],
    ["EVENT missing payload", '["EVENT"]'],
    ["EVENT extra element", '["EVENT",{},{}]'],
    ["EVENT non-event payload", '["EVENT",{"hello":"world"}]'],
    ["EVENT array payload", '["EVENT",[1,2,3]]'],
    ["AUTH missing payload", '["AUTH"]'],
    ["AUTH non-event payload", '["AUTH",{"kind":22242}]'],
    ["REQ without filters", '["REQ","sub1"]'],
    ["REQ non-string subId", '["REQ",42,{}]'],
    ["REQ empty subId", '["REQ","",{}]'],
    ["CLOSE missing subId", '["CLOSE"]'],
    ["CLOSE extra element", '["CLOSE","sub1","x"]'],
  ];
  for (const [label, raw] of invalidCases) {
    it(`rejects ${label}`, () => {
      const msg = parse(raw);
      expect(msg.type).toBe("invalid");
      if (msg.type !== "invalid") return;
      expect(msg.reason.length).toBeGreaterThan(0);
    });
  }

  it("rejects an oversized frame BEFORE parsing", () => {
    const msg = parseClientMessage("x".repeat(11), 10);
    expect(msg.type).toBe("invalid");
    if (msg.type !== "invalid") return;
    expect(msg.reason).toMatch(/too large/);
  });

  it("accepts a frame of exactly maxLen chars", () => {
    const raw = JSON.stringify(["CLOSE", "sub1"]);
    expect(parseClientMessage(raw, raw.length).type).toBe("close");
  });

  it("survives deeply nested junk without throwing", () => {
    const depth = 100_000;
    const raw = "[".repeat(depth) + "]".repeat(depth);
    // Either JSON.parse blows the stack (caught) or the verb is non-string;
    // both collapse to invalid.
    expect(parse(raw).type).toBe("invalid");
  });

  it("rejects a subId over MAX_SUBID_LENGTH on REQ and CLOSE", () => {
    const subId = "s".repeat(MAX_SUBID_LENGTH + 1);
    expect(parse(JSON.stringify(["REQ", subId, {}])).type).toBe("invalid");
    expect(parse(JSON.stringify(["CLOSE", subId])).type).toBe("invalid");
  });

  it("surfaces a plausible event id from a structurally invalid EVENT", () => {
    const id = "ab".repeat(32);
    const msg = parse(JSON.stringify(["EVENT", { id, kind: "nope" }]));
    expect(msg.type).toBe("invalid");
    if (msg.type !== "invalid") return;
    expect(msg.id).toBe(id);
  });

  it("omits id when the invalid EVENT payload has no plausible id", () => {
    const msg = parse(JSON.stringify(["EVENT", { id: "short", kind: 1 }]));
    expect(msg.type).toBe("invalid");
    if (msg.type !== "invalid") return;
    expect(msg.id).toBeUndefined();
  });
});

describe("frame builders — exact wire output", () => {
  it("okFrame", () => {
    expect(okFrame("id1", true, "")).toBe('["OK","id1",true,""]');
    expect(okFrame("id2", false, "auth-required: publish")).toBe(
      '["OK","id2",false,"auth-required: publish"]',
    );
  });

  it("noticeFrame escapes embedded quotes", () => {
    expect(noticeFrame('bad "frame"')).toBe('["NOTICE","bad \\"frame\\""]');
  });

  it("closedFrame / eoseFrame / authFrame", () => {
    expect(closedFrame("sub1", "error: temporarily unavailable")).toBe(
      '["CLOSED","sub1","error: temporarily unavailable"]',
    );
    expect(eoseFrame("sub1")).toBe('["EOSE","sub1"]');
    expect(authFrame(CHALLENGE)).toBe(`["AUTH","${CHALLENGE}"]`);
  });

  it("eventFrame embeds the raw JSON verbatim (no reserialize)", () => {
    // Non-canonical spacing survives ONLY if the raw text is concatenated,
    // never reparsed/re-serialized.
    const raw = '{"id": "abc",  "content": "café\\n"}';
    const frame = eventFrame("sub1", raw);
    expect(frame).toBe('["EVENT","sub1",' + raw + "]");
  });

  it("eventFrame escapes hostile subIds and stays parseable", () => {
    const ev = signAuth();
    const raw = JSON.stringify(ev);
    const subId = 'we"ird\\sub';
    const frame = eventFrame(subId, raw);
    // Compare against JSON.parse(raw), not `ev`: nostr-tools tags finalized
    // events with a Symbol(verified) property that toEqual would see.
    expect(JSON.parse(frame)).toEqual(["EVENT", subId, JSON.parse(raw)]);
  });
});

describe("validateAuthEvent (NIP-42)", () => {
  const env = fakeEnv();

  it("accepts a correctly signed 22242 for this challenge and host", async () => {
    const res = await validateAuthEvent(signAuth(), CHALLENGE, env, NOW);
    expect(res).toEqual({ ok: true, pubkey: keys.alice.pk });
  });

  it("accepts created_at at the exact skew boundary", async () => {
    const ev = signAuth({ created_at: NOW - 600 });
    const res = await validateAuthEvent(ev, CHALLENGE, env, NOW);
    expect(res.ok).toBe(true);
  });

  it("rejects the wrong challenge", async () => {
    const ev = signAuth({ challenge: "cd".repeat(32) });
    const res = await validateAuthEvent(ev, CHALLENGE, env, NOW);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.reason).toMatch(/challenge/);
  });

  it("rejects a missing challenge tag", async () => {
    const ev = signAuth({ challenge: null });
    expect((await validateAuthEvent(ev, CHALLENGE, env, NOW)).ok).toBe(false);
  });

  it("rejects an empty connection challenge even if the tags 'match'", async () => {
    const ev = signAuth({ challenge: "" });
    expect((await validateAuthEvent(ev, "", env, NOW)).ok).toBe(false);
  });

  it("rejects a relay tag bound to another host", async () => {
    const ev = signAuth({ relay: "wss://evil.example" });
    const res = await validateAuthEvent(ev, CHALLENGE, env, NOW);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.reason).toMatch(/relay/);
  });

  it("rejects a missing relay tag", async () => {
    const ev = signAuth({ relay: null });
    expect((await validateAuthEvent(ev, CHALLENGE, env, NOW)).ok).toBe(false);
  });

  it("accepts loopback relay tags in development only (relayTagBindsHost reuse)", async () => {
    const ev = signAuth({ relay: "ws://localhost:8787" });
    expect((await validateAuthEvent(ev, CHALLENGE, env, NOW)).ok).toBe(false);
    const dev = fakeEnv({ ENVIRONMENT: "development" });
    expect((await validateAuthEvent(ev, CHALLENGE, dev, NOW)).ok).toBe(true);
  });

  it("rejects stale and future created_at beyond the skew window", async () => {
    for (const created_at of [NOW - 601, NOW + 601]) {
      const res = await validateAuthEvent(
        signAuth({ created_at }),
        CHALLENGE,
        env,
        NOW,
      );
      expect(res).toMatchObject({ ok: false });
      if (res.ok) continue;
      expect(res.reason).toMatch(/created_at/);
    }
  });

  it("rejects the wrong event kind", async () => {
    const ev = signAuth({ kind: 1 });
    const res = await validateAuthEvent(ev, CHALLENGE, env, NOW);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.reason).toMatch(/kind/);
  });

  it("rejects a tampered event (bad signature)", async () => {
    const ev = { ...signAuth(), content: "tampered" };
    const res = await validateAuthEvent(ev, CHALLENGE, env, NOW);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.reason).toMatch(/signature/);
  });

  it("rejects a swapped pubkey (id no longer matches)", async () => {
    const ev = { ...signAuth(), pubkey: keys.bob.pk };
    expect((await validateAuthEvent(ev, CHALLENGE, env, NOW)).ok).toBe(false);
  });

  it("never throws on structural garbage", async () => {
    const res = await validateAuthEvent(
      {} as NostrEvent,
      CHALLENGE,
      env,
      NOW,
    );
    expect(res.ok).toBe(false);
  });
});

describe("selfRelayUrl / isSelfRelayHost", () => {
  it("derives wss://<MAIN_HOST>/relay, lowercased", () => {
    expect(selfRelayUrl(fakeEnv())).toBe("wss://nbread.lol/relay");
    expect(selfRelayUrl(fakeEnv({ MAIN_HOST: "NBREAD.LOL" }))).toBe(
      "wss://nbread.lol/relay",
    );
  });

  it("matches self by hostname regardless of scheme/path/case", () => {
    const env = fakeEnv();
    expect(isSelfRelayHost("wss://nbread.lol/relay", env)).toBe(true);
    expect(isSelfRelayHost("wss://NBREAD.LOL", env)).toBe(true);
    expect(isSelfRelayHost("https://nbread.lol/relay", env)).toBe(true);
  });

  it("rejects other hosts, lookalikes, and junk URLs", () => {
    const env = fakeEnv();
    expect(isSelfRelayHost("wss://relay.damus.io", env)).toBe(false);
    expect(isSelfRelayHost("wss://alice.nbread.lol/relay", env)).toBe(false);
    expect(isSelfRelayHost("wss://nbread.lol.evil.com", env)).toBe(false);
    expect(isSelfRelayHost("not a url", env)).toBe(false);
    expect(isSelfRelayHost("", env)).toBe(false);
  });
});

describe("nip11Document", () => {
  it("advertises the plan's exact limitation caps and NIPs", () => {
    const doc = nip11Document(fakeEnv());
    expect(doc.name).toBe("nbread relay");
    expect(doc.supported_nips).toEqual([1, 9, 11, 42]);
    expect(doc.software).toBe("https://github.com/sovITxyz/nbread");
    expect(typeof doc.version).toBe("string");
    expect(doc.limitation).toEqual({
      auth_required: false,
      restricted_writes: true,
      max_message_length: 1048576,
      max_subscriptions: 8,
      max_limit: 500,
      max_subid_length: 64,
      max_event_tags: 2000,
      max_content_length: 262144,
      created_at_upper_limit: 900,
    });
  });

  it("includes pubkey IFF ADMIN_PUBKEY resolves", () => {
    expect(nip11Document(fakeEnv())).not.toHaveProperty("pubkey");
    expect(
      nip11Document(fakeEnv({ ADMIN_PUBKEY: keys.bob.pk })).pubkey,
    ).toBe(keys.bob.pk);
    // Malformed values fail closed (same posture as the admin surface).
    expect(
      nip11Document(fakeEnv({ ADMIN_PUBKEY: "not-a-key" })),
    ).not.toHaveProperty("pubkey");
  });
});
