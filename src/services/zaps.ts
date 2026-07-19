/**
 * NIP-57 zaps (#12 v1): server-side validation + aggregation of kind 9735
 * zap receipts referencing claimed authors' long-form posts.
 *
 * Trust model: a receipt only counts when
 *   1. its signature verifies (schnorr, like every mirrored event);
 *   2. its `pubkey` equals the author's LNURL-pay `nostrPubkey` (resolved
 *      from the author's kind-0 `lud16`, cached in D1) — so only the
 *      author's own wallet provider can mint countable receipts;
 *   3. its embedded 9734 zap request targets the author (`p`) and one of the
 *      author's stored posts (`a` = 30023:<author>:<d_tag>);
 *   4. the bolt11 invoice amount matches the 9734 `amount` tag (both parsed
 *      here — HRP only, no full bolt11 decode).
 * Receipts are deduped by event id; totals are rebuilt idempotently per
 * address so a crash between statements can never leave drifted counts.
 *
 * The first-party relay cannot hold 9735 (kind allowlist + NIP-42 claimed
 * writes), so receipts are read from the user's configured relays + service
 * defaults only.
 */
import { verifyEvent, type NostrEvent } from "../nostr/event";
import { fetchEvents } from "../nostr/relay";
import { bumpGen } from "./mirror";
import { getProfile } from "./profiles";
import { readBlogSettings, type User } from "./users";
import { isSelfRelayHost } from "../relay/url";

/** Max NEW receipts verified+stored per user per cron run (schnorr budget). */
export const ZAP_VERIFY_CAP = 10;

/** Relay filter limit for the 9735 fetch (one page per run, no paging). */
const ZAP_FETCH_LIMIT = 60;

/** Relay collection deadline for the zap pass (matches refresh). */
const ZAP_TIMEOUT_MS = 8_000;

/** Far-future skew guard (mirrors cron/refresh.ts MAX_FUTURE_SKEW_SECONDS). */
const ZAP_MAX_FUTURE_SKEW_SECONDS = 900;

/** LNURL nostrPubkey cache TTL — lud16 endpoints change rarely. */
export const LNURL_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Response byte cap for the LNURL-pay .well-known fetch. */
const LNURL_MAX_RESPONSE_BYTES = 65_536;

/** LNURL fetch deadline. */
const LNURL_TIMEOUT_MS = 8_000;

/**
 * Per-receipt amount ceiling (msat). Amounts are attacker-influenced relay
 * data feeding integer arithmetic and rollup sums; 1e15 msat (10 BTC) is far
 * beyond any real zap and keeps every sum well inside Number.MAX_SAFE_INTEGER.
 */
export const MAX_ZAP_MSAT = 1_000_000_000_000_000;

const HEX_64 = /^[0-9a-f]{64}$/;

// --- lud16 -------------------------------------------------------------------

/**
 * Shape-validate a lightning address (LUD-16 `user@domain`). lud16 is
 * untrusted kind-0 relay content that ends up in `lightning:` hrefs and in
 * the LNURL-pay URL this module fetches — reject anything that is not a
 * plain local-part@registered-domain (no ports, no IP literals, no
 * userinfo/path tricks). Returns the address with the DOMAIN lowercased, or
 * null.
 */
export function safeLud16(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9._+-]+$/i.test(local)) return null;
  // Registered names only: letters/digits/hyphens labels, alpha TLD — this
  // structurally excludes IPv4/IPv6 literals, localhost (single label), and
  // port suffixes.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    return null;
  }
  return `${local}@${domain}`;
}

