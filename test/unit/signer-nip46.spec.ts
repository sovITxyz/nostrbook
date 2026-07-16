// Packet C: NIP-46 remote-signer client (public/js/signer-nip46.js). The
// PURE surface — bunker:// parsing, nostrconnect:// building, the encrypted
// request/response envelope, and the transport-injectable state machine —
// is exercised with committed fixture keys and a scripted fake transport;
// no real sockets, no DOM, no localStorage.
//
// Load order matters: the crypto vendor bundle must exist before the IIFE
// runs, and a minimal NbreadSigner.register stub must exist before its
// load-time side effect fires — so signer-nip46.js is imported dynamically
// in beforeAll (static imports are hoisted above module-body statements).
import { beforeAll, describe, expect, it } from "vitest";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/vendor/nostr-crypto.js";
import keys from "../fixtures/keys.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
const C = (globalThis as any).NbreadCrypto;

type Nip46Msg = {
  id: string | number;
  method?: string;
  params?: string[];
  result?: string;
  error?: string;
};

type Nip46Api = {
  parseBunkerUri: (uri: string) => {
    remoteSignerPubkey: string;
    relays: string[];
    secret?: string;
  };
  buildNostrconnectUri: (opts: {
    clientPubkey: string;
    relays: string[];
    secret: string;
    name?: string;
  }) => string;
  encodeRequest: (
    convKey: Uint8Array,
    req: { id: string | number; method: string; params: unknown[] },
  ) => string;
  decodeResponse: (
    convKey: Uint8Array,
    content: string,
    nip04Keys?: { skBytes: Uint8Array; peerPubkey: string },
  ) => Promise<Nip46Msg>;
  createClient: (options: any) => {
    clientPubkey: string;
    start: () => void;
    close: () => void;
    connect: (pk?: string, secret?: string) => Promise<string>;
    get_public_key: () => Promise<string>;
    sign_event: (unsignedJson: string) => Promise<string>;
    isLegacyNip04: () => boolean;
  };
  backend: {
    ready: () => { ok: boolean; reason?: string };
    getPublicKey: () => string;
    signEvent: (unsigned: unknown) => Promise<unknown>;
    configure: (input: unknown, opts?: unknown) => Promise<{ userPubkey: string }>;
  };
};

let N: Nip46Api;
const registered: Record<string, unknown> = {};

beforeAll(async () => {
  (globalThis as any).NbreadSigner = {
    register(name: string, backend: unknown) {
      registered[name] = backend;
    },
  };
  // @ts-ignore — plain browser IIFE, intentionally shipped without types
  await import("../../public/js/signer-nip46.js");
  N = (globalThis as any).NbreadNip46 as Nip46Api;
});

// Fixture personas: alice is the nbread client (ephemeral key), bob is the
// remote signer, mallory's pubkey doubles as the "user identity" the signer
// holds — three distinct keys keeps the roles honest.
const ALICE_SK = keys.alice.sk;
const ALICE_PK = keys.alice.pk;
const BOB_SK = keys.bob.sk;
const BOB_PK = keys.bob.pk;
const USER_PK = keys.mallory.pk;

const aliceSk = C.hexToBytes(ALICE_SK) as Uint8Array;
const bobSk = C.hexToBytes(BOB_SK) as Uint8Array;
/** NIP-44 conversation keys are symmetric: alice↔bob derive the same key. */
const convKey = C.nip44ConversationKey(aliceSk, BOB_PK) as Uint8Array;

/** Let the async handleFrame/crypto.subtle chains settle (macrotask flush). */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Pre-attach a no-op handler so a promise that rejects during a flush (before
 * `expect(p).rejects` observes it) never trips workerd's unhandled-rejection
 * reporting. Returns the same promise — assertions still see the rejection.
 */
function expectRejection<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
// Scripted fakes
// ---------------------------------------------------------------------------

type SentFrame = { relay: string; frame: any[] };

