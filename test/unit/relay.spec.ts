// P1: relay pool client vs in-test mock WS relays (WebSocketPair — no
// network). Covers dedupe, EOSE fast-path, timeout, dead/hanging/erroring
// relay tolerance, junk frames, and clean CLOSE.
import { afterEach, describe, expect, it } from "vitest";
import { getEventId, type NostrEvent } from "../../src/nostr/event";
import {
  fetchEvents,
  MAX_EVENTS,
  setSocketFactoryForTests,
  type RelaySocket,
} from "../../src/nostr/relay";
import fixtures from "../fixtures/events.json";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceTorture = fixtures.posts.aliceTorture as NostrEvent;
const bobFirst = fixtures.posts.bobFirst as NostrEvent;

const FILTER = { kinds: [30023], limit: 10 };

type MockBehavior = {
  events?: unknown[];
  /** send EOSE after events (default true) */
  eose?: boolean;
  /** send a NIP-01 CLOSED frame after events instead of EOSE */
  closedFrame?: boolean;
  /** close without EOSE after sending events */
  closeAfterEvents?: boolean;
  /** send junk frames before events */
  junkFrames?: boolean;
  /** send this event under a different subscription id */
  wrongSubEvent?: NostrEvent;
  /** record of messages the mock server received */
  serverLog?: unknown[][];
};

/**
 * In-test mock relay: a WebSocketPair whose server end speaks just enough
 * NIP-01 relay protocol. Returns the client end for the pool to consume.
 */
function mockRelaySocket(behavior: MockBehavior): RelaySocket {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  client.accept();
  server.addEventListener("message", (msg) => {
    let parsed: unknown[];
    try {
      parsed = JSON.parse(msg.data as string) as unknown[];
    } catch {
      return;
    }
    behavior.serverLog?.push(parsed);
    if (parsed[0] !== "REQ") return;
    const subId = parsed[1] as string;
    if (behavior.junkFrames) {
      server.send("this is not json");
      server.send(JSON.stringify({ notice: "an object, not an array" }));
      server.send(JSON.stringify(["NOTICE", "mock relay says hi"]));
    }
    if (behavior.wrongSubEvent) {
      server.send(JSON.stringify(["EVENT", "other-sub", behavior.wrongSubEvent]));
    }
    for (const ev of behavior.events ?? []) {
      server.send(JSON.stringify(["EVENT", subId, ev]));
    }
    if (behavior.closeAfterEvents) {
      server.close(1000, "mock done");
      return;
    }
    if (behavior.closedFrame) {
      server.send(JSON.stringify(["CLOSED", subId, "auth-required: mock"]));
      return;
    }
    if (behavior.eose !== false) {
      server.send(JSON.stringify(["EOSE", subId]));
    }
  });
  return client as unknown as RelaySocket;
}

/** Fake socket whose send() throws (connection torn down mid-handshake). */
function throwingSocket(): RelaySocket {
  return {
    readyState: 1,
    send() {
      throw new Error("mock: socket gone");
    },
    close() {},
    addEventListener() {},
  };
}