/** LNURL-pay endpoint URL for a safeLud16-validated address. */
export function lnurlpUrl(lud16: string): string {
  const at = lud16.lastIndexOf("@");
  const local = lud16.slice(0, at);
  const domain = lud16.slice(at + 1);
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(local)}`;
}

// --- bolt11 amount -----------------------------------------------------------

/**
 * Millisat amount from a bolt11 invoice's human-readable part. Mainnet
 * (`lnbc`) only; requires an explicit amount (zap invoices always carry
 * one). HRP amount is in BTC scaled by the multiplier: m=1e-3, u=1e-6,
 * n=1e-9, p=1e-12; 1 BTC = 1e11 msat. Integer math throughout; `p` amounts
 * not divisible by 10 (sub-msat) and anything over MAX_ZAP_MSAT return null.
 */
export function bolt11Msat(invoice: string | undefined): number | null {
  if (typeof invoice !== "string") return null;
  const m = /^lnbc(\d+)([munp])?1/i.exec(invoice.trim());
  if (!m) return null;
  const digitsStr = m[1]!;
  if (digitsStr.length > 15) return null; // overflow guard before Number()
  const digits = Number(digitsStr);
  if (!Number.isSafeInteger(digits) || digits <= 0) return null;
  let msat: number;
  switch (m[2]?.toLowerCase()) {
    case undefined:
      msat = digits * 100_000_000_000;
      break;
    case "m":
      msat = digits * 100_000_000;
      break;
    case "u":
      msat = digits * 100_000;
      break;
    case "n":
      msat = digits * 100;
      break;
    case "p":
      if (digits % 10 !== 0) return null;
      msat = digits / 10;
      break;
    default:
      return null;
  }
  if (!Number.isSafeInteger(msat) || msat <= 0 || msat > MAX_ZAP_MSAT) {
    return null;
  }
  return msat;
}

// --- receipt validation ------------------------------------------------------

/** First value of the first tag named `name`, or undefined. */
function firstTag(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return undefined;
}

export type ParsedZapReceipt = {
  receiptId: string;
  address: string; // 30023:<author>:<d_tag>
  dTag: string;
  authorPubkey: string;
  senderPubkey: string | null; // the 9734 signer (ephemeral for anon zaps)
  amountMsat: number;
  createdAt: number;
};

/**
 * Structural NIP-57 receipt validation (no crypto — verifyEvent is the
 * caller's job, AFTER the cheap checks and the nostrPubkey binding). Returns
 * null unless every appendix rule that can be checked offline holds:
 * receipt targets the author via `p`; its `a` is an address of the author's
 * (30023 only); the `description` parses to a kind 9734 whose `p`/`a` match
 * and whose `amount` equals the bolt11 invoice amount.
 */
export function parseZapReceipt(
  ev: NostrEvent,
  authorPubkey: string,
): ParsedZapReceipt | null {
  if (ev.kind !== 9735) return null;
  if (firstTag(ev.tags, "p") !== authorPubkey) return null;

  const address = firstTag(ev.tags, "a");
  if (address === undefined) return null;
  const addrMatch = /^30023:([0-9a-f]{64}):([\s\S]*)$/.exec(address);
  if (!addrMatch || addrMatch[1] !== authorPubkey) return null;
  const dTag = addrMatch[2] ?? "";

  const description = firstTag(ev.tags, "description");
  if (description === undefined) return null;
  let request: unknown;
  try {
    request = JSON.parse(description);
  } catch {
    return null;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return null;
  }
  const req = request as Record<string, unknown>;
  if (req.kind !== 9734) return null;
  if (typeof req.pubkey !== "string" || !HEX_64.test(req.pubkey)) return null;
  if (!Array.isArray(req.tags)) return null;
  const reqTags = req.tags.filter(
    (t): t is string[] =>
      Array.isArray(t) && t.every((item) => typeof item === "string"),
  );
  if (firstTag(reqTags, "p") !== authorPubkey) return null;
  if (firstTag(reqTags, "a") !== address) return null;

  const amountStr = firstTag(reqTags, "amount");
  if (amountStr === undefined || !/^\d{1,15}$/.test(amountStr)) return null;
  const amountMsat = Number(amountStr);
  if (
    !Number.isSafeInteger(amountMsat) ||
    amountMsat <= 0 ||
    amountMsat > MAX_ZAP_MSAT
  ) {
    return null;
  }

  // NIP-57 appendix: the invoice amount must equal the request amount.
  const invoiceMsat = bolt11Msat(firstTag(ev.tags, "bolt11"));
  if (invoiceMsat === null || invoiceMsat !== amountMsat) return null;

  return {
    receiptId: ev.id,
    address,
    dTag,
    authorPubkey,
    senderPubkey: req.pubkey,
    amountMsat,
    createdAt: ev.created_at,
  };
}

// --- LNURL nostrPubkey resolution -------------------------------------------

/**
 * Injectable LNURL fetcher seam (tests swap the network call — same pattern
 * as the Turnstile verifier). Returns the endpoint's nostrPubkey when the
 * endpoint advertises `allowsNostr: true`, else null.
 */
export type LnurlFetcher = (url: string) => Promise<string | null>;

const realLnurlFetcher: LnurlFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LNURL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok || !res.body) return null;
    // Byte-capped read: the domain comes from attacker-influenced lud16 and
    // must not stream an unbounded body into memory.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LNURL_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(body));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const d = data as Record<string, unknown>;
    if (d.allowsNostr !== true) return null;
    if (typeof d.nostrPubkey !== "string") return null;
    const pk = d.nostrPubkey.toLowerCase();
    return HEX_64.test(pk) ? pk : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

let lnurlFetcher: LnurlFetcher = realLnurlFetcher;

/** TEST ONLY: swap the LNURL fetcher. Pass null to restore the real one. */
export function setLnurlFetcherForTests(fn: LnurlFetcher | null): void {
  lnurlFetcher = fn ?? realLnurlFetcher;
}

/**
 * The author's LNURL-pay nostrPubkey for a validated lud16, through the D1
 * cache (TTL LNURL_CACHE_TTL_SECONDS — negative results cache too, so a dead
 * endpoint costs one subrequest per TTL, not one per run).
 */
export async function resolveNostrPubkey(
  env: Env,
  lud16: string,
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare(
    "SELECT nostr_pubkey, checked_at FROM lnurl_cache WHERE lud16 = ?",
  )
    .bind(lud16)
    .first<{ nostr_pubkey: string | null; checked_at: number }>();
  if (cached && now - cached.checked_at < LNURL_CACHE_TTL_SECONDS) {
    return cached.nostr_pubkey;
  }
  const pubkey = await lnurlFetcher(lnurlpUrl(lud16));
  await env.DB.prepare(
    `INSERT INTO lnurl_cache (lud16, nostr_pubkey, checked_at)
     VALUES (?, ?, ?)
     ON CONFLICT(lud16) DO UPDATE SET
       nostr_pubkey = excluded.nostr_pubkey,
       checked_at = excluded.checked_at`,
  )
    .bind(lud16, pubkey, now)
    .run();
  return pubkey;
}

// --- storage -----------------------------------------------------------------

/** Which of `ids` are already-stored receipt ids. */
async function storedZapIds(env: Env, ids: string[]): Promise<Set<string>> {
  const stored = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    const rs = await env.DB.prepare(
      `SELECT receipt_id FROM zaps WHERE receipt_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ receipt_id: string }>();
    for (const row of rs.results) stored.add(row.receipt_id);
  }
  return stored;
}

