// P4 auth: NIP-07 / kind 22242 challenge-response login. Covers the happy
// path, every rejection class (forged sig, wrong kind, stale created_at
// incl. the exact ±600s boundary, expired/replayed/unknown nonce, wrong
// pubkey, missing/misbound relay tag), strict single-use nonce consumption
// under concurrency (nonces live in D1 login_nonces — ratified P4 addendum),
// cookie flags, session persistence, logout, fixation resistance, and the
// login/challenge rate limits (per-IP and the global daily challenge
// budget). Login events are signed in-test with nostr-tools using the
// committed throwaway fixture keys.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALICE_PK,
  BOB_SK,
  getChallenge,
  postLogin,
  resetRateLimits,
  signLoginEvent,
} from "../helpers";
import {
  CHALLENGE_GLOBAL_DAILY_CAP,
  CHALLENGE_GLOBAL_KEY,
  NONCE_TTL_SECONDS,
} from "../../src/routes/auth";
import { sessionKey, SESSION_TTL_SECONDS } from "../../src/services/sessions";

const now = () => Math.floor(Date.now() / 1000);

/** Look up a nonce row in the D1 login_nonces store (null = absent/consumed). */
async function nonceRow(
  nonce: string,
): Promise<{ nonce: string; expires_at: number } | null> {
  return env.DB.prepare(
    "SELECT nonce, expires_at FROM login_nonces WHERE nonce = ?1",
  )
    .bind(nonce)
    .first<{ nonce: string; expires_at: number }>();
}

/** Backdate a nonce's expires_at — byte-for-byte what real expiry looks like. */
async function expireNonce(nonce: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE login_nonces SET expires_at = ?1 WHERE nonce = ?2",
  )
    .bind(now() - 1, nonce)
    .run();
}

/**
 * Park the wall clock just after a second boundary so second-granularity
 * boundary tests (created_at exactly ±600s) cannot flake when the request
 * itself crosses into the next second: after aligning there are ~700ms of
 * headroom, and the whole sign+POST round-trip takes a few dozen ms.
 */
