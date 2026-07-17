/**
 * Relay wire protocol (packet 1): strict inbound message parsing, outbound
 * frame builders, and NIP-42 AUTH event validation. Pure functions — no I/O,
 * nothing here throws on untrusted input.
 */
import { isNostrEvent, verifyEvent, type NostrEvent } from "../nostr/event";
import {
  LOGIN_EVENT_KIND,
  MAX_LOGIN_SKEW_SECONDS,
  relayTagBindsHost,
} from "../routes/auth";
import type { AuthValidation, ClientMessage } from "./types";

/**
 * Max inbound frame size in UTF-16 code units (`string.length`, which
 * lower-bounds bytes). Matches NIP-11 `max_message_length` (1 MiB). The DO
 * passes this to parseClientMessage BEFORE JSON.parse so oversized frames
 * never spend parse CPU.
 */
export const MAX_MESSAGE_LENGTH = 1_048_576;

/** Max subscription-id length (NIP-01 caps it at 64; NIP-11 max_subid_length). */
export const MAX_SUBID_LENGTH = 64;

/** Max concurrent subscriptions per connection (NIP-11 max_subscriptions). */
export const MAX_SUBSCRIPTIONS_PER_CONN = 8;

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Parse one raw WebSocket text frame into a typed client message. Strict
 * NIP-01 JSON-array parsing; never throws — every failure mode (oversized,
 * junk JSON, deep-nested stack blowout inside JSON.parse, non-array, unknown
 * verb, wrong arity, structurally invalid event, bad subId) collapses to
 * `{type: "invalid", reason}`. EVENT/AUTH payloads are isNostrEvent-checked
 * (structure + size caps only — schnorr stays with the caller); REQ filters
 * are returned raw for sanitizeFilters.
 */
export function parseClientMessage(raw: string, maxLen: number): ClientMessage {
  if (raw.length > maxLen) {
    return { type: "invalid", reason: "invalid: message too large" };
  }
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { type: "invalid", reason: "invalid: not valid JSON" };
  }
  if (!Array.isArray(msg) || msg.length === 0) {
    return { type: "invalid", reason: "invalid: message must be a JSON array" };
  }
  const verb: unknown = msg[0];
  if (typeof verb !== "string") {
    return { type: "invalid", reason: "invalid: message type must be a string" };
  }

  switch (verb) {
    case "EVENT": {
      if (msg.length !== 2) {
        return { type: "invalid", reason: 'invalid: EVENT must be ["EVENT", event]' };
      }
      const ev: unknown = msg[1];
      if (!isNostrEvent(ev)) {
        const id = plausibleEventId(ev);
        return {
          type: "invalid",
          reason: "invalid: event failed structural validation",
          ...(id !== undefined ? { id } : {}),
        };
      }
      return { type: "event", event: ev };
    }
    case "REQ": {
      if (msg.length < 3) {
        return {
          type: "invalid",
          reason: 'invalid: REQ must be ["REQ", subId, filter, ...]',
        };
      }
      const subId = validSubId(msg[1]);
      if (subId === null) {
        return { type: "invalid", reason: "invalid: bad subscription id" };
      }
      return { type: "req", subId, filters: msg.slice(2) as unknown[] };
    }
    case "CLOSE": {
      if (msg.length !== 2) {
        return { type: "invalid", reason: 'invalid: CLOSE must be ["CLOSE", subId]' };
      }
      const subId = validSubId(msg[1]);
      if (subId === null) {
        return { type: "invalid", reason: "invalid: bad subscription id" };
      }
      return { type: "close", subId };
    }
    case "AUTH": {
      if (msg.length !== 2) {
        return { type: "invalid", reason: 'invalid: AUTH must be ["AUTH", event]' };
      }
      const ev: unknown = msg[1];
      if (!isNostrEvent(ev)) {
        return { type: "invalid", reason: "invalid: auth event failed structural validation" };
      }
      return { type: "auth", event: ev };
    }
    default:
      return { type: "invalid", reason: `invalid: unknown message type "${verb.slice(0, 16)}"` };
  }
}

