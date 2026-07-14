// Tenant + guard middleware unit tests — all 4 host classes:
//   1. nbread.lol            → main site
//   2. alice.nbread.lol      → blog site (claimed handle)
//   3. unknown.nbread.lol    → 404 (unclaimed handle)
//   4. nbread.lol.evil.com   → 404 (spoofed host class)
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { guard, normalizeHostname } from "../../src/middleware/guard";
import { tenant } from "../../src/middleware/tenant";
import type { AppEnv } from "../../src/types";
import { seedAlice, seedBlockedMallory, ALICE_PK } from "../helpers";

/** Probe app: guard + tenant, then echo the resolved site as JSON. */
function probeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", guard);
  app.use("*", tenant);
  app.get("*", (c) => c.json(c.var.site));
  return app;
}

function req(host: string, path = "/") {
  return new Request(`https://${host}${path}`, {
    headers: { host },
  });
}

describe("guard + tenant middleware host classes", () => {
  beforeAll(async () => {
    await seedAlice();
    await seedBlockedMallory();
  });

  it("1. apex (nbread.lol) resolves to the main site", async () => {
    const res = await probeApp().request(req("nbread.lol"), undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "main" });
  });

  it("2. claimed subdomain (alice.nbread.lol) resolves to the blog site", async () => {
    const res = await probeApp().request(
      req("alice.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const site = (await res.json()) as {
      type: string;
      pubkey: string;
      user: { handle: string };
    };
    expect(site.type).toBe("blog");
    expect(site.pubkey).toBe(ALICE_PK);
    expect(site.user.handle).toBe("alice");
  });

  it("3. unclaimed subdomain (unknown.nbread.lol) is a 404", async () => {
    const res = await probeApp().request(
      req("unknown.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("4. spoofed host class (nbread.lol.evil.com) is a 404", async () => {
    const res = await probeApp().request(
      req("nbread.lol.evil.com"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects deep subdomains (a.b.nbread.lol)", async () => {
    const res = await probeApp().request(
      req("a.b.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects unrelated hosts (example.com)", async () => {
    const res = await probeApp().request(req("example.com"), undefined, env);
    expect(res.status).toBe(404);
  });

  it("blocked users are 404 on their subdomain", async () => {
    const res = await probeApp().request(
      req("blocked.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("host matching is case-insensitive and ignores ports", async () => {
    const res = await probeApp().request(
      req("ALICE.NbRead.LOL:8443"),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const site = (await res.json()) as { type: string };
    expect(site.type).toBe("blog");
  });

  it("X-Forwarded-Host override works in development (wrangler dev aid)", async () => {
    // ENVIRONMENT is "development" in tests via the miniflare bindings
    // override in vitest.config.ts (wrangler.jsonc ships "production").
    const r = new Request("http://localhost:8787/", {
      headers: {
        host: "localhost:8787",
        "x-forwarded-host": "alice.nbread.lol",
      },
    });
    const res = await probeApp().request(r, undefined, env);
    expect(res.status).toBe(200);
    const site = (await res.json()) as { type: string };
    expect(site.type).toBe("blog");
  });

  it("X-Forwarded-Host is IGNORED outside development", async () => {
    // Simulate the deployed config (wrangler.jsonc ships ENVIRONMENT=production).
    const prodEnv = { ...env, ENVIRONMENT: "production" };
    const r = new Request("https://nbread.lol/", {
      headers: {
        host: "nbread.lol",
        "x-forwarded-host": "alice.nbread.lol",
      },
    });
    const res = await probeApp().request(r, undefined, prodEnv);
    expect(res.status).toBe(200);
    // Must resolve from the real Host header (main), not the spoofed one.
    expect(await res.json()).toEqual({ type: "main" });
  });
});

/** Guard-only probe: isolates guard 404s from tenant (D1 lookup) 404s. */
function guardApp() {
  const app = new Hono<AppEnv>();
  app.use("*", guard);
  app.get("*", (c) => c.text(c.var.host));
  return app;
}

describe("guard hostname hardening", () => {
  it("treats bracketed IPv6 loopback ([::1]:8787) as the apex", async () => {
    const r = new Request("http://127.0.0.1:8787/", {
      headers: { host: "[::1]:8787" },
    });
    const res = await guardApp().request(r, undefined, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("nbread.lol");
  });

  it("accepts a maximal 63-char DNS label", async () => {
    const label = "a".repeat(63);
    const res = await guardApp().request(
      req(`${label}.nbread.lol`),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${label}.nbread.lol`);
  });

  it("rejects labels longer than 63 chars", async () => {
    const res = await guardApp().request(
      req(`${"a".repeat(64)}.nbread.lol`),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects hostnames longer than 253 chars", async () => {
    // 4 × 62-char labels + suffix ≈ 266 chars, each label individually valid.
    const long = Array(4).fill("a".repeat(62)).join(".") + ".nbread.lol";
    const res = await guardApp().request(req(long), undefined, env);
    expect(res.status).toBe(404);
  });

  it("rejects labels containing underscores", async () => {
    const res = await guardApp().request(
      req("a_b.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects labels with leading or trailing hyphens", async () => {
    for (const host of ["-alice.nbread.lol", "alice-.nbread.lol"]) {
      const res = await guardApp().request(req(host), undefined, env);
      expect(res.status, host).toBe(404);
    }
  });

  it("accepts interior hyphens (alice-blog)", async () => {
    const res = await guardApp().request(
      req("alice-blog.nbread.lol"),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
  });

  it("rejects hosts containing whitespace", async () => {
    // Space must ride in the Host header only — a URL with a space in the
    // host would throw in the Request constructor itself.
    const r = new Request("https://nbread.lol/", {
      headers: { host: "ali ce.nbread.lol" },
    });
    const res = await guardApp().request(r, undefined, env);
    expect(res.status).toBe(404);
  });
});

describe("normalizeHostname (direct — bytes Headers cannot carry)", () => {
  it("strips ports and lowercases", () => {
    expect(normalizeHostname("ALICE.NbRead.LOL:8443")).toBe(
      "alice.nbread.lol",
    );
  });

  it("parses bracketed IPv6 with a port", () => {
    expect(normalizeHostname("[::1]:8787")).toBe("[::1]");
  });

  it("returns null for NUL bytes", () => {
    expect(normalizeHostname("ali\u0000ce.nbread.lol")).toBeNull();
  });

  it("returns null for spaces", () => {
    expect(normalizeHostname("ali ce.nbread.lol")).toBeNull();
  });

  it("returns null for empty or oversized hostnames", () => {
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("a".repeat(300) + ".nbread.lol")).toBeNull();
  });
});
