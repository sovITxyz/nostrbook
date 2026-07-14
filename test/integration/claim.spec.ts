// P4 handle claim: Turnstile gate (injectable verifier seam), handle regex,
// reserved list, one handle per pubkey, UNIQUE race-safety (concurrent
// duplicate claim → exactly one wins), and the 3/h/IP rate limit.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALICE_PK,
  BOB_PK,
  MALLORY_PK,
  resetRateLimits,
  resetUsers,
} from "../helpers";
import { createSession } from "../../src/services/sessions";
import { setTurnstileVerifierForTests } from "../../src/routes/dashboard";

const GOOD_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // Turnstile's documented dummy token

let ipCounter = 0;
/** Distinct IP per call so the 3/h/IP limit never bleeds between tests. */
function nextIp(): string {
  return `198.51.100.${++ipCounter}`;
}

function claim(
  sid: string,
  handle: string,
  opts: { token?: string; ip?: string } = {},
): Promise<Response> {
  return SELF.fetch("https://nbread.lol/dashboard/claim", {
    method: "POST",
    headers: {
      Cookie: `sid=${sid}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": opts.ip ?? nextIp(),
    },
    body: new URLSearchParams({
      handle,
      "cf-turnstile-response": opts.token ?? GOOD_TOKEN,
    }).toString(),
    redirect: "manual",
  });
}

async function handleOf(pubkey: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT handle FROM users WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ handle: string | null }>();
  return row?.handle ?? null;
}

beforeEach(async () => {
  await resetUsers();
  await resetRateLimits();
  // Fake verifier: accepts exactly the dummy token — like the real
  // siteverify with the official always-passing test secret, but without a
  // network round-trip in tests.
  setTurnstileVerifierForTests(async (_env, token) => token === GOOD_TOKEN);
});

afterEach(() => {
  setTurnstileVerifierForTests(null);
});

describe("GET /dashboard", () => {
  it("shows the claim form (with Turnstile) before any claim", async () => {
    const sid = await createSession(env, ALICE_PK);
    const res = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: `sid=${sid}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("npub1"); // signed-in npub
    expect(html).toContain("/dashboard/claim");
    expect(html).toContain("cf-turnstile");
    expect(html).toContain(env.TURNSTILE_SITE_KEY);
  });

  it("shows the handle (no claim form) once claimed", async () => {
    const sid = await createSession(env, ALICE_PK);
    expect((await claim(sid, "alice")).status).toBe(303);
    const res = await SELF.fetch("https://nbread.lol/dashboard", {
      headers: { Cookie: `sid=${sid}` },
    });
    const html = await res.text();
    expect(html).toContain("alice.nbread.lol");
    expect(html).toContain("alice@nbread.lol");
    expect(html).not.toContain("/dashboard/claim");
  });
});

describe("POST /dashboard/claim", () => {
  it("requires a session", async () => {
    const res = await SELF.fetch("https://nbread.lol/dashboard/claim", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "handle=nobody&cf-turnstile-response=x",
    });
    expect(res.status).toBe(401);
  });

  it("claims a valid handle and redirects to the dashboard", async () => {
    const sid = await createSession(env, ALICE_PK);
    const res = await claim(sid, "alice");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(await handleOf(ALICE_PK)).toBe("alice");
    // The blog is immediately live on its subdomain.
    const blog = await SELF.fetch("https://alice.nbread.lol/");
    expect(blog.status).toBe(200);
  });

  it("rejects a failed Turnstile verification and claims nothing", async () => {
    const sid = await createSession(env, ALICE_PK);
    const res = await claim(sid, "alice", { token: "wrong-token" });
    expect(res.status).toBe(403);
    expect(await handleOf(ALICE_PK)).toBeNull();
    const missing = await claim(sid, "alice", { token: "" });
    expect(missing.status).toBe(403);
  });

  it("rejects invalid handles (regex ^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$)", async () => {
    const sid = await createSession(env, ALICE_PK);
    const invalid = [
      "a", // too short
      "-alice", // leading hyphen
      "trailing-", // trailing hyphen (guard's DNS_LABEL would 404 the subdomain)
      "ab-", // trailing hyphen, minimum-length variant
      "Alice", // uppercase (no silent lowercasing)
      "al_ice", // underscore
      "al.ice", // dot
      "a".repeat(32), // too long
      "alice evil", // whitespace
    ];
    for (const handle of invalid) {
      const res = await claim(sid, handle);
      expect(res.status, `handle ${JSON.stringify(handle)}`).toBe(400);
    }
    expect(await handleOf(ALICE_PK)).toBeNull();
  });

  it("rejects reserved handles", async () => {
    const sid = await createSession(env, ALICE_PK);
    for (const handle of ["admin", "www", "api"]) {
      const res = await claim(sid, handle);
      expect(res.status, `handle ${handle}`).toBe(400);
    }
    expect(await handleOf(ALICE_PK)).toBeNull();
  });

  it("rejects a second handle for the same pubkey", async () => {
    const sid = await createSession(env, ALICE_PK);
    expect((await claim(sid, "alice")).status).toBe(303);
    expect((await claim(sid, "alice2")).status).toBe(409);
    expect((await claim(sid, "alice")).status).toBe(409); // even the same one
    expect(await handleOf(ALICE_PK)).toBe("alice");
  });

  it("rejects a handle already claimed by another pubkey", async () => {
    const aliceSid = await createSession(env, ALICE_PK);
    const bobSid = await createSession(env, BOB_PK);
    expect((await claim(aliceSid, "shared")).status).toBe(303);
    expect((await claim(bobSid, "shared")).status).toBe(409);
    expect(await handleOf(BOB_PK)).toBeNull();
  });

  it("concurrent duplicate claim: exactly one wins (UNIQUE race)", async () => {
    const [aliceSid, bobSid] = await Promise.all([
      createSession(env, ALICE_PK),
      createSession(env, BOB_PK),
    ]);
    const [r1, r2] = await Promise.all([
      claim(aliceSid, "racer"),
      claim(bobSid, "racer"),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 409]);
    const rows = await env.DB.prepare(
      "SELECT pubkey FROM users WHERE handle = 'racer'",
    ).all<{ pubkey: string }>();
    expect(rows.results.length).toBe(1);
  });

  it("blocks blocked users from claiming", async () => {
    await env.DB.prepare(
      "INSERT INTO users (pubkey, handle, claimed_at, blocked) VALUES (?, NULL, ?, 1)",
    )
      .bind(MALLORY_PK, new Date().toISOString())
      .run();
    const sid = await createSession(env, MALLORY_PK);
    const res = await claim(sid, "innocent");
    expect(res.status).toBe(403);
    expect(await handleOf(MALLORY_PK)).toBeNull();
  });

  it("rate limits claims to 3/h/IP (denied attempts count)", async () => {
    const sid = await createSession(env, ALICE_PK);
    const ip = "198.51.100.200";
    for (let i = 0; i < 3; i++) {
      // Invalid handles — still consume the budget (abuse-cap semantics).
      const res = await claim(sid, "NOPE", { ip });
      expect(res.status).toBe(400);
    }
    const fourth = await claim(sid, "legit-handle", { ip });
    expect(fourth.status).toBe(429);
    // A different IP is unaffected.
    const other = await claim(sid, "legit-handle", { ip: "198.51.100.201" });
    expect(other.status).toBe(303);
  });
});