function makeFakeTransport() {
  const sent: SentFrame[] = [];
  let handler: ((frame: any[]) => void) | null = null;
  return {
    sent,
    send(relay: string, frame: any[]) {
      sent.push({ relay, frame });
    },
    onMessage(cb: (frame: any[]) => void) {
      handler = cb;
    },
    close() {},
    /** Test hook: deliver a relay frame to the client. */
    deliver(frame: any[]) {
      if (handler) handler(frame);
    },
  };
}

function makeFakeTimers() {
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  return {
    timers,
    set: (fn: () => void, _ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, fn);
      return handle;
    },
    clear: (handle: number) => {
      timers.delete(handle);
    },
    /** Fire every armed timer (i.e. "60 seconds pass"). */
    fireAll: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const transport = makeFakeTransport();
  const timers = makeFakeTimers();
  const authUrls: string[] = [];
  const client = N.createClient({
    transport,
    clientSkHex: ALICE_SK,
    remoteSignerPubkey: BOB_PK,
    relays: ["wss://relay.test"],
    nowSec: () => 1700000000,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onAuthUrl: (url: string) => authUrls.push(url),
    ...overrides,
  });
  return { client, transport, timers, authUrls };
}

/** Bob (the remote signer) decrypts a published NIP-44 request event. */
function decryptRequest(ev: any): Nip46Msg {
  const ck = C.nip44ConversationKey(bobSk, ev.pubkey);
  return JSON.parse(C.nip44Decrypt(ck, ev.content));
}

/** All kind-24133 request events the client has published, oldest first. */
function sentEvents(transport: ReturnType<typeof makeFakeTransport>): any[] {
  return transport.sent.filter((s) => s.frame[0] === "EVENT").map((s) => s.frame[1]);
}

/** Bob answers: encrypt msg (NIP-44 or legacy NIP-04) and deliver the frame. */
async function respond(
  transport: ReturnType<typeof makeFakeTransport>,
  msg: Nip46Msg,
  opts: { nip04?: boolean } = {},
) {
  const json = JSON.stringify(msg);
  const content = opts.nip04
    ? await C.nip04Encrypt(bobSk, ALICE_PK, json)
    : C.nip44Encrypt(C.nip44ConversationKey(bobSk, ALICE_PK), json);
  const ev = C.finalizeEvent(
    { kind: 24133, created_at: 1700000001, tags: [["p", ALICE_PK]], content },
    bobSk,
  );
  transport.deliver(["EVENT", "sub-x", ev]);
  await flush();
}

// ---------------------------------------------------------------------------
// parseBunkerUri
// ---------------------------------------------------------------------------

describe("parseBunkerUri", () => {
  it("parses a single-relay URI without a secret", () => {
    const out = N.parseBunkerUri(`bunker://${BOB_PK}?relay=wss://relay.example.com`);
    expect(out.remoteSignerPubkey).toBe(BOB_PK);
    expect(out.relays).toEqual(["wss://relay.example.com"]);
    expect(out.secret).toBeUndefined();
  });

  it("parses multiple relays (percent-encoded too) plus a secret", () => {
    const out = N.parseBunkerUri(
      `bunker://${BOB_PK.toUpperCase()}?relay=wss%3A%2F%2Fr1.example.com&relay=wss://r2.example.com&secret=s3cret-token`,
    );
    expect(out.remoteSignerPubkey).toBe(BOB_PK); // lowercased
    expect(out.relays).toEqual(["wss://r1.example.com", "wss://r2.example.com"]);
    expect(out.secret).toBe("s3cret-token");
  });

  it("rejects a non-hex pubkey", () => {
    const zz = "z".repeat(64);
    expect(() => N.parseBunkerUri(`bunker://${zz}?relay=wss://r.example.com`)).toThrow(
      /hex/,
    );
  });

  it("rejects a short pubkey", () => {
    expect(() =>
      N.parseBunkerUri(`bunker://${BOB_PK.slice(0, 63)}?relay=wss://r.example.com`),
    ).toThrow(/hex/);
  });

  it("rejects a URI with no relay at all", () => {
    expect(() => N.parseBunkerUri(`bunker://${BOB_PK}`)).toThrow(/relay/);
    expect(() => N.parseBunkerUri(`bunker://${BOB_PK}?secret=abc`)).toThrow(/relay/);
  });

  it("rejects http:// and ws:// relays", () => {
    expect(() =>
      N.parseBunkerUri(`bunker://${BOB_PK}?relay=http://r.example.com`),
    ).toThrow(/wss/);
    expect(() =>
      N.parseBunkerUri(`bunker://${BOB_PK}?relay=ws://r.example.com`),
    ).toThrow(/wss/);
  });

  it("rejects non-bunker schemes", () => {
    expect(() => N.parseBunkerUri(`nostrconnect://${BOB_PK}?relay=wss://r.io`)).toThrow(
      /bunker/,
    );
  });
});

