// End-to-end worker integration tests via SELF.fetch with Host overrides
// (the four contracted host classes) — exercises src/index.ts through the
// full guard → tenant → dispatch pipeline.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedAlice } from "../helpers";

describe("worker end-to-end (SELF.fetch)", () => {
  beforeAll(async () => {
    await seedAlice();
  });

  it("serves the main site on https://nbread.lol/", async () => {
    const res = await SELF.fetch("https://nbread.lol/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("nbread.lol");
    expect(html).toContain("<html");
  });

  it("serves a healthz endpoint on the apex", async () => {
    const res = await SELF.fetch("https://nbread.lol/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("nbread");
  });

  it("serves a distinct blog page on https://alice.nbread.lol/", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("@alice");
    // Distinct from the apex response:
    expect(html).not.toContain("Nostr-native blogging");
  });

  it("404s an unclaimed subdomain https://unknown.nbread.lol/", async () => {
    const res = await SELF.fetch("https://unknown.nbread.lol/");
    expect(res.status).toBe(404);
  });

  it("404s a spoofed host https://nbread.lol.evil.com/", async () => {
    const res = await SELF.fetch("https://nbread.lol.evil.com/");
    expect(res.status).toBe(404);
  });

  it("the mirror API exists on the apex and gates on the session (401 anon)", async () => {
    const mirror = await SELF.fetch("https://nbread.lol/api/mirror", {
      method: "POST",
    });
    expect(mirror.status).toBe(401); // P5: session required, not a 404/501 stub
  });

  it("apex auth/dashboard routes are not exposed on blog subdomains", async () => {
    // On a blog subdomain these fall through to the tenant slug route and
    // 404 (no such post) — the apex login/dashboard pages must not render.
    const login = await SELF.fetch("https://alice.nbread.lol/login");
    expect(login.status).toBe(404);
    const dashboard = await SELF.fetch("https://alice.nbread.lol/dashboard");
    expect(dashboard.status).toBe(404);
  });
});
