import { pickEventFields, type NostrEvent } from "../nostr/event";

/** Row shape of the `profiles` table. */
export type ProfileRow = {
  pubkey: string;
  name: string | null;
  picture: string | null;
  about: string | null;
  nip05: string | null;
  lud16: string | null;
  raw: string;
  updated_at: number;
};

// Field caps: kind 0 content is untrusted relay data; keep stored fields
// bounded (views escape on output, but there is no reason to persist blobs).
// Exported for the dashboard profile form, whose maxlength attributes must
// match what upsertProfile persists (fields without a column — display_name,
// banner, website, lud06 — only live in the event content and use the same
// caps as their column-backed siblings).
export const PROFILE_FIELD_MAX = {
  name: 200,
  display_name: 200,
  picture: 1_000,
  banner: 1_000,
  website: 1_000,
  about: 2_000,
  nip05: 320,
  lud16: 320, // user@domain, same shape family as nip05
  lud06: 1_000, // bech32 LNURL strings run long
} as const;
const MAX_NAME = PROFILE_FIELD_MAX.name;
const MAX_PICTURE = PROFILE_FIELD_MAX.picture;
const MAX_ABOUT = PROFILE_FIELD_MAX.about;
const MAX_NIP05 = PROFILE_FIELD_MAX.nip05;
const MAX_LUD16 = PROFILE_FIELD_MAX.lud16;

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
  let lud16: string | null = null;
  try {
    const data: unknown = JSON.parse(ev.content);
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      name = strField(d.name, MAX_NAME) ?? strField(d.display_name, MAX_NAME);
      picture = strField(d.picture, MAX_PICTURE);
      about = strField(d.about, MAX_ABOUT);
      nip05 = strField(d.nip05, MAX_NIP05);
      lud16 = strField(d.lud16, MAX_LUD16);
    }
  } catch {
    // malformed kind 0 content → all-null profile fields
  }

  await env.DB.prepare(
    `INSERT INTO profiles (pubkey, name, picture, about, nip05, lud16, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       name = excluded.name, picture = excluded.picture,
       about = excluded.about, nip05 = excluded.nip05,
       lud16 = excluded.lud16,
       raw = excluded.raw, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= profiles.updated_at`,
  )
    .bind(
      ev.pubkey,
      name,
      picture,
      about,
      nip05,
      lud16,
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

/** The kind 0 content fields the dashboard profile form edits. */
export type ProfileContentFields = {
  name: string;
  display_name: string;
  about: string;
  picture: string;
  banner: string;
  website: string;
  nip05: string;
  lud16: string;
  lud06: string;
};

/**
 * Parse a stored `profiles.raw` event back into the editable content fields
 * (the columns only cover a subset — display_name/banner/website/lud06 live
 * solely in the event content) plus every OTHER content key verbatim. The
 * profile form republishes the whole kind 0, so unknown fields (custom app
 * metadata, deprecated aliases) must ride along or a save would silently
 * erase them. Defensive on both JSON layers: malformed relay data prefills
 * as empty, never throws. Fields get the same trim + caps as upsertProfile
 * so the form shows exactly what a re-publish would persist.
 */
export function storedProfileContent(raw: string): {
  fields: ProfileContentFields;
  extra: Record<string, unknown>;
} {
  const fields: ProfileContentFields = {
    name: "",
    display_name: "",
    about: "",
    picture: "",
    banner: "",
    website: "",
    nip05: "",
    lud16: "",
    lud06: "",
  };
  const extra: Record<string, unknown> = {};
  try {
    const ev: unknown = JSON.parse(raw);
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) {
      return { fields, extra };
    }
    const content = (ev as Record<string, unknown>).content;
    if (typeof content !== "string") return { fields, extra };
    const data: unknown = JSON.parse(content);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { fields, extra };
    }
    const d = data as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (Object.hasOwn(fields, key)) {
        const k = key as keyof ProfileContentFields;
        fields[k] = strField(d[k], PROFILE_FIELD_MAX[k]) ?? "";
      } else {
        extra[key] = d[key];
      }
    }
  } catch {
    // malformed raw/content JSON → empty prefill
  }
  return { fields, extra };
}