/** Fake socket that never opens and fires an async error event. */
function erroringSocket(): RelaySocket {
  const handlers = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  let errored = false;
  setTimeout(() => {
    errored = true;
    for (const h of handlers.get("error") ?? []) h({});
  }, 10);
  return {
    readyState: 0, // CONNECTING — pool must wait for open/error
    send() {},
    close() {},
    addEventListener(type, handler) {
      if (type === "error" && errored) {
        handler({}); // deliver retroactively if attached late
        return;
      }
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
  };
}

/** Route each mock relay url to its own socket factory. */
function useMocks(
  map: Record<string, () => RelaySocket | Promise<RelaySocket>>,
): void {
  setSocketFactoryForTests((url) => {
    const make = map[url];
    if (!make) throw new Error(`no mock registered for ${url}`);
    return make();
  });
}

afterEach(() => setSocketFactoryForTests(null));

const ids = (events: NostrEvent[]) => events.map((e) => e.id).sort();

describe("fetchEvents", () => {
  it("collects from multiple relays and dedupes by id", async () => {
    useMocks({
      "wss://mock-a": () => mockRelaySocket({ events: [aliceHello, aliceTorture] }),
      "wss://mock-b": () => mockRelaySocket({ events: [aliceHello, bobFirst] }),
    });
    const events = await fetchEvents(["wss://mock-a", "wss://mock-b"], FILTER, 5000);
    expect(ids(events)).toEqual(ids([aliceHello, aliceTorture, bobFirst]));
  });

  it("resolves promptly on EOSE instead of waiting for the timeout", async () => {
    useMocks({ "wss://mock-a": () => mockRelaySocket({ events: [aliceHello] }) });
    const start = Date.now();
    const events = await fetchEvents(["wss://mock-a"], FILTER, 10_000);
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(ids(events)).toEqual(ids([aliceHello]));
  });

  it("returns partial results at the deadline when a relay never sends EOSE", async () => {
    useMocks({
      "wss://mock-healthy": () => mockRelaySocket({ events: [aliceHello] }),
      "wss://mock-hang": () =>
        mockRelaySocket({ events: [bobFirst], eose: false }),
    });
    const start = Date.now();
    const events = await fetchEvents(
      ["wss://mock-healthy", "wss://mock-hang"],
      FILTER,
      400,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(5_000);
    // pre-EOSE events from the hanging relay still count
    expect(ids(events)).toEqual(ids([aliceHello, bobFirst]));
  });

  it("returns [] at the deadline when the only relay hangs silently", async () => {
    useMocks({ "wss://mock-hang": () => mockRelaySocket({ eose: false }) });
    const events = await fetchEvents(["wss://mock-hang"], FILTER, 300);
    expect(events).toEqual([]);
  });

  it("tolerates a relay whose connection throws", async () => {
    useMocks({
      "wss://mock-dead": () => {
        throw new Error("mock: connection refused");
      },
      "wss://mock-healthy": () => mockRelaySocket({ events: [bobFirst] }),
    });
    const start = Date.now();
    const events = await fetchEvents(
      ["wss://mock-dead", "wss://mock-healthy"],
      FILTER,
      10_000,
    );
    expect(Date.now() - start).toBeLessThan(3_000); // dead relay resolves immediately
    expect(ids(events)).toEqual(ids([bobFirst]));
  });

  it("tolerates a relay that closes without EOSE", async () => {
    useMocks({
      "wss://mock-rude": () =>
        mockRelaySocket({ events: [aliceTorture], closeAfterEvents: true }),
      "wss://mock-healthy": () => mockRelaySocket({ events: [aliceHello] }),
    });
    const events = await fetchEvents(
      ["wss://mock-rude", "wss://mock-healthy"],
      FILTER,
      10_000,
    );
    expect(ids(events)).toEqual(ids([aliceHello, aliceTorture]));
  });

  it("tolerates a socket whose send() throws", async () => {
    useMocks({
      "wss://mock-throwing": () => throwingSocket(),
      "wss://mock-healthy": () => mockRelaySocket({ events: [aliceHello] }),
    });
    const events = await fetchEvents(
      ["wss://mock-throwing", "wss://mock-healthy"],
      FILTER,
      10_000,
    );
    expect(ids(events)).toEqual(ids([aliceHello]));
  });

  it("tolerates a socket that errors before opening", async () => {
    useMocks({
      "wss://mock-error": () => erroringSocket(),
      "wss://mock-healthy": () => mockRelaySocket({ events: [bobFirst] }),
    });
    const start = Date.now();
    const events = await fetchEvents(
      ["wss://mock-error", "wss://mock-healthy"],
      FILTER,
      10_000,
    );
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(ids(events)).toEqual(ids([bobFirst]));
  });

  it("ignores junk frames and wrong-subscription events", async () => {
    useMocks({
      "wss://mock-noisy": () =>
        mockRelaySocket({
          events: [aliceHello],
          junkFrames: true,
          wrongSubEvent: bobFirst,
        }),
    });
    const events = await fetchEvents(["wss://mock-noisy"], FILTER, 5_000);
    expect(ids(events)).toEqual(ids([aliceHello]));
  });

  it("drops a forged event claiming another event's id (dedupe cannot be shadowed)", async () => {
    // Same id as aliceHello, different content: a hostile relay trying to
    // occupy the genuine event's dedupe slot so the real copy gets dropped.
    const forged = { ...aliceHello, content: "FORGED — not alice's post" };
    useMocks({
      "wss://mock-evil": () => mockRelaySocket({ events: [forged] }),
      "wss://mock-honest": () => mockRelaySocket({ events: [aliceHello] }),
    });
    const events = await fetchEvents(
      ["wss://mock-evil", "wss://mock-honest"],
      FILTER,
      5_000,
    );
    // Regardless of frame arrival order, only the copy whose id matches its
    // content survives.
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe(aliceHello.content);
  });

  it("resolves promptly when a relay sends CLOSED instead of EOSE", async () => {
    useMocks({
      "wss://mock-closed": () =>
        mockRelaySocket({ events: [aliceHello], eose: false, closedFrame: true }),
    });
    const start = Date.now();
    const events = await fetchEvents(["wss://mock-closed"], FILTER, 10_000);
    expect(Date.now() - start).toBeLessThan(3_000);
    // events delivered before CLOSED still count
    expect(ids(events)).toEqual(ids([aliceHello]));
  });

  it("caps collection at MAX_EVENTS when a relay floods without EOSE", async () => {
    // Structurally valid events with correct ids (sig is never checked at
    // collection time, only structure + id integrity).
    const flood: NostrEvent[] = Array.from(
      { length: MAX_EVENTS + 50 },
      (_, i) => {
        const tpl = {
          pubkey: "a".repeat(64),
          created_at: 1700000000 + i,
          kind: 30023,
          tags: [["d", `flood-${i}`]],
          content: `flood ${i}`,
        };
        return { ...tpl, id: getEventId(tpl), sig: "0".repeat(128) };
      },
    );
    useMocks({
      "wss://mock-flood": () =>
        mockRelaySocket({ events: flood, eose: false }),
    });
    const start = Date.now();
    const events = await fetchEvents(["wss://mock-flood"], FILTER, 30_000);
    // finishes at the cap, long before the timeout
    expect(Date.now() - start).toBeLessThan(20_000);
    expect(events).toHaveLength(MAX_EVENTS);
  }, 30_000);

  it("drops structurally invalid events from relays", async () => {
    useMocks({
      "wss://mock-a": () =>
        mockRelaySocket({
          events: [
            aliceHello,
            { ...bobFirst, sig: 123 }, // non-string sig
            { ...aliceTorture, id: "XYZ" }, // non-hex id
            "not an event",
            null,
          ],
        }),
    });
    const events = await fetchEvents(["wss://mock-a"], FILTER, 5_000);
    expect(ids(events)).toEqual(ids([aliceHello]));
  });

  it("resolves [] for an empty relay list without touching the network", async () => {
    setSocketFactoryForTests(() => {
      throw new Error("factory must not be called");
    });
    expect(await fetchEvents([], FILTER, 1_000)).toEqual([]);
  });

  it("sends REQ with the filter and CLOSE after EOSE", async () => {
    const serverLog: unknown[][] = [];
    useMocks({
      "wss://mock-a": () => mockRelaySocket({ events: [aliceHello], serverLog }),
    });
    await fetchEvents(["wss://mock-a"], FILTER, 5_000);
    // allow the CLOSE frame to propagate through the pair
    await new Promise((resolve) => setTimeout(resolve, 50));
    const req = serverLog.find((m) => m[0] === "REQ");
    expect(req).toBeDefined();
    expect(req![2]).toEqual(FILTER);
    const close = serverLog.find((m) => m[0] === "CLOSE");
    expect(close).toBeDefined();
    expect(close![1]).toBe(req![1]);
  });
});
