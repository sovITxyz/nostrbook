// Theme-CSS sanitizer: breakouts, exfiltration vectors, obfuscation, cap.
import { describe, expect, it } from "vitest";
import {
  sanitizeCss,
  MAX_THEME_CSS_LENGTH,
} from "../../src/markdown/css-sanitize";

describe("sanitizeCss", () => {
  it("keeps ordinary theme CSS", () => {
    const css = ".post { text-align: center; color: #345; }\nh1 { font-size: 2rem; }";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("strips @import in any case", () => {
    const out = sanitizeCss("@import url('https://evil.example/x.css'); body{}" );
    expect(out.toLowerCase()).not.toContain("@import");
    expect(out.toLowerCase()).not.toContain("url(");
  });

  it("strips @charset and @namespace", () => {
    const out = sanitizeCss('@charset "UTF-8"; @namespace svg url(http://x);');
    expect(out.toLowerCase()).not.toContain("@charset");
    expect(out.toLowerCase()).not.toContain("@namespace");
  });

  it("strips url( with whitespace and case tricks", () => {
    for (const input of [
      "background: url(https://evil/x)",
      "background: URL (https://evil/x)",
      "background: uRl\t(https://evil/x)",
    ]) {
      expect(sanitizeCss(input).toLowerCase()).not.toMatch(/url\s*\(/);
    }
  });

  it("strips expression(), behavior: and -moz-binding", () => {
    const out = sanitizeCss(
      "width: expression(alert(1)); behavior: x; -moz-binding: y;",
    );
    expect(out.toLowerCase()).not.toContain("expression(");
    expect(out.toLowerCase()).not.toContain("behavior:");
    expect(out.toLowerCase()).not.toContain("-moz-binding");
  });

  it("prevents </style> breakout (no < survives at all)", () => {
    const out = sanitizeCss("body{} </style><script>alert(1)</script>");
    expect(out).not.toContain("<");
  });

  it("strips control characters but keeps tabs and newlines", () => {
    const out = sanitizeCss("body {\n\tcolor: red;\u0000\u0007\u001f }");
    expect(out).toBe("body {\n\tcolor: red; }");
  });

  it("normalizes CRLF to LF", () => {
    expect(sanitizeCss("a{}\r\nb{}")).toBe("a{}\nb{}");
  });

  it("defeats backslash-escape obfuscation", () => {
    // \75 is the CSS escape for "u"; removing backslashes must not rebuild url(
    expect(sanitizeCss("background: \\75rl(https://evil/x)")).not.toMatch(
      /url\s*\(/i,
    );
    expect(sanitizeCss("@im\\port url(x)")).not.toMatch(/@import/i);
  });

  it("defeats comment obfuscation without joining tokens", () => {
    const out = sanitizeCss("@im/**/port url(https://evil/x);");
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/url\s*\(/i);
  });

  it("drops unterminated trailing comments", () => {
    expect(sanitizeCss("body{} /* trailing @import url(x)")).toBe("body{}");
  });

  it("removes recombining patterns to a fixpoint", () => {
    expect(sanitizeCss("@@importimport")).not.toMatch(/@import/i);
    expect(sanitizeCss("uurl(rl(x")).not.toMatch(/url\s*\(/i);
    // url( removal splicing "@im…port" back together must still die:
    expect(sanitizeCss("@imurl(port url(x)")).not.toMatch(/@import/i);
  });

  it("strips javascript: anywhere", () => {
    expect(sanitizeCss("list-style: javascript:alert(1)")).not.toMatch(
      /javascript\s*:/i,
    );
  });

  it("caps the length before anything else", () => {
    const big = "a".repeat(MAX_THEME_CSS_LENGTH + 5_000);
    expect(sanitizeCss(big).length).toBeLessThanOrEqual(MAX_THEME_CSS_LENGTH);
    // a dangerous token straddling the cap boundary must not survive
    const straddle = "x".repeat(MAX_THEME_CSS_LENGTH - 3) + "@import url(https://evil/x)";
    expect(sanitizeCss(straddle)).not.toMatch(/@import|url\s*\(/i);
  });

  it("handles non-string input", () => {
    expect(sanitizeCss(null as unknown as string)).toBe("");
    expect(sanitizeCss(undefined as unknown as string)).toBe("");
  });

  it("resolves shallow nested reassembly within the pass cap", () => {
    // Depth 3: each fixpoint pass peels one layer; converges well inside
    // the cap and keeps the surrounding legit CSS.
    let bomb = "@import";
    for (let i = 0; i < 2; i++) bomb = `@impor${bomb}t`;
    const out = sanitizeCss(`body{color:red} ${bomb}`);
    expect(out).not.toMatch(/@import/i);
    expect(out).toContain("body{color:red}");
  });

  it("fails closed (empty output) on a crafted fixpoint depth bomb, quickly", async () => {
    // Each nesting level needs one full-string pass to peel; without the
    // iteration cap a 20KB bomb costs O(depth) passes (~80ms per render).
    // workerd only advances clocks at I/O boundaries — flush a macrotask
    // around the burn so performance.now() reflects wall time.
    const ioNow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return performance.now();
    };
    let bomb = "@import";
    while (bomb.length + 7 <= MAX_THEME_CSS_LENGTH) bomb = `@impor${bomb}t`;
    const start = await ioNow();
    const out = sanitizeCss(bomb);
    const elapsed = (await ioNow()) - start;
    expect(out).toBe("");
    expect(elapsed).toBeLessThan(50);
  });
});
