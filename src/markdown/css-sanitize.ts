/**
 * Sanitizer for per-blog theme CSS (user-supplied, rendered into a <style>
 * tag on every blog page).
 *
 * Threat model: the CSS author is the blog owner (semi-trusted) but the
 * value round-trips through relays/D1, so we treat it as hostile:
 *
 *   - `</style>` breakout → all `<` characters are removed (CSS needs none);
 *   - exfiltration / remote fetch → `@import`, `url(...)` removed;
 *   - legacy script vectors → `expression(...)`, `behavior:`, `-moz-binding`,
 *     `javascript:` removed;
 *   - obfuscation → backslash escapes removed first (`\75rl(` → `url(`),
 *     comments stripped (replaced by a space so they cannot join tokens),
 *     removals looped to a fixpoint (`@@importimport` cannot reassemble),
 *     with a pass cap that fails closed on crafted depth bombs;
 *   - control characters stripped (tab/newline kept for readability);
 *   - length capped BEFORE any other step.
 */

/** Hard cap on stored/rendered theme CSS, in UTF-16 code units. */
export const MAX_THEME_CSS_LENGTH = 20_000;

// C0 controls except \t (0x09) and \n (0x0a), plus DEL. \r is normalized
// separately before this runs.
// eslint-disable-next-line no-control-regex
const CSS_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const DANGEROUS_PATTERNS: RegExp[] = [
  /@import/gi,
  /@charset/gi,
  /@namespace/gi,
  /url\s*\(/gi,
  /image-set\s*\(/gi,
  /expression\s*\(/gi,
  /-moz-binding/gi,
  /behavior\s*:/gi,
  /javascript\s*:/gi,
];

/**
 * Fixpoint iteration cap. Every changing pass strictly shrinks the string,
 * so without a cap an adversarially nested 20KB theme ("@impor…@import…t"
 * repeated) forces O(depth) full-string passes — ~80ms of CPU per page
 * render (the layout re-sanitizes on every request). Real CSS converges in
 * 1 pass and fixture-grade reassembly tricks in 2-3; anything still
 * changing after this many passes is a crafted depth bomb and is dropped
 * wholesale (fail closed — never emit a partially sanitized string).
 */
const MAX_SANITIZE_PASSES = 10;

/**
 * Returns theme CSS that is safe to inline inside a `<style>` element.
 * Output contains no `<`, no imports/URL fetches, and no legacy script hooks.
 */
export function sanitizeCss(css: string): string {
  let s = String(css ?? "");

  // 1. Length cap first so later passes work on bounded input.
  s = s.slice(0, MAX_THEME_CSS_LENGTH);

  // 2. Normalize newlines, then strip control chars (keep \t and \n).
  s = s.replace(/\r\n?/g, "\n").replace(CSS_CONTROL_RE, "");

  // 3. Kill backslash escapes BEFORE pattern matching (\75rl( === url().
  s = s.replace(/\\/g, "");

  // 4. Strip comments (replace with a space: in real CSS a comment is a
  //    token separator, so removal must not join adjacent tokens). Also drop
  //    an unterminated trailing comment.
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\*[\s\S]*$/, "");

  // 5. No markup breakout: CSS has no legitimate use for `<`.
  s = s.replace(/</g, "");

  // 6. Remove dangerous constructs, looping to a fixpoint so removals can
  //    never splice a new dangerous token together. Iterations are capped
  //    (see MAX_SANITIZE_PASSES); input that has not converged by then is
  //    a crafted depth bomb and is rejected outright.
  let converged = false;
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass++) {
    const prev = s;
    for (const re of DANGEROUS_PATTERNS) {
      s = s.replace(re, "");
    }
    if (s === prev) {
      converged = true;
      break;
    }
  }
  if (!converged) return "";

  return s.trim();
}
