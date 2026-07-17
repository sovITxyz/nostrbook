import { Hono } from "hono";
import type { DispatchEnv } from "../types";
import { selfRelayUrl } from "../relay/url";

/**
 * NIP-05: GET /.well-known/nostr.json?name=<local-part> → {names:{<name>:
 * <pubkey_hex>}, relays:{<pubkey_hex>: [...]}} with CORS `*` (Nostr clients
 * fetch this cross-origin). Apex only — identifiers are name@MAIN_HOST.
 *
 * Lookup is case-insensitive (users.handle is COLLATE NOCASE); the response
 * echoes the queried spelling as the key because clients index the map with
 * exactly the local-part they asked for. Unknown/blocked/missing names all
 * return {"names":{}} — indistinguishable on purpose (no user enumeration
 * beyond what public blogs already reveal).
 */
export const wellknownRoutes = new Hono<DispatchEnv>();

/**
 * Plausible NIP-05 local-part shape (superset of our handle regex — includes
 * `_`, `.` and uppercase so well-formed foreign queries reach the NOCASE
 * lookup instead of being rejected on shape).
 */
const NAME_SHAPE = /^[a-zA-Z0-9._-]{1,64}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};

wellknownRoutes.get("/nostr.json", async (c) => {
  const name = c.req.query("name");
  if (name === undefined || !NAME_SHAPE.test(name)) {
    return c.json({ names: {} }, 200, CORS_HEADERS);
  }
  const row = await c.env.DB.prepare(
    "SELECT pubkey, blocked FROM users WHERE handle = ?",
  )
    .bind(name)
    .first<{ pubkey: string; blocked: number }>();
  if (!row || row.blocked) {
    return c.json({ names: {} }, 200, CORS_HEADERS);
  }
  // Relay hints: the first-party nbread relay first (it always carries this
  // user's mirrored events), then the service defaults from env.RELAYS.
  const relays = [
    ...new Set([
      selfRelayUrl(c.env),
      ...c.env.RELAYS.split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0),
    ]),
  ];
  return c.json(
    {
      names: { [name]: row.pubkey },
      relays: { [row.pubkey]: relays },
    },
    200,
    CORS_HEADERS,
  );
});
