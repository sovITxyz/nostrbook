/**
 * NIP-11 relay information document (packet 1). Pure — no I/O.
 *
 * Served by the WORKER (not the DO — an information fetch must never spend a
 * DO request) when GET /relay carries `Accept: application/nostr+json`. The
 * limitation block mirrors the enforced caps exactly: values are imported
 * from the modules that enforce them so the advertisement can never drift
 * from the implementation.
 */
import { MAX_CONTENT_LENGTH, MAX_TAGS } from "../nostr/event";
import { adminPubkeyOf } from "../routes/admin";
import { MAX_LIMIT } from "./filters";
import {
  MAX_MESSAGE_LENGTH,
  MAX_SUBID_LENGTH,
  MAX_SUBSCRIPTIONS_PER_CONN,
} from "./protocol";

/** Public source repository (NIP-11 `software`). */
export const RELAY_SOFTWARE = "https://github.com/sovITxyz/nbread";
/** Relay implementation version (NIP-11 `version`). */
export const RELAY_VERSION = "0.1.0";
/**
 * Max seconds an event's created_at may sit in the future (NIP-11
 * `created_at_upper_limit`). Plan §B literal.
 */
export const CREATED_AT_UPPER_LIMIT_SECONDS = 900;

export type Nip11Document = {
  name: string;
  description: string;
  supported_nips: number[];
  software: string;
  version: string;
  /** Admin contact pubkey (lowercase hex) — present iff ADMIN_PUBKEY is set. */
  pubkey?: string;
  limitation: {
    auth_required: boolean;
    restricted_writes: boolean;
    max_message_length: number;
    max_subscriptions: number;
    max_limit: number;
    max_subid_length: number;
    max_event_tags: number;
    max_content_length: number;
    created_at_upper_limit: number;
  };
};

/**
 * Build the NIP-11 document. `pubkey` is included IFF ADMIN_PUBKEY resolves
 * (hex or npub1…, via the admin surface's own parser — same normalization,
 * same fail-closed posture on malformed values).
 */
export function nip11Document(env: Env): Nip11Document {
  const doc: Nip11Document = {
    name: "nbread relay",
    description:
      "First-party relay for nbread.lol blogs. Reads are open; writes are " +
      "restricted to claimed nbread authors (NIP-42 auth; kinds 30023, 5, " +
      "and 0 — own events only).",
    supported_nips: [1, 9, 11, 42],
    software: RELAY_SOFTWARE,
    version: RELAY_VERSION,
    limitation: {
      auth_required: false, // reads are open; writes demand AUTH (restricted_writes)
      restricted_writes: true,
      max_message_length: MAX_MESSAGE_LENGTH,
      max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONN,
      max_limit: MAX_LIMIT,
      max_subid_length: MAX_SUBID_LENGTH,
      max_event_tags: MAX_TAGS,
      max_content_length: MAX_CONTENT_LENGTH,
      created_at_upper_limit: CREATED_AT_UPPER_LIMIT_SECONDS,
    },
  };
  const pubkey = adminPubkeyOf(env);
  if (pubkey !== null) doc.pubkey = pubkey;
  return doc;
}
