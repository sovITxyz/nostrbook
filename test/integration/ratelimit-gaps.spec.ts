// P7 rate-limit review: the three endpoints the final audit found unmetered
// now carry D1 fixed-window limits (zero KV writes, same rate_limits pattern
// as every other cap):
//   - GET /npub1…*      → npub:ip     (unmetered D1 read path, ~100 rows/req)
//   - POST /logout      → logout:ip   (unmetered KV DELETE = a KV write op)
//   - GET /dashboard    → dash:pk     (unmetered ~100-row authed render)
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALICE_PK,
  BOB_PK,
  sessionCookieFor,
} from "../helpers";
import { createSession, sessionKey } from "../../src/services/sessions";
import {
  NPUB_VIEW_RATE_MAX,
  NPUB_VIEW_RATE_WINDOW_SECONDS,
} from "../../src/routes/main";
import { LOGOUT_MAX } from "../../src/routes/auth";
import { DASHBOARD_VIEW_MAX } from "../../src/routes/dashboard";

/** Pin a rate_limits counter to a count in the CURRENT window. */
async function seedCounter(
  key: string,
  count: number,
  windowSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = excluded.count, window_start = excluded.window_start`,
  )
    .bind(key, count, windowStart)
    .run();
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
});

describe("npub view limiter", () => {
  // Shape-valid npub with a bad checksum: the route matches (so the limiter
  // runs) but resolution fails before any relay work — a pure-404 probe.
  const badNpub = `npub1${"z".repeat(58)}`;

  it("denies a capped IP with 429 and leaves other IPs unaffected", async () => {
    await seedCounter(
      "npub:ip:6.6.6.6",
      NPUB_VIEW_RATE_MAX,
      NPUB_VIEW_RATE_WINDOW_SECONDS,
    );
    const denied = await SELF.fetch(`https://nostrbook.net/${badNpub}`, {
      headers: { "CF-Connecting-IP": "6.6.6.6" },
    });
    expect(denied.status).toBe(429);

    const other = await SELF.fetch(`https://nostrbook.net/${badNpub}`, {
      headers: { "CF-Connecting-IP": "7.7.7.7" },
    });
    expect(other.status).toBe(404); // normal not-found, not rate limited
  });

  it("covers npub sub-paths (feeds, slugs) with the same limiter", async () => {
    await seedCounter(
      "npub:ip:6.6.6.7",
      NPUB_VIEW_RATE_MAX,
      NPUB_VIEW_RATE_WINDOW_SECONDS,
    );
    const denied = await SELF.fetch(
      `https://nostrbook.net/${badNpub}/rss.xml`,
      { headers: { "CF-Connecting-IP": "6.6.6.7" } },
    );
    expect(denied.status).toBe(429);
  });
});

describe("logout limiter", () => {
  it("caps the KV-delete burn: capped IP gets 429 and the session SURVIVES", async () => {
    const token = await createSession(env, ALICE_PK);
    await seedCounter("logout:ip:6.6.7.1", LOGOUT_MAX, 15 * 60);

    const denied = await SELF.fetch("https://nostrbook.net/logout", {
      method: "POST",
      headers: { "CF-Connecting-IP": "6.6.7.1", Cookie: `sid=${token}` },
    });
    expect(denied.status).toBe(429);
    // The guarded resource (the KV write) was NOT spent.
    expect(await env.KV.get(sessionKey(token))).not.toBeNull();

    // A fresh IP logs out normally and the session dies.
    const ok = await SELF.fetch("https://nostrbook.net/logout", {
      method: "POST",
      headers: { "CF-Connecting-IP": "6.6.7.2", Cookie: `sid=${token}` },
    });
    expect(ok.status).toBe(200);
    expect(await env.KV.get(sessionKey(token))).toBeNull();
  });
});

describe("dashboard view limiter", () => {
  it("caps per pubkey without touching other keys", async () => {
    const aliceCookie = await sessionCookieFor(ALICE_PK);
    const bobCookie = await sessionCookieFor(BOB_PK);
    await seedCounter(`dash:pk:${ALICE_PK}`, DASHBOARD_VIEW_MAX, 5 * 60);

    const denied = await SELF.fetch("https://nostrbook.net/dashboard", {
      headers: { Cookie: aliceCookie },
    });
    expect(denied.status).toBe(429);

    const ok = await SELF.fetch("https://nostrbook.net/dashboard", {
      headers: { Cookie: bobCookie },
    });
    expect(ok.status).toBe(200);
  });

  it("anonymous dashboard requests still redirect (no limiter spend)", async () => {
    const res = await SELF.fetch("https://nostrbook.net/dashboard", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT count FROM rate_limits WHERE key LIKE 'dash:pk:%'",
    ).first();
    expect(row).toBeNull();
  });
});
