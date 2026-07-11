/**
 * Relay pool client: connect to every relay, send one REQ, collect EVENTs
 * until EOSE or the shared deadline, dedupe by id, close cleanly. A dead or
 * hanging relay never sinks the batch — its collection just ends empty.
 */
import { getEventId, isNostrEvent, type NostrEvent } from "./event";

/**
 * Structural surface of a client WebSocket. Satisfied by the runtime
 * `WebSocket` (constructor or fetch-upgrade) and by `WebSocketPair` ends in
 * tests.
 */
export type RelaySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    handler: (event: { data?: unknown }) => void,
  ): void;
};

type SocketFactory = (url: string) => RelaySocket | Promise<RelaySocket>;

const READY_STATE_OPEN = 1;

/**
 * Hard cap on events retained per fetchEvents call, regardless of relay
 * behavior. A hostile relay that withholds EOSE and streams EVENT frames for
 * the whole timeout window can otherwise grow `byId` (and burn CPU) without
 * bound; once the cap is hit every collector finishes as soon as it sees
 * another EVENT frame.
 */
export const MAX_EVENTS = 5_000;

/**
 * Default connector. Workers supports the standard `new WebSocket(url)`
 * client; if the runtime lacks it, fall back to the fetch Upgrade handshake.
 */
async function connectSocket(url: string): Promise<RelaySocket> {
  if (typeof WebSocket === "function") {
    try {
      return new WebSocket(url) as unknown as RelaySocket;
    } catch {
      // fall through to the fetch-upgrade path
    }
  }
  const httpUrl = url.replace(/^ws(s?):\/\//, "http$1://");
  const resp = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`relay ${url}: server did not upgrade`);
  ws.accept();
  return ws as unknown as RelaySocket;
}

let socketFactory: SocketFactory = connectSocket;

/**
 * TEST-ONLY seam: swap how relay sockets are created so unit tests can serve
 * canned relay behavior without network. Pass `null` to restore the default.
 */
export function setSocketFactoryForTests(factory: SocketFactory | null): void {
  socketFactory = factory ?? connectSocket;
}

/**
 * Fetch events from a pool of relays: connect all, REQ with `filter`, collect
 * until every relay reaches EOSE/CLOSED (or dies), `MAX_EVENTS` is hit, or
 * `timeoutMs` elapses, dedupe by event id, close everything. Structurally
 * invalid events and events whose id does not match their content are
 * dropped; schnorr signature verification is the caller's job (mirror
 * service).
 */
export async function fetchEvents(
  relays: string[],
  filter: object,
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const byId = new Map<string, NostrEvent>();
  if (relays.length === 0) return [];

  const openSockets = new Set<RelaySocket>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  const jobs = relays.map((url, i) =>
    collectFromRelay(url, `nb${i}`, filter, byId, openSockets),
  );
  await Promise.race([Promise.all(jobs).then(() => undefined), deadline]);

  if (timer !== undefined) clearTimeout(timer);
  for (const ws of openSockets) {
    try {
      ws.close(1000, "done");
    } catch {
      // already closed / errored — nothing to do
    }
  }
  return [...byId.values()];
}

/** Collect one relay's EVENTs into `byId`. Always resolves; never throws. */
async function collectFromRelay(
  url: string,
  subId: string,
  filter: object,
  byId: Map<string, NostrEvent>,
  openSockets: Set<RelaySocket>,
): Promise<void> {
  let ws: RelaySocket;
  try {
    ws = await socketFactory(url);
  } catch {
    return; // dead relay: connection refused / bad URL
  }
  openSockets.add(ws);

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      openSockets.delete(ws);
      try {
        ws.close(1000, "done");
      } catch {
        // already closed / errored — nothing to do
      }
      resolve();
    };

    ws.addEventListener("error", finish);
    ws.addEventListener("close", finish);
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let msg: unknown;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // junk frame — ignore
      }
      if (!Array.isArray(msg) || msg[1] !== subId) return;
      if (msg[0] === "EVENT") {
        const ev: unknown = msg[2];
        // Recompute the id before accepting: dedupe is first-write-wins, so
        // without this a hostile relay could occupy a genuine event's id slot
        // with forged content and get the authentic copy dropped as a
        // "duplicate" (one sha256 — no schnorr; full signature verification
        // remains the caller's job).
        if (
          byId.size < MAX_EVENTS &&
          isNostrEvent(ev) &&
          getEventId(ev) === ev.id &&
          !byId.has(ev.id)
        ) {
          byId.set(ev.id, ev);
        }
        if (byId.size >= MAX_EVENTS) finish();
      } else if (msg[0] === "EOSE") {
        try {
          ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // socket already gone — finish() below still runs
        }
        finish();
      } else if (msg[0] === "CLOSED") {
        // Relay terminated the subscription server-side (NIP-01: auth
        // required, rate limited, filter rejected). No EOSE will ever come,
        // so stop waiting instead of burning the whole timeout. No CLOSE
        // frame needed — the subscription is already gone.
        finish();
      }
    });

    const sendReq = () => {
      try {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      } catch {
        finish();
      }
    };
    if (ws.readyState === READY_STATE_OPEN) sendReq();
    else ws.addEventListener("open", sendReq);
  });
}
