// Static info pages (/privacy /terms /docs) + the apex HTML 404 — end-to-end
// via SELF.fetch. The pages are pure JSX (no D1/KV access), so the assertions
// cover markup, the shared cache header, and the zero-JavaScript contract.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const INFO_PAGES = [
  { path: "/privacy", needle: "Privacy Policy" },
  { path: "/terms", needle: "Terms of Service" },
  { path: "/docs", needle: "NIP-07" },
] as const;

describe("info pages (/privacy /terms /docs)", () => {
  for (const { path, needle } of INFO_PAGES) {
    it(`${path} serves cacheable static HTML with the shared chrome`, async () => {
      const res = await SELF.fetch(`https://nbread.lol${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      const html = await res.text();
      expect(html).toContain(needle);
      expect(html).toContain("Last updated");
      // Shared chrome: the footer credit renders on every info page.
      expect(html).toContain("site-footer");
      // Static pages ship zero JavaScript (apex CSP aside, there is simply
      // no script to ship).
      expect(html.toLowerCase()).not.toContain("<script");
    });
  }

  it("every info page links the AGPL source repo", async () => {
    for (const { path } of INFO_PAGES) {
      const res = await SELF.fetch(`https://nbread.lol${path}`);
      const html = await res.text();
      expect(html, path).toContain("github.com/sovITxyz/nbread");
    }
    // The license itself is named where it matters.
    const privacy = await SELF.fetch("https://nbread.lol/privacy");
    expect(await privacy.text()).toContain("AGPL");
    const docs = await SELF.fetch("https://nbread.lol/docs");
    expect(await docs.text()).toContain("AGPL");
  });
});

describe("apex 404", () => {
  it("an unknown apex path renders the HTML 404 page", async () => {
    const res = await SELF.fetch(
      "https://nbread.lol/definitely-not-a-page",
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("404");
    // Friendly exits back into the site.
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/discover"');
  });

  it("an unknown /api path stays a plain-text 404 (no markup)", async () => {
    const res = await SELF.fetch(
      "https://nbread.lol/api/definitely-not-a-page",
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("text/html");
    expect(await res.text()).not.toContain("<html");
  });
});
