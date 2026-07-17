/**
 * First-party relay protocol types (packet 1): sanitized REQ filters, parsed
 * inbound client messages, outbound frame shapes, and the NIP-42 AUTH
 * validation result. Pure data contracts — no I/O. The RelayDO (packet 3)
 * consumes these; changing a shape here is a cross-packet contract change.
 */
import type { NostrEvent } from "../nostr/event";

/**
 * A REQ filter after sanitizeFilters (src/relay/filters.ts) has enforced the
 * plan caps. Every array is bounded, every hex string validated, and `limit`
 * is always present (clamped to [1, 500], default 100), so the query engine
 * and fan-out matcher can trust the shape blindly.
 */
export type SanitizedFilter = {
  /** Exact event ids, 64-hex lowercase, ≤50. */
  ids?: string[];
  /** Author pubkeys, 64-hex lowercase, ≤20. */
  authors?: string[];
  /** Event kinds, integers 0–65535, ≤10. */
  kinds?: number[];
  /** Inclusive lower bound on created_at (NIP-01: since ≤ created_at). */
  since?: number;
  /** Inclusive upper bound on created_at (NIP-01: created_at ≤ until). */
  until?: number;
  /** Max events for the stored-events query; ALWAYS set. */
  limit: number;
  /** `#d` filter values (matched against any `d` tag of the event), ≤20. */
  dTags?: string[];
  /**
   * Other single-letter tag filters keyed by the BARE letter (`#t` → `"t"`),
   * ≤20 values each. `#d` never appears here — it lives in `dTags` because
   * the query engine translates it to SQL while these are JS-post-filtered.
   */
  tagFilters?: Record<string, string[]>;
};

// --- Inbound client messages (output of parseClientMessage) -------------------

/** `["EVENT", event]` — event already passed isNostrEvent (structure only). */
export type ClientEventMessage = { type: "event"; event: NostrEvent };

/**
 * `["REQ", subId, ...filters]` — subId validated (string, 1–64 chars);
 * filters are the RAW third-onward elements, still unknown: the caller feeds
 * them to sanitizeFilters (kept separate so a filter error maps to CLOSED
 * while a frame error maps to NOTICE).
 */
export type ClientReqMessage = { type: "req"; subId: string; filters: unknown[] };

/** `["CLOSE", subId]` — subId validated (string, 1–64 chars). */
export type ClientCloseMessage = { type: "close"; subId: string };

/** `["AUTH", event]` — structurally valid; validateAuthEvent does the rest. */
export type ClientAuthMessage = { type: "auth"; event: NostrEvent };

/**
 * Anything unusable: junk JSON, non-array, unknown verb, wrong arity,
 * oversized frame, malformed event/subId. `id` is set when an EVENT frame
 * carried a plausible (64-hex) event id despite failing structural
 * validation, so the DO can answer `["OK", id, false, …]` instead of a bare
 * NOTICE.
 */
export type ClientInvalidMessage = { type: "invalid"; reason: string; id?: string };

/** Union of every parseClientMessage result. */
export type ClientMessage =
  | ClientEventMessage
  | ClientReqMessage
  | ClientCloseMessage
  | ClientAuthMessage
  | ClientInvalidMessage;

// --- Outbound frames (relay → client, NIP-01/42 shapes) ------------------------
// The builders in protocol.ts return SERIALIZED strings; these tuple types
// document the wire shape (and type the JSON.parse side in tests).

export type OkFrame = ["OK", string, boolean, string];
export type NoticeFrame = ["NOTICE", string];
export type ClosedFrame = ["CLOSED", string, string];
export type EoseFrame = ["EOSE", string];
export type AuthChallengeFrame = ["AUTH", string];
export type EventFrame = ["EVENT", string, NostrEvent];

export type RelayFrame =
  | OkFrame
  | NoticeFrame
  | ClosedFrame
  | EoseFrame
  | AuthChallengeFrame
  | EventFrame;

// --- NIP-42 AUTH validation result ---------------------------------------------

/** Result of validateAuthEvent (src/relay/protocol.ts). */
export type AuthValidation =
  | { ok: true; pubkey: string }
  | { ok: false; reason: string };