/**
 * Store one validated receipt and rebuild its address rollup. The rollup is
 * recomputed FROM the zaps table in the same atomic batch (INSERT OR IGNORE
 * + SELECT-based upsert), so replays and races converge on correct totals.
 */
export async function storeZapReceipt(
  env: Env,
  zap: ParsedZapReceipt,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO zaps
         (receipt_id, address, author_pubkey, sender_pubkey, amount_msat, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      zap.receiptId,
      zap.address,
      zap.authorPubkey,
      zap.senderPubkey,
      zap.amountMsat,
      zap.createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO zap_totals (address, msat_total, zap_count)
       SELECT address, SUM(amount_msat), COUNT(*) FROM zaps WHERE address = ?
       ON CONFLICT(address) DO UPDATE SET
         msat_total = excluded.msat_total, zap_count = excluded.zap_count`,
    ).bind(zap.address),
  ]);
}

export type ZapTotals = { msatTotal: number; zapCount: number };

/** Rollup totals for a post address, or null when never zapped. */
export async function zapTotals(
  env: Env,
  address: string,
): Promise<ZapTotals | null> {
  const row = await env.DB.prepare(
    "SELECT msat_total, zap_count FROM zap_totals WHERE address = ?",
  )
    .bind(address)
    .first<{ msat_total: number; zap_count: number }>();
  return row ? { msatTotal: row.msat_total, zapCount: row.zap_count } : null;
}

// --- cron pass ---------------------------------------------------------------

/** Read the zap sync watermark from a users.settings blob (0 when unset). */
export function readZapSince(settings: string): number {
  try {
    const parsed: unknown = JSON.parse(settings);
    if (parsed !== null && typeof parsed === "object") {
      const sync = (parsed as Record<string, unknown>).sync;
      if (sync !== null && typeof sync === "object") {
        const since = (sync as Record<string, unknown>).zap_since;
        if (typeof since === "number" && Number.isFinite(since) && since >= 0) {
          return Math.floor(since);
        }
      }
    }
  } catch {
    // malformed settings → start from 0
  }
  return 0;
}

/** Persist the zap watermark ($.sync.zap_since — same discipline as $.sync.since). */
async function writeZapSince(
  env: Env,
  pubkey: string,
  since: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET settings = json_set(
       CASE
         WHEN json_valid(settings) AND json_type(settings) = 'object' THEN
           CASE WHEN json_type(settings, '$.sync') = 'object' THEN settings
                ELSE json_set(settings, '$.sync', json('{}')) END
         ELSE '{}'
       END,
       '$.sync.zap_since', ?
     ) WHERE pubkey = ?`,
  )
    .bind(since, pubkey)
    .run();
}

