// Filter-aware in-test mock relay for P3 ingestion tests. Speaks just enough
// NIP-01: answers REQ with the canned events matching the filter (kinds /
// authors / since / until / limit, newest first), then EOSE.
//
// Implemented as a plain-object fake socket (NOT a WebSocketPair): workerd's
// hang detection kills cross-context WebSocketPair traffic when the pool
// client runs inside a SELF.fetch / SELF.scheduled request context. Message
// delivery here is a synchronous callback dispatch, which works in every
// context. Installed via the relay module's socket-factory seam, so both
// direct fetchEvents calls and worker code paths hit it (vitest-pool-workers
// runs the worker in the test isolate — module state is shared).
import type { NostrEvent } from "../src/nostr/event";
import {
  setSocketFactoryForTests,
  type RelaySocket,
} from "../src/nostr/relay";

type Filter = {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

function matchFilter(ev: NostrEvent, f: Filter): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  return true;
}

function mockRelaySocket(events: NostrEvent[]): RelaySocket {
  const listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  const dispatch = (type: string, data?: unknown) => {
    for (const handler of listeners.get(type) ?? []) handler({ data });
  };
  return {
    readyState: 1, // OPEN — the pool sends its REQ immediately
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    close() {
      // no-op: the pool closes sockets when it finishes
    },
    send(data: string) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
      const subId = parsed[1] as string;
      const filter = (parsed[2] ?? {}) as Filter;
      let matched = events
        .filter((ev) => matchFilter(ev, filter))
        .sort((a, b) => b.created_at - a.created_at); // relays serve newest first
      if (typeof filter.limit === "number") {
        matched = matched.slice(0, filter.limit);
      }
      for (const ev of matched) {
        dispatch("message", JSON.stringify(["EVENT", subId, ev]));
      }
      dispatch("message", JSON.stringify(["EOSE", subId]));
    },
  };
}

/** Serve these events from every relay URL until resetMockRelay(). */
export function serveEvents(events: NostrEvent[]): void {
  setSocketFactoryForTests(() => mockRelaySocket(events));
}

/** Restore the real WebSocket connector. */
export function resetMockRelay(): void {
  setSocketFactoryForTests(null);
}
