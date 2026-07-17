/**
 * RelayDO (packet 3): the first-party relay's single global Durable Object.
 *
 * Topology (plan §B, binding): one instance via idFromName("relay:v1"),
 * WebSocket Hibernation API, `new_sqlite_classes` migration (free-plan
 * requirement). NO setTimeout/setInterval/alarms anywhere — a timer would
 * keep the object out of hibernation and start the duration-billing clock.
 *
 * State model:
 *   - Per-connection auth state lives in the socket ATTACHMENT
 *     (serializeAttachment, survives hibernation, kept well under the 16 KiB
 *     cap — see ConnState).
 *   - Subscriptions live in DO SQLite (`subs` rows, created lazily) so REQs
 *     survive hibernation too. Persistent event storage is NOT here: writes
 *     go through mirrorEvent into the shared D1 `events` table and reads run
 *     SQL over `events.raw` (queryEvents) — relay and blog can never disagree.
 *   - Message-rate / AUTH-attempt counters are in-memory only and reset on
 *     hibernation (accepted: hibernation implies the connection was idle).
 *
 * All protocol logic is in RelayCore.handleMessage — a testable core with
 * injected env/subs-store/clock that returns frames + effects and performs no
 * socket I/O. The RelayDO hibernation handlers are a thin shell around it.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { pickEventFields, type NostrEvent } from "../nostr/event";
import { mirrorEvent, type MirrorResult } from "../services/mirror";
import { rateLimitAllows } from "../services/ratelimit";
import { getUserByPubkey } from "../services/users";
import { matchesAnyFilter, sanitizeFilters } from "./filters";
import { CREATED_AT_UPPER_LIMIT_SECONDS } from "./nip11";
import {
  authFrame,
  closedFrame,
  eoseFrame,
  eventFrame,
  MAX_MESSAGE_LENGTH,
  MAX_SUBSCRIPTIONS_PER_CONN,
  noticeFrame,
  okFrame,
  parseClientMessage,
  validateAuthEvent,
} from "./protocol";
import { queryEvents, type QueryRow } from "./query";
import type { SanitizedFilter } from "./types";

// --- Caps (plan §B literals) ---------------------------------------------------

/** Global concurrent-connection cap; upgrades beyond it get a 503. */
export const MAX_CONNECTIONS = 256;
/** Per-connection inbound message budget (in-memory fixed window). */
export const MAX_MESSAGES_PER_MINUTE = 120;
const MESSAGE_WINDOW_SECONDS = 60;
/** Max NIP-42 AUTH attempts per connection before a 1008 close. */
export const MAX_AUTH_ATTEMPTS = 5;
/** How long one positive allowlist lookup stays cached in the attachment. */
export const ALLOWLIST_CACHE_SECONDS = 300;
/** Per-pubkey EVENT budget: 30 per 5 minutes (D1 rate_limits, fail-closed). */
export const EVENT_PK_MAX = 30;
export const EVENT_PK_WINDOW_SECONDS = 300;
/** Global daily store budget — bounds KV gen-bump burn to half the 1k/day. */
export const GLOBAL_STORE_MAX = 500;
export const GLOBAL_STORE_WINDOW_SECONDS = 86_400;

/** Kinds the relay accepts for writes (everything else is rejected). */
export const ALLOWED_EVENT_KINDS: ReadonlySet<number> = new Set([0, 5, 30023]);

// --- Connection state (socket attachment) ---------------------------------------

/**
 * Per-connection state persisted in the hibernatable socket's attachment.
 * Tiny by construction (two 64-hex strings + a number — far below the 16 KiB
 * attachment cap).
 */
export type ConnState = {
  /** Random UUID; also the socket's hibernation tag (fan-out addressing). */
  connId: string;
  /** NIP-42 challenge issued for THIS connection (64-hex). */
  challenge: string;
  /** Pubkey proven via AUTH, or null while unauthenticated. */
  authedPubkey: string | null;
  /**
   * Epoch seconds until which the POSITIVE allowlist check (claimed handle,
   * not blocked) for authedPubkey is cached. 0 = not cached. Reset on every
   * successful AUTH so a re-auth as a different key can never inherit it.
   */
  allowedUntil: number;
};

// --- Subscription store ----------------------------------------------------------

/** One persisted subscription (filters = JSON of SanitizedFilter[]). */
export type SubRow = { conn_id: string; sub_id: string; filters: string };

