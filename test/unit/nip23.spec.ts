// NIP-23 metadata mapping: tags → {slug,title,summary,published_at,image}
// with fallbacks. Edge cases derive from committed fixtures (no key material
// is ever generated here — mapping needs no signatures).
import { describe, expect, it } from "vitest";
import {
  postMeta,
  firstTagValue,
  isoDate,
  isoDateTime,
} from "../../src/markdown/nip23";
import type { NostrEvent } from "../../src/nostr/event";
import fixtures from "../fixtures/events.json";

const hello = fixtures.posts.aliceHello as NostrEvent;
const xssPost = fixtures.posts.aliceXss as NostrEvent;

/** Fixture-derived event with overridden tags/content (metadata-only tests). */
function variant(overrides: Partial<NostrEvent>): NostrEvent {
  return { ...hello, ...overrides };
}

describe("postMeta", () => {
  it("maps the standard NIP-23 tags", () => {
    const meta = postMeta(hello);
    expect(meta).toEqual({
      slug: "hello-world",
      title: "Hello world",
      summary: "Alice's first Nostrbook test post",
      published_at: 1700000100,
      image: null,
    });
  });

  it("falls back to the first markdown heading when the title tag is missing", () => {
    const meta = postMeta(variant({ tags: [["d", "x"]] }));
    expect(meta.title).toBe("Hello world"); // from "# Hello world"
  });

  it("strips inline markers and ATX closers from heading-derived titles", () => {
    const meta = postMeta(
      variant({ tags: [["d", "x"]], content: "## My **bold** `code` title ##\n\nbody" }),
    );
    expect(meta.title).toBe("My bold code title");
  });

  it("falls back to 'Untitled' when there is no title tag and no heading", () => {
    const meta = postMeta(
      variant({ tags: [["d", "x"]], content: "just a paragraph" }),
    );
    expect(meta.title).toBe("Untitled");
  });

  it("treats an empty/whitespace title tag as missing", () => {
    const meta = postMeta(
      variant({ tags: [["d", "x"], ["title", "   "]], content: "plain" }),
    );
    expect(meta.title).toBe("Untitled");
  });

  it("uses created_at when published_at is missing or invalid", () => {
    for (const bad of [
      [["d", "x"]],
      [["d", "x"], ["published_at", "yesterday"]],
      [["d", "x"], ["published_at", "-5"]],
      [["d", "x"], ["published_at", "0"]],
      [["d", "x"], ["published_at", "1e9"]],
    ] as string[][][]) {
      const meta = postMeta(variant({ tags: bad }));
      expect(meta.published_at).toBe(hello.created_at);
    }
  });

  it("keeps a valid published_at tag", () => {
    const meta = postMeta(
      variant({ tags: [["d", "x"], ["published_at", "1700000042"]] }),
    );
    expect(meta.published_at).toBe(1700000042);
  });

  it("keeps only http(s) image URLs", () => {
    const withImage = (url: string) =>
      postMeta(variant({ tags: [["d", "x"], ["image", url]] })).image;
    expect(withImage("https://example.com/i.png")).toBe(
      "https://example.com/i.png",
    );
    expect(withImage("javascript:alert(1)")).toBeNull();
    expect(withImage("data:image/png;base64,AAAA")).toBeNull();
    expect(withImage("/relative.png")).toBeNull();
  });

  it("returns an empty slug and null summary when tags are absent", () => {
    const meta = postMeta(variant({ tags: [] }));
    expect(meta.slug).toBe("");
    expect(meta.summary).toBeNull();
  });

  it("passes hostile title/summary through untouched (escaping is the view's job)", () => {
    const meta = postMeta(xssPost);
    expect(meta.title).toContain("<script>");
    expect(meta.summary).toContain("onerror=");
  });

  it("caps runaway title and summary lengths", () => {
    const meta = postMeta(
      variant({
        tags: [
          ["d", "x"],
          ["title", "t".repeat(10_000)],
          ["summary", "s".repeat(10_000)],
        ],
      }),
    );
    expect(meta.title.length).toBeLessThanOrEqual(200);
    expect((meta.summary ?? "").length).toBeLessThanOrEqual(500);
  });
});

describe("tag and date helpers", () => {
  it("firstTagValue returns the first matching tag value", () => {
    expect(firstTagValue(hello, "d")).toBe("hello-world");
    expect(firstTagValue(hello, "nope")).toBeNull();
    expect(
      firstTagValue(variant({ tags: [["t"], ["t", "a"], ["t", "b"]] }), "t"),
    ).toBe("a");
  });

  it("isoDate / isoDateTime format unix seconds", () => {
    expect(isoDate(1700000100)).toBe("2023-11-14");
    expect(isoDateTime(1700000100)).toBe("2023-11-14T22:15:00.000Z");
  });

  it("isoDate / isoDateTime fall back to the epoch for unrepresentable timestamps", () => {
    // Feed/sitemap consumers require a valid RFC 3339 / W3C datetime, so an
    // out-of-range Date must yield the epoch sentinel, never "".
    expect(isoDate(Number.MAX_SAFE_INTEGER)).toBe("1970-01-01");
    expect(isoDateTime(Number.MAX_SAFE_INTEGER)).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });
});
