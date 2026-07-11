/**
 * Fixed-window rate limiting backed by the D1 `rate_limits` table (NOT KV —
 * free-tier KV write budget is reserved for sessions/nonces/gen bumps).
 *
 * Implemented in P3 (was slated for P4): the unclaimed-npub on-demand mirror
 * needs an application-level abuse cap (global + per-IP) that the per-pubkey
 * cooldown cannot provide — an attacker bypasses per-pubkey throttles simply
 * by enumerating distinct npubs. P4 (auth + handle claim) reuses this.
 *
 * The counter is a single upsert statement, so concurrent requests cannot
 * lose increments to a read-modify-write race. Denied requests still count
 * (the window keeps filling), which is the desired behavior for abuse caps.
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  // Defensive: RETURNING always yields a row; treat a missing one as denied.
  const count = row?.count ?? Number.MAX_SAFE_INTEGER;
  return { allowed: count <= max, remaining: Math.max(0, max - count) };
}