/** A valid NIP-01 subscription id: non-empty string, ≤64 chars. */
function validSubId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_SUBID_LENGTH) return null;
  return value;
}

/** Best-effort event id from a payload that FAILED isNostrEvent (for OK-false). */
function plausibleEventId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && HEX_64.test(id) ? id : undefined;
}

// --- Outbound frame builders (all return serialized JSON strings) --------------

/** `["OK", id, ok, message]` (NIP-01/20). */
export function okFrame(id: string, ok: boolean, message: string): string {
  return JSON.stringify(["OK", id, ok, message]);
}

/** `["NOTICE", msg]`. */
export function noticeFrame(msg: string): string {
  return JSON.stringify(["NOTICE", msg]);
}

/** `["CLOSED", subId, msg]` (NIP-01 server-side subscription termination). */
export function closedFrame(subId: string, msg: string): string {
  return JSON.stringify(["CLOSED", subId, msg]);
}

/** `["EOSE", subId]`. */
export function eoseFrame(subId: string): string {
  return JSON.stringify(["EOSE", subId]);
}

/** `["AUTH", challenge]` (NIP-42 challenge frame). */
export function authFrame(challenge: string): string {
  return JSON.stringify(["AUTH", challenge]);
}

/**
 * `["EVENT", subId, event]` — built by STRING CONCATENATION around the
 * canonical stored JSON (`events.raw`). The raw text is never reparsed or
 * re-serialized, so the bytes a client receives are exactly the bytes that
 * were verified and stored (id recomputation on the client side stays valid,
 * and we spend zero parse CPU per fan-out).
 */
export function eventFrame(subId: string, rawEventJson: string): string {
  return '["EVENT",' + JSON.stringify(subId) + "," + rawEventJson + "]";
}

// --- NIP-42 AUTH validation -----------------------------------------------------

/**
 * Validate a client's `["AUTH", event]` response against THIS connection's
 * challenge. Reuses the login flow's building blocks (same kind 22242, same
 * ±600s skew window, same relay-tag host binding via relayTagBindsHost) —
 * the one intentional difference is that the challenge is the connection's
 * in-memory attachment value, NOT a D1 login_nonces row. Cheap structural
 * checks run first; schnorr (verifyEvent) runs last. Never throws.
 */
export async function validateAuthEvent(
  ev: NostrEvent,
  challenge: string,
  env: Env,
  nowSec: number,
): Promise<AuthValidation> {
  // Defense in depth: parse already ran isNostrEvent, but this function must
  // never throw even if handed a forged object directly (e.g. from a future
  // caller), so re-check before touching ev.tags.
  if (!isNostrEvent(ev)) {
    return { ok: false, reason: "malformed auth event" };
  }
  if (ev.kind !== LOGIN_EVENT_KIND) {
    return { ok: false, reason: "wrong event kind" };
  }
  if (Math.abs(ev.created_at - nowSec) > MAX_LOGIN_SKEW_SECONDS) {
    return { ok: false, reason: "created_at outside the acceptance window" };
  }
  // An empty connection challenge must never validate (no AUTH frame was
  // issued yet, so there is nothing to prove possession of).
  const evChallenge = ev.tags.find((t) => t[0] === "challenge")?.[1];
  if (challenge === "" || evChallenge === undefined || evChallenge !== challenge) {
    return { ok: false, reason: "missing or wrong challenge tag" };
  }
  const relayTag = ev.tags.find((t) => t[0] === "relay")?.[1];
  if (relayTag === undefined || !relayTagBindsHost(relayTag, env)) {
    return { ok: false, reason: "missing or wrong relay binding tag" };
  }
  if (!(await verifyEvent(ev))) {
    return { ok: false, reason: "invalid event signature" };
  }
  return { ok: true, pubkey: ev.pubkey };
}
