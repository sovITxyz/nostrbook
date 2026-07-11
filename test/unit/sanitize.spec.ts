// Direct adversarial tests for the HTML output sanitizer (defense-in-depth
// layer behind markdown-it's html:false). The inputs here are raw hostile
// HTML — worse than anything markdown-it can emit.
import { describe, expect, it } from "vitest";
import {
  sanitizeHtml,
  safeHttpUrl,
  safeHref,
  escapeHtml,
} from "../../src/markdown/sanitize";
import { findXssVectors } from "../helpers";

const HOSTILE_PAYLOADS: string[] = [
  `<script>alert(1)</script>`,
  `<SCRIPT SRC=https://evil.example/x.js></SCRIPT>`,
  `<script\n>alert(1)</script\n>`,
  `<img src=x onerror=alert(1)>`,
  `<img src="javascript:alert(1)">`,
  `<img src="https://ok.example/x.png" onload="alert(1)">`,
  `<svg onload=alert(1)>`,
  `<svg/onload=alert(1)>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<object data="x"></object>`,
  `<embed src="x">`,
  `<form action="https://evil.example"><input type="submit"></form>`,
  `<style>body{background:url(https://evil.example/x)}</style>`,
  `<a href="javascript:alert(1)">click</a>`,
  `<a href="JaVaScRiPt:alert(1)">click</a>`,
  `<a href="java\tscript:alert(1)">click</a>`,
  `<a href="java&#x73;cript:alert(1)">click</a>`,
  `<a href="&#106;avascript:alert(1)">click</a>`,
  `<a href="jav&colon;ascript:alert(1)">click</a>`,
  `<a href="vbscript:msgbox(1)">click</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">click</a>`,
  `<a href="#" onclick="alert(1)">click</a>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<td style="behavior:url(evil.htc)">x</td>`,
  `<math><mtext><script>alert(1)</script></mtext></math>`,
  `<base href="https://evil.example/">`,
  `<link rel="stylesheet" href="https://evil.example/x.css">`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<input onfocus=alert(1) autofocus>`,
  `<details open ontoggle=alert(1)>`,
  `<video><source onerror=alert(1)></video>`,
  `<a href='javascript:alert(1)'>single-quoted</a>`,
  `<a href=javascript:alert(1)>unquoted</a>`,
  `<img src=x onerror=`, // unterminated tag
  `<p onclick="alert(1)" ONMOUSEOVER="alert(2)">text</p>`,
  `<a xlink:href="javascript:alert(1)">x</a>`,
  `<!--<script>alert(1)</script>-->`,
  `<![CDATA[<script>alert(1)</script>]]>`,
];

describe("sanitizeHtml — hostile payload corpus", () => {
  for (const payload of HOSTILE_PAYLOADS) {
    it(`neutralizes: ${payload.slice(0, 60)}`, () => {
      const out = sanitizeHtml(payload);
      expect(findXssVectors(out)).toEqual([]);
      expect(out.toLowerCase()).not.toContain("<script");
    });
  }
});

describe("sanitizeHtml — allowlist behavior", () => {
  it("keeps allowlisted markup unchanged in essence", () => {
    const input =
      '<p>hi <strong>there</strong> <em>you</em></p>\n<h2 id="x">t</h2>';
    const out = sanitizeHtml(input);
    expect(out).toContain("<p>");
    expect(out).toContain("<strong>there</strong>");
    expect(out).toContain('<h2 id="x">');
  });

  it("keeps img with http(s) src and drops the rest of the attributes", () => {
    const out = sanitizeHtml(
      '<img src="https://a.example/i.png" alt="ok" onerror="x" data-x="y">',
    );
    expect(out).toBe('<img src="https://a.example/i.png" alt="ok">');
  });

  it("drops img entirely when src is not absolute http(s)", () => {
    expect(sanitizeHtml('<img src="/rel.png">')).toBe("");
    expect(sanitizeHtml('<img alt="no src">')).toBe("");
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toBe("");
  });

  it("normalizes uppercase tags and attributes", () => {
    const out = sanitizeHtml('<A HREF="https://x.example">t</A>');
    expect(out).toContain('<a href="https://x.example"');
    expect(out).toContain("</a>");
  });

  it("keeps the first duplicate attribute only", () => {
    const out = sanitizeHtml(
      '<a href="https://good.example" href="javascript:alert(1)">t</a>',
    );
    expect(out).toContain('href="https://good.example"');
    expect(out).not.toContain("javascript:");
  });

  it("forces rel=nofollow noopener on external links", () => {
    const out = sanitizeHtml(
      '<a href="https://x.example" rel="opener">t</a>',
    );
    expect(out).toContain('rel="nofollow noopener"');
  });

  it("escapes unknown tags instead of dropping their text", () => {
    const out = sanitizeHtml("<blink>hello</blink>");
    expect(out).toContain("hello");
    expect(out).not.toContain("<blink>");
  });

  it("drops disallowed style values but keeps table alignment", () => {
    expect(sanitizeHtml('<td style="text-align:center">x</td>')).toContain(
      'style="text-align:center"',
    );
    expect(
      sanitizeHtml('<td style="background:url(https://e/x)">x</td>'),
    ).toBe("<td>x</td>");
  });

  it("drops inputs that are not checkboxes", () => {
    expect(sanitizeHtml('<input type="text" value="x">')).toBe("");
    expect(
      sanitizeHtml('<input type="checkbox" checked="" disabled="">'),
    ).toContain('type="checkbox"');
  });

  it("escapes stray < characters", () => {
    expect(sanitizeHtml("a < b and 1 <2")).toBe("a &lt; b and 1 &lt;2");
  });

  it("is idempotent on its own output", () => {
    const once = sanitizeHtml(
      '<p>x</p><a href="https://x.example" title="a&quot;b">t</a>',
    );
    expect(sanitizeHtml(once)).toBe(once);
  });
});

describe("URL validators", () => {
  it("safeHttpUrl accepts only absolute http(s)", () => {
    expect(safeHttpUrl("https://a.example/x.png")).toBe(
      "https://a.example/x.png",
    );
    expect(safeHttpUrl("http://a.example/")).toBe("http://a.example/");
    expect(safeHttpUrl("HTTPS://A.example/")).toBe("HTTPS://A.example/");
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("https://")).toBeNull();
  });

  it("safeHref accepts http(s)/mailto/relative and rejects everything else", () => {
    expect(safeHref("https://a.example")).toBe("https://a.example");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("#fragment")).toBe("#fragment");
    expect(safeHref("/path?q=1")).toBe("/path?q=1");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("ftp://x")).toBeNull();
  });

  it("safeHref defeats obfuscation (entities, control chars, mixed case)", () => {
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java&#x73;cript:alert(1)")).toBeNull();
    expect(safeHref("&#106;avascript:alert(1)")).toBeNull();
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
    expect(safeHref("javascript&colon;alert(1)")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("escapeHtml escapes the five metacharacters", () => {
    expect(escapeHtml(`<a href="x" & 'y'>`)).toBe(
      "&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;",
    );
  });
});