async function alignToSecondStart(): Promise<void> {
  while (Date.now() % 1000 > 300) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

function flipLastChar(hex: string): string {
  return hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
}

/** Extract `sid=<token>` from a Set-Cookie header. */
function sidFrom(res: Response): string {
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = cookie.match(/sid=([0-9a-f]{64})/);
  if (!m) throw new Error(`no sid cookie in: ${cookie}`);
  return m[1]!;
}

beforeEach(async () => {
  await resetRateLimits();
});

describe("GET /login", () => {
  it("serves the login page with the NIP-07 glue", async () => {
    const res = await SELF.fetch("https://nbread.lol/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("login-button");
    expect(html).toContain("/js/login.js");
  });

  it("redirects to /dashboard when already signed in", async () => {
    const challenge = await getChallenge();
    const login = await postLogin(signLoginEvent(challenge));
    expect(login.status).toBe(200);
    const res = await SELF.fetch("https://nbread.lol/login", {
      headers: { Cookie: `sid=${sidFrom(login)}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
  });
});

describe("GET /login/challenge", () => {
  it("issues a 64-hex nonce stored in D1 with a 5min expiry", async () => {
    const before = now();
    const res = await SELF.fetch("https://nbread.lol/login/challenge");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string; ttl: number };
    expect(body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ttl).toBe(NONCE_TTL_SECONDS);
    const row = await nonceRow(body.challenge);
    expect(row).not.toBeNull();
    // expires_at = issue time + 300s (bracketed against our own clock reads).
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + NONCE_TTL_SECONDS);
    expect(row!.expires_at).toBeLessThanOrEqual(now() + NONCE_TTL_SECONDS);
  });

  it("sweeps expired nonces opportunistically on issuance", async () => {
    const stale = await getChallenge();
    await expireNonce(stale);
    await getChallenge(); // any later issuance deletes lapsed rows
    expect(await nonceRow(stale)).toBeNull();
  });

  it("issuance does not touch KV (write budget is D1's now)", async () => {
    const challenge = await getChallenge();
    expect(await env.KV.get(`nonce:${challenge}`)).toBeNull();
  });
});

describe("POST /login", () => {
  it("accepts a valid signed 22242 event and sets a session cookie", async () => {
    const challenge = await getChallenge();
    const res = await postLogin(signLoginEvent(challenge));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pubkey: string };
    expect(body.ok).toBe(true);
    expect(body.pubkey).toBe(ALICE_PK);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/sid=[0-9a-f]{64}/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // Host-only cookie: no Domain attribute.
    expect(cookie.toLowerCase()).not.toContain("domain=");

    // Session exists in KV under sess:<token> with the contract shape.
    const raw = await env.KV.get(sessionKey(sidFrom(res)));
    expect(raw).not.toBeNull();
    const sess = JSON.parse(raw!) as { pubkey: string; iat: number };
    expect(sess.pubkey).toBe(ALICE_PK);
    expect(typeof sess.iat).toBe("number");
  });

  it("rejects a forged signature", async () => {
    const challenge = await getChallenge();
    const ev = signLoginEvent(challenge);
    const forged = { ...ev, sig: flipLastChar(ev.sig) };
    const res = await postLogin(forged);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-pubkey event (signed by mallory, claiming alice)", async () => {
    const challenge = await getChallenge();
    const ev = signLoginEvent(challenge, { sk: BOB_SK });
    const impostor = { ...ev, pubkey: ALICE_PK };
    const res = await postLogin(impostor);
    expect(res.status).toBe(401);
  });

  it("rejects the wrong event kind even with a valid nonce and sig", async () => {
    const challenge = await getChallenge();
    const res = await postLogin(signLoginEvent(challenge, { kind: 1 }));
    expect(res.status).toBe(401);
  });

  it("rejects stale and future created_at (outside ±10min)", async () => {
    const c1 = await getChallenge();
    const stale = await postLogin(signLoginEvent(c1, { created_at: now() - 3600 }));
    expect(stale.status).toBe(401);
    const c2 = await getChallenge();
    const future = await postLogin(signLoginEvent(c2, { created_at: now() + 3600 }));
    expect(future.status).toBe(401);
  });

  it("accepts created_at exactly at ±600s (window is inclusive)", async () => {
    await alignToSecondStart();
    const c1 = await getChallenge();
    const past = await postLogin(signLoginEvent(c1, { created_at: now() - 600 }));
    expect(past.status).toBe(200);
    await alignToSecondStart();
    const c2 = await getChallenge();
    const future = await postLogin(signLoginEvent(c2, { created_at: now() + 600 }));
    expect(future.status).toBe(200);
  });

  it("rejects created_at at ±601s (just outside the window)", async () => {
    await alignToSecondStart();
    const c1 = await getChallenge();
    const past = await postLogin(signLoginEvent(c1, { created_at: now() - 601 }));
    expect(past.status).toBe(401);
    await alignToSecondStart();
    const c2 = await getChallenge();
    const future = await postLogin(signLoginEvent(c2, { created_at: now() + 601 }));
    expect(future.status).toBe(401);
  });

  it("rejects an event with no relay binding tag", async () => {
    const challenge = await getChallenge();
    const res = await postLogin(signLoginEvent(challenge, { relay: null }));
    expect(res.status).toBe(401);
    // Rejected before the nonce lookup — the nonce is NOT burned.
    expect(await nonceRow(challenge)).not.toBeNull();
  });

  it("rejects an event bound to another service (challenge-proxy phishing)", async () => {
    for (const relay of [
      "wss://evil.example",
      "wss://nbread.lol.evil.example",
      "https://evil.example/nbread.lol",
      "not a url at all",
    ]) {
      const challenge = await getChallenge();
      const res = await postLogin(signLoginEvent(challenge, { relay }));
      expect(res.status, `relay ${JSON.stringify(relay)}`).toBe(401);
    }
  });

  it("accepts an https:// relay binding for MAIN_HOST too", async () => {
    const challenge = await getChallenge();
    const res = await postLogin(
      signLoginEvent(challenge, { relay: "https://nbread.lol" }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects an expired nonce (expires_at lapsed)", async () => {
    const challenge = await getChallenge();
    // Tests can't wait out the real 5min expiry; backdating expires_at
    // exercises the exact `expires_at > now` guard in the consuming DELETE.
    await expireNonce(challenge);
    const res = await postLogin(signLoginEvent(challenge));
    expect(res.status).toBe(401);
  });

  it("rejects a never-issued nonce", async () => {
    const res = await postLogin(signLoginEvent("ab".repeat(32)));
    expect(res.status).toBe(401);
  });

  it("rejects a replayed nonce (second use of the same signed event)", async () => {
    const challenge = await getChallenge();
    const ev = signLoginEvent(challenge);
    const first = await postLogin(ev);
    expect(first.status).toBe(200);
    const replay = await postLogin(ev);
    expect(replay.status).toBe(401);
    expect(await nonceRow(challenge)).toBeNull();
  });

  it("is strictly single-use under CONCURRENCY: two simultaneous POSTs of the same signed event → exactly one wins", async () => {
    // The atomic `DELETE … RETURNING` is the whole point of the nonce→D1
    // move: the same captured event presented twice at once must yield
    // exactly one session, never two (the KV get→delete race allowed two).
    const challenge = await getChallenge();
    const ev = signLoginEvent(challenge);
    const [a, b] = await Promise.all([postLogin(ev), postLogin(ev)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(await nonceRow(challenge)).toBeNull();
  });

  it("burns the nonce on a FAILED attempt too (no retry against it)", async () => {
    const challenge = await getChallenge();
    const ev = signLoginEvent(challenge);
    const forged = await postLogin({ ...ev, sig: flipLastChar(ev.sig) });
    expect(forged.status).toBe(401);
    // The same nonce is now consumed — even a valid signature is refused.
    const legit = await postLogin(ev);
    expect(legit.status).toBe(401);
  });

  it("rejects malformed bodies with 400", async () => {
    expect((await postLogin("not json {{{")).status).toBe(400);
    expect((await postLogin({ not: "an event" })).status).toBe(400);
  });

  it("never adopts a client-supplied session id (fixation)", async () => {
    const attacker = "f".repeat(64);
    const challenge = await getChallenge();
    const res = await postLogin(signLoginEvent(challenge), {
      cookie: `sid=${attacker}`,
    });
    expect(res.status).toBe(200);
    // A fresh token was minted; the attacker-chosen id was neither reused
    // nor materialized in KV.
    expect(sidFrom(res)).not.toBe(attacker);
    expect(await env.KV.get(sessionKey(attacker))).toBeNull();
  });
});

describe("sessions across requests + logout", () => {
  async function login(): Promise<string> {
    const challenge = await getChallenge();
    const res = await postLogin(signLoginEvent(challenge));
    expect(res.status).toBe(200);
    return sidFrom(res);
  }

  it("the session cookie works across multiple requests", async () => {
    const sid = await login();
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch("https://nbread.lol/dashboard", {
        headers: { Cookie: `sid=${sid}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("npub1");
    }
  });

  it("anonymous / garbage cookies get redirected to /login", async () => {
    const anon = await SELF.fetch("https://nbread.lol/dashboard", {
      redirect: "manual",
    });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
    const garbage = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: "sid=definitely-not-a-token" },
      redirect: "manual",
    });
    expect(garbage.status).toBe(302);
  });

  it("logout deletes the KV session and clears the cookie", async () => {
    const sid = await login();
    const res = await SELF.fetch("https://nbread.lol/logout", {
      method: "POST",
      headers: { Cookie: `sid=${sid}` },
    });
    expect(res.status).toBe(200);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("sid=");
    expect(cleared).toContain("Max-Age=0");
    expect(await env.KV.get(sessionKey(sid))).toBeNull();
    // The invalidated token no longer authenticates.
    const after = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: `sid=${sid}` },
      redirect: "manual",
    });
    expect(after.status).toBe(302);
  });
});

