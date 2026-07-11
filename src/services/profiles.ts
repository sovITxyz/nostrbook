import { pickEventFields, type NostrEvent } from "../nostr/event";

/** Row shape of the `profiles` table. */
export type ProfileRow = {
  pubkey: string;
  name: string | null;
  picture: string | null;
  about: string | null;
  nip05: string | null;
  raw: string;
  updated_at: number;
};

// Field caps: kind 0 content is untrusted relay data; keep stored fields
// bounded (views escape on output, but there is no reason to persist blobs).
const MAX_NAME = 200;
const MAX_PICTURE = 1_000;
const MAX_ABOUT = 2_000;
const MAX_NIP05 = 320;

/** Trimmed, length-capped string field, or null when absent/not a string. */
function strField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/**
 * Upsert a kind 0 metadata event into the profiles table. Content is parsed
 * defensively (malformed JSON / non-object content → all-null fields, the
 * row still records `updated_at` so stale kind 0s cannot resurrect old
 * data). Newest `created_at` wins; ties are resolved upstream by the
 * events-table replaceable upsert (mirrorEvent only calls this for the
 * winning event), so the guard here is `>=` to let a tie-break winner
 * through.
 */
export async function upsertProfile(env: Env, ev: NostrEvent): Promise<void> {
  if (ev.kind !== 0) return;

  let name: string | null = null;
  let picture: string | null = null;
  let about: string | null = null;
  let nip05: string | null = null;
  try {
    const data: unknown = JSON.parse(ev.content);
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      name = strField(d.name, MAX_NAME) ?? strField(d.display_name, MAX_NAME);
      picture = strField(d.picture, MAX_PICTURE);
      about = strField(d.about, MAX_ABOUT);
      nip05 = strField(d.nip05, MAX_NIP05);
    }
  } catch {
    // malformed kind 0 content → all-null profile fields
  }

  await env.DB.prepare(
    `INSERT INTO profiles (pubkey, name, picture, about, nip05, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       name = excluded.name, picture = excluded.picture,
       about = excluded.about, nip05 = excluded.nip05,
       raw = excluded.raw, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= profiles.updated_at`,
  )
    .bind(
      ev.pubkey,
      name,
      picture,
      about,
      nip05,
      JSON.stringify(pickEventFields(ev)),
      ev.created_at,
    )
    .run();
}

/** Get a mirrored profile by pubkey. */
export async function getProfile(
  env: Env,
  pubkey: string,
): Promise<ProfileRow | null> {
  const row = await env.DB.prepare("SELECT * FROM profiles WHERE pubkey = ?")
    .bind(pubkey)
    .first<ProfileRow>();
  return row ?? null;
}
