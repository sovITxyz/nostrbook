/**
 * Relay endpoint URL helpers (packet 1). Pure — no I/O.
 *
 * The first-party relay lives at wss://<MAIN_HOST>/relay by design (no new
 * env var; plan §B): selfRelayUrl derives it, and isSelfRelayHost lets the
 * cron self-filter merged relay lists — a same-zone Worker ws subrequest
 * won't reliably re-enter the Worker, and the store is shared D1 anyway, so
 * the cron reading its own relay would be a wasted (or hanging) connection.
 */

/** The first-party relay endpoint for this deployment. */
export function selfRelayUrl(env: Env): string {
  return "wss://" + env.MAIN_HOST.toLowerCase() + "/relay";
}

/**
 * Does this relay URL point at OUR host? Hostname comparison only (any
 * scheme/path/port form a client might have recorded still names the same
 * zone). Invalid/unparseable URLs → false — a junk entry in a merged relay
 * list must never be mistaken for self.
 */
export function isSelfRelayHost(url: string, env: Env): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === env.MAIN_HOST.toLowerCase();
}