describe("auth rate limits (D1 rate_limits)", () => {
  it("login: 10 per 15min per IP, 11th is 429", async () => {
    const ip = "192.0.2.11";
    for (let i = 0; i < 10; i++) {
      const res = await postLogin({ junk: i }, { ip });
      expect(res.status).toBe(400); // structurally invalid, but counted
    }
    const eleventh = await postLogin({ junk: 11 }, { ip });
    expect(eleventh.status).toBe(429);
  });

  it("challenge: 10 per 15min per IP, 11th is 429", async () => {
    const ip = "192.0.2.12";
    for (let i = 0; i < 10; i++) {
      const res = await SELF.fetch("https://nbread.lol/login/challenge", {
        headers: { "CF-Connecting-IP": ip },
      });
      expect(res.status).toBe(200);
    }
    const res = await SELF.fetch("https://nbread.lol/login/challenge", {
      headers: { "CF-Connecting-IP": ip },
    });
    expect(res.status).toBe(429);
  });

  it("challenge: global daily cap trips across IPs (nonce write budget guard)", async () => {
    // Seed the global fixed-window counter at the cap directly (500 real
    // requests would be slow); the very next challenge — from a fresh IP
    // that has never hit its own limit — must be denied.
    const windowSeconds = 86_400;
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - (nowSec % windowSeconds);
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)",
    )
      .bind(CHALLENGE_GLOBAL_KEY, CHALLENGE_GLOBAL_DAILY_CAP, windowStart)
      .run();
    const res = await SELF.fetch("https://nbread.lol/login/challenge", {
      headers: { "CF-Connecting-IP": "192.0.2.99" },
    });
    expect(res.status).toBe(429);
  });

  it("rate limits are per-IP: another IP is unaffected", async () => {
    const hot = "192.0.2.13";
    for (let i = 0; i < 11; i++) await postLogin({ junk: i }, { ip: hot });
    expect((await postLogin({ junk: 12 }, { ip: hot })).status).toBe(429);
    expect((await postLogin({ junk: 0 }, { ip: "192.0.2.14" })).status).toBe(
      400,
    );
  });
});
