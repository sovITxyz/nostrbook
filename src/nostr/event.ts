/**
 * NIP-01 event primitives: canonical serialization, id computation, schnorr
 * verification, and replaceable-event resolution.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** A Nostr event (NIP-01). Stable contract type — do not change without orchestrator approval. */
export type NostrEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/**
 * Size caps for untrusted events, enforced structurally BEFORE any hashing or
 * signature work so oversized blobs from hostile relays/API bodies never reach
 * serializeEvent/sha256/schnorr (free-tier budget: 10ms CPU per request).
 * Lengths are UTF-16 code units (`string.length`), which lower-bounds bytes.
 */
export const MAX_CONTENT_LENGTH = 262_144; // 256 Ki code units
export const MAX_TAGS = 2_000;
export const MAX_TAG_ITEM_LENGTH = 8_192;

/**
 * Structural validation for untrusted input (relay messages, API bodies).
 * Checks field presence, types, and size caps only — no crypto. NIP-01
 * requires lowercase hex for id/pubkey/sig, so uppercase is rejected as
 * non-canonical. Extra fields are tolerated (relays attach non-standard
 * metadata).
 */
export function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ev = value as Record<string, unknown>;
  if (typeof ev.id !== "string" || !HEX_64.test(ev.id)) return false;
  if (typeof ev.pubkey !== "string" || !HEX_64.test(ev.pubkey)) return false;
  if (typeof ev.sig !== "string" || !HEX_128.test(ev.sig)) return false;
  if (typeof ev.kind !== "number" || !Number.isInteger(ev.kind)) return false;
  if (ev.kind < 0 || ev.kind > 65535) return false;
  if (typeof ev.created_at !== "number" || !Number.isInteger(ev.created_at)) {
    return false;
  }
  if (ev.created_at < 0 || ev.created_at > Number.MAX_SAFE_INTEGER) {
    return false;
  }
  if (typeof ev.content !== "string") return false;
  if (ev.content.length > MAX_CONTENT_LENGTH) return false;
  if (!Array.isArray(ev.tags)) return false;
  if (ev.tags.length > MAX_TAGS) return false;
  for (const tag of ev.tags) {
    if (!Array.isArray(tag)) return false;
    for (const item of tag) {
      if (typeof item !== "string") return false;
      if (item.length > MAX_TAG_ITEM_LENGTH) return false;
    }
  }
  return true;
}

/**
 * NIP-01 canonical serialization: `[0, pubkey, created_at, kind, tags, content]`
 * with no whitespace. JSON.stringify escapes exactly the characters NIP-01
 * mandates (`\` `"` and control chars), so it is the canonical form.
 */
export function serializeEvent(
  ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">,
): string {
  return JSON.stringify([
    0,
    ev.pubkey,
    ev.created_at,
    ev.kind,
    ev.tags,
    ev.content,
  ]);
}

/** sha256 of the canonical serialization, as lowercase hex (the event id). */
export function getEventId(
  ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">,
): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(ev))));
}

/**
 * Verify a Nostr event: structural validation, canonical-serialization sha256
 * id recompute, then BIP-340 schnorr signature verification. Never throws —
 * any malformed input returns false.
 */
export async function verifyEvent(ev: NostrEvent): Promise<boolean> {
  if (!isNostrEvent(ev)) return false;
  if (getEventId(ev) !== ev.id) return false;
  try {
    return schnorr.verify(
      hexToBytes(ev.sig),
      hexToBytes(ev.id),
      hexToBytes(ev.pubkey),
    );
  } catch {
    return false;
  }
}

/**
 * Plain 7-field copy of an event. Relay-delivered events may carry
 * non-standard extra fields (isNostrEvent tolerates them); persistence paths
 * use this to store a canonical JSON form only.
 */
export function pickEventFields(ev: NostrEvent): NostrEvent {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    kind: ev.kind,
    created_at: ev.created_at,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
}

/** First `d` tag value of an event, or `""` if absent (NIP-33 semantics). */
export function getDTag(ev: NostrEvent): string {
  for (const tag of ev.tags) {
    if (tag[0] === "d") return tag[1] ?? "";
  }
  return "";
}

/**
 * Replaceable-event resolution: collapse a batch to the winning event per
 * (pubkey, kind, d-tag) — greatest `created_at` wins, ties broken by
 * lexicographically lower id (NIP-01/NIP-33). Pure data function: events are
 * assumed already verified.
 */
export function resolveReplaceable(events: NostrEvent[]): NostrEvent[] {
  const winners = new Map<string, NostrEvent>();
  for (const ev of events) {
    const key = `${ev.pubkey}:${ev.kind}:${getDTag(ev)}`;
    const current = winners.get(key);
    if (
      current === undefined ||
      ev.created_at > current.created_at ||
      (ev.created_at === current.created_at && ev.id < current.id)
    ) {
      winners.set(key, ev);
    }
  }
  return [...winners.values()];
}