// ---------------------------------------------------------------------------
// buildNostrconnectUri
// ---------------------------------------------------------------------------

describe("buildNostrconnectUri", () => {
  it("builds the exact pairing URI (relays percent-encoded, given name)", () => {
    expect(
      N.buildNostrconnectUri({
        clientPubkey: ALICE_PK,
        relays: ["wss://r1.test", "wss://r2.test"],
        secret: "s3cret",
        name: "nbread",
      }),
    ).toBe(
      `nostrconnect://${ALICE_PK}?relay=wss%3A%2F%2Fr1.test&relay=wss%3A%2F%2Fr2.test&secret=s3cret&name=nbread`,
    );
  });

  it('defaults name to "nbread"', () => {
    expect(
      N.buildNostrconnectUri({
        clientPubkey: ALICE_PK,
        relays: ["wss://r.test"],
        secret: "abc",
      }),
    ).toBe(`nostrconnect://${ALICE_PK}?relay=wss%3A%2F%2Fr.test&secret=abc&name=nbread`);
  });

  it("rejects a missing secret and non-wss relays", () => {
    expect(() =>
      N.buildNostrconnectUri({ clientPubkey: ALICE_PK, relays: ["wss://r.test"], secret: "" }),
    ).toThrow(/secret/);
    expect(() =>
      N.buildNostrconnectUri({
        clientPubkey: ALICE_PK,
        relays: ["http://r.test"],
        secret: "abc",
      }),
    ).toThrow(/wss/);
  });
});

// ---------------------------------------------------------------------------
// encodeRequest / decodeResponse
// ---------------------------------------------------------------------------

