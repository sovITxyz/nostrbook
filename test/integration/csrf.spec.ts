// P4 CSRF: Origin / Sec-Fetch-Site same-origin enforcement for unsafe
// methods on the main site (JSON APIs included), applied before the auth
// routes. Cross-origin POSTs must die with 403 BEFORE touching rate limits,
// nonces, or sessions.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ALICE_PK, resetRateLimits } from "../helpers";
import { createSession } from "../../src/services/sessions";

function post(
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`https://nbread.lol${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
      ...headers,
    },
    body: "{}",
  });
}

beforeEach(async () => {
  await resetRateLimits();
});

describe("csrf middleware (main site)", () => {
  it("rejects a cross-origin POST via Origin", async () => {
    const res = await post("/login", { Origin: "https://evil.com" });
    expect(res.status).toBe(403);
  });

  it("rejects the literal null Origin (sandboxed iframe)", async () => {
    const res = await post("/login", { Origin: "null" });
    expect(res.status).toBe(403);
  });

  it("rejects a subdomain Origin (tenant content must not drive the apex)", async () => {
    const res = await post("/login", { Origin: "https://alice.nbread.lol" });
    expect(res.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: cross-site and same-site", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await post("/login", { "Sec-Fetch-Site": site });
      expect(res.status, `sec-fetch-site ${site}`).toBe(403);
    }
  });

  it("accepts a same-origin POST (Origin + Sec-Fetch-Site)", async () => {
    // Passes CSRF, then fails JSON-body validation → 400, NOT 403.
    const res = await post("/login", {
      Origin: "https://nbread.lol",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(res.status).toBe(400);
  });

  it("accepts header-less POSTs (non-browser clients)", async () => {
    const res = await post("/login");
    expect(res.status).toBe(400); // reaches the handler
  });

  it("does not gate safe methods", async () => {
    const res = await SELF.fetch("https://nbread.lol/login", {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(200); // GET renders regardless of Origin
  });

  it("shields state-changing routes even with a valid session", async () => {
    const sid = await createSession(env, ALICE_PK);
    const forged = await SELF.fetch(
      "https://nbread.lol/dashboard/claim",
      {
        method: "POST",
        headers: {
          Cookie: `sid=${sid}`,
          Origin: "https://evil.com",
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": "203.0.113.8",
        },
        body: "handle=hijacked&cf-turnstile-response=x",
      },
    );
    expect(forged.status).toBe(403);
    const row = await env.DB.prepare(
      "SELECT handle FROM users WHERE pubkey = ?",
    )
      .bind(ALICE_PK)
      .first<{ handle: string | null }>();
    expect(row?.handle ?? null).toBeNull();

    // Logout is protected too (logout CSRF).
    const logout = await post("/logout", {
      Origin: "https://evil.com",
      Cookie: `sid=${sid}`,
    });
    expect(logout.status).toBe(403);
  });

  it("covers the JSON API as well", async () => {
    const res = await post("/api/mirror", { Origin: "https://evil.com" });
    expect(res.status).toBe(403); // CSRF beats even the session check
  });
});