/**
 * Ephemeral subscription bookkeeping. The DO backs this with its SQLite
 * (SqlSubsStore below); unit tests drive RelayCore with an in-memory stub.
 */
export interface SubsStore {
  /** Open subscriptions for a connection EXCLUDING subId (REQ replaces same-id). */
  countOther(connId: string, subId: string): number;
  /** Upsert (NIP-01: a REQ reusing a subId replaces the old subscription). */
  put(connId: string, subId: string, filtersJson: string): void;
  delete(connId: string, subId: string): void;
  deleteConn(connId: string): void;
  /** Every live subscription (fan-out scan). */
  all(): SubRow[];
}

/** DO SQLite implementation; the table is created lazily on first touch. */
class SqlSubsStore implements SubsStore {
  private ensured = false;

  constructor(private readonly sql: SqlStorage) {}

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS subs (
         conn_id TEXT NOT NULL,
         sub_id TEXT NOT NULL,
         filters TEXT NOT NULL,
         PRIMARY KEY (conn_id, sub_id)
       )`,
    );
    this.ensured = true;
  }

  countOther(connId: string, subId: string): number {
    this.ensure();
    const row = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM subs WHERE conn_id = ? AND sub_id != ?",
        connId,
        subId,
      )
      .one();
    return row.n;
  }

  put(connId: string, subId: string, filtersJson: string): void {
    this.ensure();
    this.sql.exec(
      "INSERT OR REPLACE INTO subs (conn_id, sub_id, filters) VALUES (?, ?, ?)",
      connId,
      subId,
      filtersJson,
    );
  }

  delete(connId: string, subId: string): void {
    this.ensure();
    this.sql.exec(
      "DELETE FROM subs WHERE conn_id = ? AND sub_id = ?",
      connId,
      subId,
    );
  }

  deleteConn(connId: string): void {
    this.ensure();
    this.sql.exec("DELETE FROM subs WHERE conn_id = ?", connId);
  }

  all(): SubRow[] {
    this.ensure();
    return this.sql
      .exec<SubRow>("SELECT conn_id, sub_id, filters FROM subs")
      .toArray();
  }

  /**
   * Drop rows whose connection is no longer live (crash/eviction leftovers —
   * webSocketClose normally cleans up). liveConnIds is bounded by
   * MAX_CONNECTIONS, comfortably inside SQLite's bind-parameter limit.
   */
  sweep(liveConnIds: string[]): void {
    this.ensure();
    if (liveConnIds.length === 0) {
      this.sql.exec("DELETE FROM subs");
      return;
    }
    const ph = liveConnIds.map(() => "?").join(", ");
    this.sql.exec(
      `DELETE FROM subs WHERE conn_id NOT IN (${ph})`,
      ...liveConnIds,
    );
  }
}

// --- Protocol core ----------------------------------------------------------------

/** Everything one inbound frame produces; the DO shell applies it verbatim. */
export type HandleOutcome = {
  /** Frames for THIS connection, in send order. */
  frames: string[];
  /** Live fan-out frames addressed by connId (may include the sender). */
  fanout: { connId: string; frame: string }[];
  /** Present when the attachment changed and must be re-serialized. */
  updatedConn?: ConnState;
  /** Present when the connection must be terminated after sending frames. */
  close?: { code: number; reason: string };
};

/** Terse client-facing D1-failure message (NIP-01 `error:` machine prefix). */
const UNAVAILABLE = "error: temporarily unavailable";

/**
 * The relay's pure-ish protocol engine: no sockets, no DO APIs — just env
 * (D1/KV via the reused services), a SubsStore, and an injectable clock.
 * handleMessage never throws; every failure collapses to frames.
 */
export class RelayCore {
  /** Per-connection message-rate windows (in-memory; reset on hibernation). */
  private readonly msgWindows = new Map<
    string,
    { windowStart: number; count: number }
  >();
  /** Per-connection AUTH attempt counts (in-memory; reset on hibernation). */
  private readonly authAttempts = new Map<string, number>();

  constructor(
    private readonly env: Env,
    private readonly subs: SubsStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Forget everything about a closed connection (counters + subs rows). */
  dropConn(connId: string): void {
    this.msgWindows.delete(connId);
    this.authAttempts.delete(connId);
    this.subs.deleteConn(connId);
  }

  /** Handle one raw inbound text frame for a connection. */
  async handleMessage(conn: ConnState, raw: string): Promise<HandleOutcome> {
    const out: HandleOutcome = { frames: [], fanout: [] };

    if (!this.allowMessage(conn.connId)) {
      out.frames.push(noticeFrame("rate-limited: too many messages"));
      out.close = { code: 1008, reason: "message rate exceeded" };
      return out;
    }

    const msg = parseClientMessage(raw, MAX_MESSAGE_LENGTH);
    switch (msg.type) {
      case "event":
        return this.handleEvent(conn, msg.event, out);
      case "req":
        return this.handleReq(conn, msg.subId, msg.filters, out);
      case "close":
        // NIP-01: no confirmation frame for CLOSE.
        this.subs.delete(conn.connId, msg.subId);
        return out;
      case "auth":
        return this.handleAuth(conn, msg.event, out);
      case "invalid":
        // A structurally broken EVENT that still carried a plausible 64-hex
        // id gets a machine-readable OK-false; everything else a NOTICE.
        out.frames.push(
          msg.id !== undefined
            ? okFrame(msg.id, false, msg.reason)
            : noticeFrame(msg.reason),
        );
        return out;
    }
  }

  /**
   * EVENT rejection ladder (plan §B, order is binding): kind allowlist →
   * auth state → pubkey binding → D1 handle allowlist (5-min positive cache
   * in the attachment) → rate limits (fail-closed) → mirrorEvent → fan-out.
   */
  private async handleEvent(
    conn: ConnState,
    ev: NostrEvent,
    out: HandleOutcome,
  ): Promise<HandleOutcome> {
    if (!ALLOWED_EVENT_KINDS.has(ev.kind)) {
      out.frames.push(
        okFrame(ev.id, false, "restricted: only kinds 30023, 5, and 0 are accepted"),
      );
      return out;
    }

    if (conn.authedPubkey === null) {
      out.frames.push(
        okFrame(ev.id, false, "auth-required: authenticate with your nbread key first"),
      );
      // Re-issue the challenge so well-behaved clients (editor.js NIP-42
      // handler) can AUTH and re-send without reconnecting.
      out.frames.push(authFrame(conn.challenge));
      return out;
    }

    if (ev.pubkey !== conn.authedPubkey) {
      out.frames.push(
        okFrame(ev.id, false, "restricted: event pubkey does not match the authenticated key"),
      );
      return out;
    }

    // D1 allowlist: claimed handle, not blocked. Positive results are cached
    // in the attachment for 5 minutes; negatives are never cached (a user
    // claiming their handle mid-connection starts publishing immediately).
    const now = this.now();
    if (now >= conn.allowedUntil) {
      let allowed: boolean;
      try {
        const user = await getUserByPubkey(this.env, conn.authedPubkey);
        allowed = user !== null && user.handle !== null && user.blocked === 0;
      } catch {
        out.frames.push(okFrame(ev.id, false, UNAVAILABLE));
        return out;
      }
      if (!allowed) {
        out.frames.push(
          okFrame(ev.id, false, "restricted: writes are limited to claimed nbread.lol handles"),
        );
        return out;
      }
      conn = { ...conn, allowedUntil: now + ALLOWLIST_CACHE_SECONDS };
      out.updatedConn = conn;
    }

    // Reject events dated too far in the future. Enforces the NIP-11
    // created_at_upper_limit advertised in nip11.ts (constant imported from
    // there so the gate and the advertisement can never drift). Without it a
    // claimed handle could pin a future-dated post atop every cross-author REQ
    // and lock its own replaceable slot until wall time catches up.
    if (ev.created_at > now + CREATED_AT_UPPER_LIMIT_SECONDS) {
      out.frames.push(
        okFrame(ev.id, false, "invalid: created_at is too far in the future"),
      );
      return out;
    }

    // Rate limits (D1 fixed-window, FAIL-CLOSED). Per-pubkey first: denied
    // requests still count, so a single hot key burns its own window without
    // draining the global daily store budget.
    const pkOk = await rateLimitAllows(
      this.env,
      `relay:ev:pk:${ev.pubkey}`,
      EVENT_PK_MAX,
      EVENT_PK_WINDOW_SECONDS,
    );
    const globalOk =
      pkOk &&
      (await rateLimitAllows(
        this.env,
        "relay:global:store",
        GLOBAL_STORE_MAX,
        GLOBAL_STORE_WINDOW_SECONDS,
      ));
    if (!globalOk) {
      out.frames.push(okFrame(ev.id, false, "rate-limited: slow down"));
      return out;
    }

    let result: MirrorResult;
    try {
      result = await mirrorEvent(this.env, ev);
    } catch {
      out.frames.push(okFrame(ev.id, false, UNAVAILABLE));
      return out;
    }
    if (result === "stale") {
      out.frames.push(
        okFrame(ev.id, false, "duplicate: a newer version of this replaceable event is already stored"),
      );
      return out;
    }
    if (result === "invalid") {
      out.frames.push(
        okFrame(ev.id, false, "invalid: id or signature verification failed"),
      );
      return out;
    }

    out.frames.push(okFrame(ev.id, true, ""));

    // Tombstone guard: mirrorEvent returns "stored" even for a kind-30023
    // whose address is covered by a delete horizon — it lands with deleted=1.
    // queryEvents filters WHERE deleted=0, so a fresh REQ would never serve
    // such a row; do not live-fan it either, or a subscriber sees a post the
    // author has deleted. Only kind 30023 can be tombstoned on the store path
    // (kind 0/5 always land deleted=0), so the extra read is scoped to it.
    if (ev.kind === 30023) {
      let servable: boolean;
      try {
        const row = await this.env.DB.prepare(
          "SELECT deleted FROM events WHERE id = ?",
        )
          .bind(ev.id)
          .first<{ deleted: number }>();
        servable = row !== null && row.deleted === 0;
      } catch {
        servable = false; // fail closed: never leak a possibly-deleted post
      }
      if (!servable) return out;
    }

    // Live fan-out: serve subscribers the same canonical 7-field JSON that
    // mirrorEvent stored in events.raw (byte-identical string), matched per
    // subscription with NIP-01 OR-across-filters semantics. The sender's own
    // matching subscriptions are included — protocol-legal double delivery.
    const clean = pickEventFields(ev);
    const rawJson = JSON.stringify(clean);
    for (const row of this.subs.all()) {
      let filters: SanitizedFilter[];
      try {
        filters = JSON.parse(row.filters) as SanitizedFilter[];
      } catch {
        continue; // unreadable row: skip, never throw mid-fan-out
      }
      if (matchesAnyFilter(filters, clean)) {
        out.fanout.push({
          connId: row.conn_id,
          frame: eventFrame(row.sub_id, rawJson),
        });
      }
    }
    return out;
  }

  /** REQ: sanitize → sub cap → stored events (D1) → EOSE → persist the sub. */
  private async handleReq(
    conn: ConnState,
    subId: string,
    rawFilters: unknown[],
    out: HandleOutcome,
  ): Promise<HandleOutcome> {
    const sanitized = sanitizeFilters(rawFilters);
    if ("error" in sanitized) {
      out.frames.push(closedFrame(subId, `invalid: ${sanitized.error}`));
      return out;
    }

    // ≤8 open subs per connection; a REQ reusing an existing subId REPLACES
    // that subscription (NIP-01), so it never counts against itself.
    if (this.subs.countOther(conn.connId, subId) >= MAX_SUBSCRIPTIONS_PER_CONN) {
      out.frames.push(closedFrame(subId, "restricted: too many subscriptions"));
      return out;
    }

    let rows: QueryRow[];
    try {
      rows = await queryEvents(this.env, sanitized);
    } catch {
      out.frames.push(closedFrame(subId, UNAVAILABLE));
      return out;
    }
    for (const row of rows) {
      out.frames.push(eventFrame(subId, row.raw));
    }
    out.frames.push(eoseFrame(subId));

    this.subs.put(conn.connId, subId, JSON.stringify(sanitized));
    return out;
  }

  /** NIP-42 AUTH: bounded attempts, then validateAuthEvent vs the attachment. */
  private async handleAuth(
    conn: ConnState,
    ev: NostrEvent,
    out: HandleOutcome,
  ): Promise<HandleOutcome> {
    const attempts = (this.authAttempts.get(conn.connId) ?? 0) + 1;
    this.authAttempts.set(conn.connId, attempts);
    if (attempts > MAX_AUTH_ATTEMPTS) {
      out.frames.push(noticeFrame("restricted: too many auth attempts"));
      out.close = { code: 1008, reason: "too many auth attempts" };
      return out;
    }

    const result = await validateAuthEvent(
      ev,
      conn.challenge,
      this.env,
      this.now(),
    );
    if (!result.ok) {
      out.frames.push(okFrame(ev.id, false, `invalid: ${result.reason}`));
      return out;
    }

    // allowedUntil resets so a re-auth under a DIFFERENT key can never ride
    // the previous key's cached allowlist verdict.
    out.updatedConn = { ...conn, authedPubkey: result.pubkey, allowedUntil: 0 };
    out.frames.push(okFrame(ev.id, true, ""));
    return out;
  }

  /** In-memory fixed-window message-rate check (120/min per connection). */
  private allowMessage(connId: string): boolean {
    const now = this.now();
    const w = this.msgWindows.get(connId);
    if (w === undefined || now - w.windowStart >= MESSAGE_WINDOW_SECONDS) {
      this.msgWindows.set(connId, { windowStart: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= MAX_MESSAGES_PER_MINUTE;
  }
}

// --- Durable Object shell -----------------------------------------------------------

/** Send that tolerates a concurrently-closed peer (send() throws then). */
function trySend(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // Peer already closing/closed — nothing to do; webSocketClose cleans up.
  }
}

export class RelayDO implements DurableObject {
  private readonly subs: SqlSubsStore;
  private readonly core: RelayCore;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    // D1/KV bindings arrive in the DO's env; mirrorEvent / getUserByPubkey /
    // rateLimitAllows / queryEvents run here unchanged.
    this.subs = new SqlSubsStore(ctx.storage.sql);
    this.core = new RelayCore(env, this.subs);
  }

  /**
   * Upgrade-only entry point. NIP-11 and the plain info page are the
   * WORKER's job (src/relay/http.ts) — an information fetch must never spend
   * a DO request, so anything that reaches the DO without an Upgrade header
   * is a routing mistake and gets a 426.
   */
  fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    const live = this.ctx.getWebSockets();
    if (live.length >= MAX_CONNECTIONS) {
      return new Response("relay at capacity, try again later", {
        status: 503,
        headers: { "Retry-After": "60" },
      });
    }

    // Opportunistic sweep: drop subs rows orphaned by connections that died
    // without a webSocketClose (eviction, crash). Best-effort — never blocks
    // an upgrade.
    try {
      const liveIds: string[] = [];
      for (const ws of live) {
        const tag = this.ctx.getTags(ws)[0];
        if (tag !== undefined) liveIds.push(tag);
      }
      this.subs.sweep(liveIds);
    } catch {
      // sweep failure is harmless (rows retry on the next upgrade)
    }

    const connId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: the runtime owns the socket; the connId tag addresses
    // it for fan-out after wake-ups (ctx.getWebSockets(connId)).
    this.ctx.acceptWebSocket(server, [connId]);

    const challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const conn: ConnState = {
      connId,
      challenge,
      authedPubkey: null,
      allowedUntil: 0,
    };
    server.serializeAttachment(conn);

    // NIP-42: challenge goes out immediately so clients can pre-auth before
    // their first EVENT.
    trySend(server, authFrame(challenge));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      trySend(ws, noticeFrame("invalid: binary frames are not supported"));
      return;
    }
    const conn = ws.deserializeAttachment() as ConnState | null;
    if (conn === null) {
      // Should be unreachable (attachment is set before accept returns) —
      // fail closed rather than process an unattributable frame.
      ws.close(1011, "missing connection state");
      return;
    }

    const out = await this.core.handleMessage(conn, message);

    // Persist attachment changes BEFORE any send: if the isolate dies mid-
    // flush, auth state must not be lost while the client believes it holds.
    if (out.updatedConn !== undefined) {
      ws.serializeAttachment(out.updatedConn);
    }
    for (const frame of out.frames) {
      trySend(ws, frame);
    }
    for (const { connId, frame } of out.fanout) {
      for (const peer of this.ctx.getWebSockets(connId)) {
        trySend(peer, frame);
      }
    }
    if (out.close !== undefined) {
      this.core.dropConn(conn.connId);
      ws.close(out.close.code, out.close.reason);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.cleanup(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.cleanup(ws);
  }

  /** Drop this connection's subs rows + in-memory counters. Idempotent. */
  private cleanup(ws: WebSocket): void {
    const connId = this.ctx.getTags(ws)[0];
    if (connId !== undefined) {
      try {
        this.core.dropConn(connId);
      } catch {
        // best-effort — the upgrade-time sweep catches leftovers
      }
    }
  }
}
