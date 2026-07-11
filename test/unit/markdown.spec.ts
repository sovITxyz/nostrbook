// Markdown pipeline: snapshot corpus over every supported feature, XSS
// neutralization on the fixture payloads, and a render-CPU sanity check.
import { describe, expect, it } from "vitest";
import { renderPost, MAX_MARKDOWN_LENGTH } from "../../src/markdown";
import fixtures from "../fixtures/events.json";
import { findXssVectors } from "../helpers";

const torture = fixtures.posts.aliceTorture.content;
const xss = fixtures.posts.aliceXss.content;
const escapes = fixtures.posts.aliceEscapes.content;

describe("renderPost — feature corpus (snapshots)", () => {
  it("renders the markdown torture fixture", () => {
    expect(renderPost(torture)).toMatchSnapshot();
  });

  it("renders the escaping torture fixture", () => {
    expect(renderPost(escapes)).toMatchSnapshot();
  });

  it("renders the XSS fixture to inert output", () => {
    expect(renderPost(xss)).toMatchSnapshot();
  });
});

describe("renderPost — individual features", () => {
  it("gives headings slugified ids with a dedup counter", () => {
    const html = renderPost("# Same Title\n\n## Same Title\n\n### Same Title\n");
    expect(html).toContain('<h1 id="same-title">');
    expect(html).toContain('<h2 id="same-title-1">');
    expect(html).toContain('<h3 id="same-title-2">');
  });

  it("falls back to a generic id when the heading has no sluggable text", () => {
    const html = renderPost("# 🦩\n");
    expect(html).toContain('<h1 id="section">');
  });

  it("does not collide generated ids with explicit -N headings", () => {
    const html = renderPost("# a\n\n# a-1\n\n# a\n");
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders footnotes with internal fragment links", () => {
    const html = renderPost("Ref[^1].\n\n[^1]: The note.\n");
    expect(html).toContain('<section class="footnotes">');
    expect(html).toContain('href="#fn1"');
    expect(html).toContain('href="#fnref1"');
  });

  it("renders task lists as disabled checkboxes", () => {
    const html = renderPost("- [ ] open\n- [x] done\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    expect(findXssVectors(html)).toEqual([]);
  });

  it("renders mark / sup / sub", () => {
    const html = renderPost("==marked== and H~2~O and x^2^\n");
    expect(html).toContain("<mark>marked</mark>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
  });

  it("highlights fenced code for registered languages", () => {
    const html = renderPost("```js\nconst x = 1;\n```\n");
    expect(html).toContain('class="hljs language-js"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("escapes fenced code for unregistered languages", () => {
    const html = renderPost("```notalanguage\n<script>alert(1)</script>\n```\n");
    expect(html).not.toContain("hljs-");
    expect(html).toContain("&lt;script&gt;");
    expect(findXssVectors(html)).toEqual([]);
  });

  it("neutralizes hostile fence info strings", () => {
    const html = renderPost('```js"><img src=x onerror=alert(1)>\ncode\n```\n');
    expect(findXssVectors(html)).toEqual([]);
  });

  it("preserves table alignment styles (and nothing else)", () => {
    const html = renderPost(
      "| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n",
    );
    expect(html).toContain('style="text-align:left"');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('style="text-align:right"');
  });

  it("autolinks bare http(s) URLs but not ftp", () => {
    const html = renderPost(
      "see https://example.com/bare and ftp://example.com/file\n",
    );
    expect(html).toContain('<a href="https://example.com/bare"');
    expect(html).not.toContain('href="ftp');
  });

  it("adds rel=nofollow to external links", () => {
    const html = renderPost("[out](https://example.com)\n");
    expect(html).toContain('rel="nofollow noopener"');
  });

  it("keeps mailto and fragment links without rel", () => {
    const html = renderPost("[mail](mailto:a@b.c) and [frag](#sec)\n");
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('href="#sec"');
  });

  it("drops ftp scheme from explicit links but keeps the text", () => {
    const html = renderPost("[file](ftp://example.com/f)\n");
    expect(html).not.toContain("ftp:");
    expect(html).toContain(">file</a>");
  });

  it("keeps images with http(s) src", () => {
    const html = renderPost("![alt text](https://example.com/img.png)\n");
    expect(html).toContain('<img src="https://example.com/img.png" alt="alt text">');
  });

  it("drops images without an absolute http(s) src", () => {
    const html = renderPost("![x](/local.png) and ![y](data:image/png;base64,AAAA)\n");
    expect(html).not.toContain("<img");
  });

  it("handles non-string and oversized input safely", () => {
    expect(renderPost(undefined as unknown as string)).toBe("");
    const big = "a".repeat(MAX_MARKDOWN_LENGTH + 10_000);
    const html = renderPost(big);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("renderPost — XSS fixture neutralized", () => {
  it("produces no script/on*/dangerous-URL vectors from the XSS post", () => {
    const html = renderPost(xss);
    expect(findXssVectors(html)).toEqual([]);
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("neutralizes XSS payloads in title/summary tags when rendered as markdown", () => {
    for (const tag of fixtures.posts.aliceXss.tags) {
      const html = renderPost(tag[1] ?? "");
      expect(findXssVectors(html)).toEqual([]);
    }
  });
});

describe("renderPost — CPU sanity", () => {
  // workerd only advances clocks at I/O boundaries; flush a macrotask so
  // performance.now() reflects elapsed wall time around the CPU burn.
  async function ioNow(): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return performance.now();
  }

  it("renders the torture post well under budget (<50ms incl. CI noise; target <5ms)", async () => {
    renderPost(torture); // warm-up (lazy inits)
    const iterations = 10;
    const start = await ioNow();
    for (let i = 0; i < iterations; i++) renderPost(torture);
    const end = await ioNow();
    const perRender = (end - start) / iterations;
    expect(perRender).toBeLessThan(50);
  });

  // Adversarial inputs: these guard against super-linear render paths that a
  // benign fixture never exercises. Bounds are loose enough for CI noise but
  // far below what quadratic behavior produces at these sizes.

  it("dedupes thousands of identical heading ids in amortized O(1)", async () => {
    // 4000 identical headings took >500ms with the old restarting counter.
    const input = "# h\n\n".repeat(4000);
    renderPost("# h\n\n# h\n"); // warm-up
    const start = await ioNow();
    const html = renderPost(input);
    const end = await ioNow();
    // ~75ms measured with the amortized dedup (dominated by markdown-it
    // block parsing, which is linear); >500ms with the old O(n²) counter.
    expect(end - start).toBeLessThan(250);
    expect(html).toContain('id="h"');
    expect(html).toContain('id="h-3999"');
  });

  it("bounds hostile superlinear markdown-it input at the length cap", async () => {
    // '![', '[' and '*a' floods are markdown-it's known superlinear inputs;
    // MAX_MARKDOWN_LENGTH exists to keep them bounded. At the old 256KiB cap
    // '![' cost ~1.2s per render.
    const hostiles = [
      "![".repeat(MAX_MARKDOWN_LENGTH), // truncated to the cap
      "[".repeat(MAX_MARKDOWN_LENGTH),
      "*a".repeat(MAX_MARKDOWN_LENGTH),
    ];
    for (const input of hostiles) {
      const start = await ioNow();
      const html = renderPost(input);
      const end = await ioNow();
      expect(typeof html).toBe("string");
      expect(end - start).toBeLessThan(500);
    }
  });
});