/** Does the zapped post actually exist (stored, owned, not deleted)? */
async function postExists(
  env: Env,
  pubkey: string,
  dTag: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM events
     WHERE pubkey = ? AND kind = 30023 AND d_tag = ? AND deleted = 0`,
  )
    .bind(pubkey, dTag)
    .first();
  return row !== null;
}

/**
 * Zap ingestion for one user (called from the cron loop after the post
 * refresh). Skips users without a shape-valid lud16 or a resolvable
 * nostrPubkey — without the wallet key there is nothing to bind receipts to.
 * Watermark advances only over processed receipts, and only persists when
 * the relay window closed (batch below the fetch limit) — mirroring the
 * refresh pass's no-silent-skips rule without its paging.
 */
export async function refreshZapsForUser(
  env: Env,
  baseRelays: string[],
  user: User,
): Promise<void> {
  const profile = await getProfile(env, user.pubkey);
  const lud16 = safeLud16(profile?.lud16);
  if (lud16 === null) return;
  const nostrPubkey = await resolveNostrPubkey(env, lud16);
  if (nostrPubkey === null) return;

  const configured = readBlogSettings(user.settings).relays;
  const relays = [...new Set([...configured, ...baseRelays])].filter(
    (url) => !isSelfRelayHost(url, env),
  );
  if (relays.length === 0) return;

  const since = readZapSince(user.settings);
  const filter: Record<string, unknown> = {
    kinds: [9735],
    "#p": [user.pubkey],
    limit: ZAP_FETCH_LIMIT,
  };
  if (since > 0) filter.since = since;
  const batch = await fetchEvents(relays, filter, ZAP_TIMEOUT_MS);
  const windowClosed = batch.length < ZAP_FETCH_LIMIT;

  // Cheap pre-filters before any crypto: right kind, right wallet key.
  const candidates = batch
    .filter((ev) => ev.kind === 9735 && ev.pubkey === nostrPubkey)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) {
    if (windowClosed && batch.length > 0) {
      const newest = Math.max(...batch.map((ev) => ev.created_at));
      const maxPlausible =
        Math.floor(Date.now() / 1000) + ZAP_MAX_FUTURE_SKEW_SECONDS;
      const next = Math.min(newest, maxPlausible);
      if (next > since) await writeZapSince(env, user.pubkey, next);
    }
    return;
  }

  const stored = await storedZapIds(
    env,
    candidates.map((ev) => ev.id),
  );
  const maxPlausible =
    Math.floor(Date.now() / 1000) + ZAP_MAX_FUTURE_SKEW_SECONDS;

  let credits = ZAP_VERIFY_CAP;
  let watermark = since;
  let storedAny = false;
  let cappedOut = false;
  for (const ev of candidates) {
    if (ev.created_at > maxPlausible) continue; // forged/skewed — never advance
    if (stored.has(ev.id)) {
      if (ev.created_at > watermark) watermark = ev.created_at;
      continue;
    }
    const parsed = parseZapReceipt(ev, user.pubkey);
    if (parsed === null) {
      // Structurally invalid for this author — safe to advance past (it can
      // never become countable) without spending a verification credit.
      if (ev.created_at > watermark) watermark = ev.created_at;
      continue;
    }
    if (credits === 0) {
      cappedOut = true;
      break; // resume from `watermark` next tick
    }
    credits--;
    if (!(await verifyEvent(ev))) continue; // forged — never advance
    if (!(await postExists(env, user.pubkey, parsed.dTag))) {
      // Valid receipt for a post we do not mirror (yet) — skip WITHOUT
      // advancing, so it counts once the post lands via refresh.
      continue;
    }
    await storeZapReceipt(env, parsed);
    storedAny = true;
    if (ev.created_at > watermark) watermark = ev.created_at;
  }

  if (storedAny) await bumpGen(env, user.pubkey);

  watermark = Math.min(watermark, maxPlausible);
  // Persist only over a closed window (nothing truncated) unless we capped
  // out mid-batch — then the watermark is a true resume point regardless.
  if ((windowClosed || cappedOut) && watermark !== since) {
    await writeZapSince(env, user.pubkey, watermark);
  }
}