describe("encodeRequest/decodeResponse", () => {
  it("round-trips a request through NIP-44 (bob can read what alice sends)", async () => {
    const content = N.encodeRequest(convKey, {
      id: "7",
      method: "connect",
      params: [BOB_PK, "s3cret"],
    });
    // decodeResponse is decrypt+parse of the same envelope, usable both ways.
    const msg = await N.decodeResponse(C.nip44ConversationKey(bobSk, ALICE_PK), content);
    expect(msg).toEqual({ id: "7", method: "connect", params: [BOB_PK, "s3cret"] });
  });

  it("round-trips a NIP-44 response", async () => {
    const content = C.nip44Encrypt(convKey, JSON.stringify({ id: "1", result: "ack" }));
    const msg = await N.decodeResponse(convKey, content);
    expect(msg).toEqual({ id: "1", result: "ack" });
  });

  it('auto-detects a legacy NIP-04 response by its "?iv=" marker', async () => {
    const content = await C.nip04Encrypt(
      bobSk,
      ALICE_PK,
      JSON.stringify({ id: "2", result: USER_PK }),
    );
    expect(content).toContain("?iv=");
    const msg = await N.decodeResponse(convKey, content, {
      skBytes: aliceSk,
      peerPubkey: BOB_PK,
    });
    expect(msg).toEqual({ id: "2", result: USER_PK });
  });

  it("requires nip04 keys for a NIP-04 response", async () => {
    const content = await C.nip04Encrypt(bobSk, ALICE_PK, JSON.stringify({ id: "3" }));
    await expect(N.decodeResponse(convKey, content)).rejects.toThrow(/nip04/);
  });

  it("rejects tampered NIP-44 content (MAC failure)", async () => {
    const content = C.nip44Encrypt(convKey, JSON.stringify({ id: "4", result: "ack" }));
    const i = 50; // inside nonce/ciphertext, away from padding
    const flipped = content[i] === "A" ? "B" : "A";
    const tampered = content.slice(0, i) + flipped + content.slice(i + 1);
    await expect(N.decodeResponse(convKey, tampered)).rejects.toThrow();
  });

  it("rejects corrupted NIP-04 content", async () => {
    const content = await C.nip04Encrypt(bobSk, ALICE_PK, JSON.stringify({ id: "5" }));
    const tampered = "!" + content.slice(1); // invalid base64 — deterministic reject
    await expect(
      N.decodeResponse(convKey, tampered, { skBytes: aliceSk, peerPubkey: BOB_PK }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createClient — scripted fake transport, injected timers, no sockets
// ---------------------------------------------------------------------------

describe("createClient", () => {
  it("connect: subscribes, publishes a signed kind-24133 request, resolves on ack", async () => {
    const { client, transport } = makeClient();
    const p = client.connect(BOB_PK, "s3cret");
    await flush();

    const req = transport.sent.find((s) => s.frame[0] === "REQ");
    expect(req).toBeDefined();
    expect(req!.relay).toBe("wss://relay.test");
    expect(req!.frame[2]).toEqual({ kinds: [24133], "#p": [ALICE_PK] });

    const [ev] = sentEvents(transport);
    expect(ev.kind).toBe(24133);
    expect(ev.pubkey).toBe(ALICE_PK);
    expect(ev.created_at).toBe(1700000000); // injected nowSec
    expect(ev.tags).toEqual([["p", BOB_PK]]);
    expect(C.schnorrVerify(ev.sig, ev.id, ev.pubkey)).toBe(true);

    const rpc = decryptRequest(ev);
    expect(rpc.method).toBe("connect");
    expect(rpc.params).toEqual([BOB_PK, "s3cret"]);

    await respond(transport, { id: rpc.id, result: "ack" });
    await expect(p).resolves.toBe("ack");
  });

  it("get_public_key resolves with the signer-held user pubkey", async () => {
    const { client, transport } = makeClient();
    const p = client.get_public_key();
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    expect(rpc.method).toBe("get_public_key");
    await respond(transport, { id: rpc.id, result: USER_PK });
    await expect(p).resolves.toBe(USER_PK);
  });

  it("get_public_key rejects a malformed pubkey result", async () => {
    const { client, transport } = makeClient();
    const p = expectRejection(client.get_public_key());
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    await respond(transport, { id: rpc.id, result: "not-a-pubkey" });
    await expect(p).rejects.toThrow(/malformed pubkey/);
  });

  it("sign_event round-trips and the result verifies cryptographically", async () => {
    const { client, transport } = makeClient();
    const unsigned = { kind: 1, created_at: 1700000000, tags: [], content: "hello nip46" };
    const p = client.sign_event(JSON.stringify(unsigned));
    await flush();

    const rpc = decryptRequest(sentEvents(transport)[0]);
    expect(rpc.method).toBe("sign_event");
    expect(JSON.parse(rpc.params![0]!)).toEqual(unsigned);

    // Bob really signs it (as himself — the "user key" he holds).
    const signed = C.finalizeEvent(unsigned, bobSk);
    await respond(transport, { id: rpc.id, result: JSON.stringify(signed) });

    const returned = JSON.parse(await p);
    expect(returned).toEqual(signed);
    expect(returned.id).toBe(C.eventId(returned));
    expect(C.schnorrVerify(returned.sig, returned.id, returned.pubkey)).toBe(true);
  });

  it("sign_event rejects a response whose content was swapped (id mismatch)", async () => {
    const { client, transport } = makeClient();
    const unsigned = { kind: 1, created_at: 1700000000, tags: [], content: "original" };
    const p = expectRejection(client.sign_event(JSON.stringify(unsigned)));
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    const signed = C.finalizeEvent(unsigned, bobSk);
    signed.content = "evil replacement"; // id no longer matches
    await respond(transport, { id: rpc.id, result: JSON.stringify(signed) });
    await expect(p).rejects.toThrow(/id mismatch/);
  });

  it("sign_event rejects a response with a forged signature", async () => {
    const { client, transport } = makeClient();
    const unsigned = { kind: 1, created_at: 1700000000, tags: [], content: "original" };
    const p = expectRejection(client.sign_event(JSON.stringify(unsigned)));
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    const signed = C.finalizeEvent(unsigned, bobSk);
    signed.sig = (signed.sig[0] === "0" ? "1" : "0") + signed.sig.slice(1);
    await respond(transport, { id: rpc.id, result: JSON.stringify(signed) });
    await expect(p).rejects.toThrow(/signature/);
  });

  it("surfaces an error response as a rejection carrying nip46Error", async () => {
    const { client, transport } = makeClient();
    const p = expectRejection(client.get_public_key());
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    await respond(transport, { id: rpc.id, error: "unauthorized" });
    await expect(p).rejects.toMatchObject({ nip46Error: "unauthorized" });
  });

  it("times out an unanswered request when the injected clock fires", async () => {
    const { client, transport, timers } = makeClient();
    const p = expectRejection(client.get_public_key());
    await flush();
    expect(sentEvents(transport)).toHaveLength(1);
    timers.fireAll(); // 60 injected seconds pass
    await expect(p).rejects.toThrow(/timed out/);
    // A late response for the dead id is ignored (no crash, still rejected).
    await respond(transport, { id: "1", result: USER_PK });
    await expect(p).rejects.toThrow(/timed out/);
  });

  it("surfaces auth_url via the callback without settling the request", async () => {
    const { client, transport, authUrls } = makeClient();
    const p = client.get_public_key();
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);

    await respond(transport, {
      id: rpc.id,
      result: "auth_url",
      error: "https://signer.example/authorize?token=abc",
    });
    expect(authUrls).toEqual(["https://signer.example/authorize?token=abc"]);
    expect(settled).toBe(false); // still waiting — and definitely no navigation

    await respond(transport, { id: rpc.id, result: USER_PK });
    await expect(p).resolves.toBe(USER_PK);
  });

  it("matches out-of-order responses by id and ignores duplicates", async () => {
    const { client, transport } = makeClient();
    const p1 = client.get_public_key();
    const p2 = client.get_public_key();
    await flush();

    const events = sentEvents(transport);
    expect(events).toHaveLength(2);
    const rpc1 = decryptRequest(events[0]);
    const rpc2 = decryptRequest(events[1]);
    expect(rpc1.id).not.toBe(rpc2.id); // unique per request

    // Answer the second request first.
    await respond(transport, { id: rpc2.id, result: USER_PK });
    await respond(transport, { id: rpc1.id, result: BOB_PK });
    await expect(p1).resolves.toBe(BOB_PK);
    await expect(p2).resolves.toBe(USER_PK);

    // A duplicate response with a different value changes nothing.
    await respond(transport, { id: rpc1.id, result: ALICE_PK });
    await expect(p1).resolves.toBe(BOB_PK);
  });

  it("uses unguessable random request ids (not a predictable counter)", async () => {
    // Replay defense: a relay that recorded an earlier session must not be
    // able to predict the id of a fresh request ("1", "2", …).
    const { client, transport } = makeClient();
    const p = client.get_public_key();
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    expect(String(rpc.id)).toMatch(/^[0-9a-f]{16}$/);
    expect(String(rpc.id)).not.toBe("1");
    await respond(transport, { id: rpc.id, result: USER_PK });
    await expect(p).resolves.toBe(USER_PK);
  });

  it("sign_event rejects a validly-signed event that does not match the request", async () => {
    // A replayed/substituted response: genuinely signed by the user key, but
    // NOT the event we asked to sign (different kind + content).
    const { client, transport } = makeClient();
    const unsigned = { kind: 1, created_at: 1700000000, tags: [], content: "fresh post" };
    const p = expectRejection(client.sign_event(JSON.stringify(unsigned)));
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    const stale = C.finalizeEvent(
      { kind: 22242, created_at: 1690000000, tags: [], content: "old login" },
      bobSk,
    );
    await respond(transport, { id: rpc.id, result: JSON.stringify(stale) });
    await expect(p).rejects.toThrow(/does not match/);
  });

  it("sign_event rejects matching content but swapped tags", async () => {
    const { client, transport } = makeClient();
    const unsigned = {
      kind: 1,
      created_at: 1700000000,
      tags: [["t", "good"]],
      content: "hello",
    };
    const p = expectRejection(client.sign_event(JSON.stringify(unsigned)));
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    const swapped = C.finalizeEvent(
      { kind: 1, created_at: 1700000000, tags: [["t", "evil"]], content: "hello" },
      bobSk,
    );
    await respond(transport, { id: rpc.id, result: JSON.stringify(swapped) });
    await expect(p).rejects.toThrow(/does not match/);
  });

  it("ignores events from a pubkey other than the remote signer", async () => {
    const { client, transport } = makeClient();
    const p = client.get_public_key();
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);

    // Mallory publishes a matching-id "response" — wrong sender, ignored
    // (she couldn't have the conversation key either).
    const mallorySk = C.hexToBytes(keys.mallory.sk);
    const forged = C.finalizeEvent(
      {
        kind: 24133,
        created_at: 1700000001,
        tags: [["p", ALICE_PK]],
        content: C.nip44Encrypt(
          C.nip44ConversationKey(mallorySk, ALICE_PK),
          JSON.stringify({ id: rpc.id, result: keys.mallory.pk }),
        ),
      },
      mallorySk,
    );
    transport.deliver(["EVENT", "sub-x", forged]);
    await flush();

    await respond(transport, { id: rpc.id, result: USER_PK });
    await expect(p).resolves.toBe(USER_PK);
  });

  it("auto-detects a NIP-04 response and switches request encryption to legacy", async () => {
    const { client, transport } = makeClient();
    expect(client.isLegacyNip04()).toBe(false);

    const p = client.connect(BOB_PK, "s3cret");
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    await respond(transport, { id: rpc.id, result: "ack" }, { nip04: true });
    await expect(p).resolves.toBe("ack");
    expect(client.isLegacyNip04()).toBe(true);

    // The next request goes out NIP-04-encrypted for the legacy signer.
    const q = client.get_public_key();
    await flush();
    const ev2 = sentEvents(transport)[1];
    expect(ev2.content).toContain("?iv=");
    const rpc2: Nip46Msg = JSON.parse(await C.nip04Decrypt(bobSk, ALICE_PK, ev2.content));
    expect(rpc2.method).toBe("get_public_key");
    await respond(transport, { id: rpc2.id, result: USER_PK }, { nip04: true });
    await expect(q).resolves.toBe(USER_PK);
  });

  it("drops forged envelopes (valid-looking pubkey, invalid signature) without downgrading", async () => {
    // A malicious relay injects a garbage event with ev.pubkey set to the
    // remote signer but no real signature. It must be dropped BEFORE the
    // decrypt-failure path: no NIP-04 connect retry, no legacy flip.
    const { client, transport } = makeClient();
    const p = client.connect(BOB_PK, "s3cret");
    await flush();
    expect(sentEvents(transport)).toHaveLength(1);

    transport.deliver([
      "EVENT",
      "sub-x",
      {
        id: "00".repeat(32),
        pubkey: BOB_PK,
        sig: "00".repeat(64),
        kind: 24133,
        created_at: 1700000001,
        tags: [["p", ALICE_PK]],
        content: "undecryptable-garbage?iv=junk",
      },
    ]);
    await flush();

    expect(client.isLegacyNip04()).toBe(false);
    expect(sentEvents(transport)).toHaveLength(1); // no NIP-04 retry fired

    const rpc = decryptRequest(sentEvents(transport)[0]);
    await respond(transport, { id: rpc.id, result: "ack" });
    await expect(p).resolves.toBe("ack");
    expect(client.isLegacyNip04()).toBe(false);
  });

  it("retries connect over NIP-04 on a genuine undecryptable reply without a session downgrade", async () => {
    const { client, transport } = makeClient();
    const p = client.connect(BOB_PK, "s3cret");
    await flush();
    expect(sentEvents(transport)).toHaveLength(1);

    // Bob genuinely signs a blob the client cannot decrypt (e.g. an error
    // encrypted for the wrong key) — envelope verifies, decryption fails.
    const junk = C.finalizeEvent(
      { kind: 24133, created_at: 1700000001, tags: [["p", ALICE_PK]], content: "not-a-ciphertext" },
      bobSk,
    );
    transport.deliver(["EVENT", "sub-x", junk]);
    await flush();

    // The connect was re-sent NIP-04-encrypted…
    const events = sentEvents(transport);
    expect(events).toHaveLength(2);
    expect(events[1].content).toContain("?iv=");
    // …but the session itself was NOT downgraded by the failure alone.
    expect(client.isLegacyNip04()).toBe(false);

    // Bob answers the retry in NIP-44: the session stays modern.
    const rpc: Nip46Msg = JSON.parse(await C.nip04Decrypt(bobSk, ALICE_PK, events[1].content));
    await respond(transport, { id: rpc.id, result: "ack" });
    await expect(p).resolves.toBe("ack");
    expect(client.isLegacyNip04()).toBe(false);
  });

  it("resets legacy mode when a NIP-44 response later decrypts successfully", async () => {
    const { client, transport } = makeClient();
    const p = client.connect(BOB_PK, "s3cret");
    await flush();
    const rpc = decryptRequest(sentEvents(transport)[0]);
    await respond(transport, { id: rpc.id, result: "ack" }, { nip04: true });
    await expect(p).resolves.toBe("ack");
    expect(client.isLegacyNip04()).toBe(true);

    // The signer proves it speaks NIP-44 after all — undo the downgrade.
    const q = client.get_public_key();
    await flush();
    const ev2 = sentEvents(transport)[1];
    const rpc2: Nip46Msg = JSON.parse(await C.nip04Decrypt(bobSk, ALICE_PK, ev2.content));
    await respond(transport, { id: rpc2.id, result: USER_PK });
    await expect(q).resolves.toBe(USER_PK);
    expect(client.isLegacyNip04()).toBe(false);
  });

  it("close() rejects everything pending and closes the subscription", async () => {
    const { client, transport } = makeClient();
    const p = expectRejection(client.get_public_key());
    await flush();
    client.close();
    await expect(p).rejects.toThrow(/closed/);
    const closeFrame = transport.sent.find((s) => s.frame[0] === "CLOSE");
    expect(closeFrame).toBeDefined();
    await expect(client.get_public_key()).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// Load-time side effect + backend guards (workerd has no localStorage)
// ---------------------------------------------------------------------------

describe("registration side effect and backend guards", () => {
  it("registers the backend as NbreadSigner method 'nip46' on load", () => {
    expect(registered["nip46"]).toBe(N.backend);
    expect(typeof N.backend.ready).toBe("function");
    expect(typeof N.backend.getPublicKey).toBe("function");
    expect(typeof N.backend.signEvent).toBe("function");
    expect(typeof N.backend.configure).toBe("function");
  });

  it("ready() fails closed where localStorage does not exist (this runtime)", () => {
    const r = N.backend.ready();
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("getPublicKey/configure guard against the missing storage too", async () => {
    expect(() => N.backend.getPublicKey()).toThrow(/not configured/);
    await expect(N.backend.configure({ relays: ["wss://r.test"] })).rejects.toThrow(
      /localStorage/,
    );
  });
});
