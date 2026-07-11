/**
 * Strict HTML output allowlist pass applied AFTER markdown rendering.
 *
 * Defense in depth: markdown-it runs with `html:false`, so raw HTML in post
 * content is already entity-escaped before it ever reaches this pass (that is
 * the primary XSS line). This sanitizer re-walks the rendered output and
 * guarantees, independently of markdown-it:
 *
 *   - only allowlisted tags survive (`<script>`, `<iframe>`, `<object>`,
 *     `<embed>`, `<form>`, `<style>`, `<svg>`, ... are neutralized);
 *   - only allowlisted, per-tag attributes survive (all `on*` handlers drop);
 *   - `href` only carries http(s)/mailto/relative/fragment URLs;
 *   - `img src` only carries absolute http(s) URLs (else the whole tag drops);
 *   - `javascript:` / `data:` URLs never survive, including entity- or
 *     control-character-obfuscated variants.
 *
 * Any `<` that does not parse as an allowlisted, well-formed tag is escaped
 * to `&lt;` so it can never open a tag downstream.
 */

/** Escape text for a double-quoted HTML attribute or text node. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal HTML entity decoder used ONLY for URL validation (never for
 * output). Handles numeric references and the small named set relevant to
 * URL obfuscation. Unknown entities are left untouched.
 */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    colon: ":",
    semi: ";",
    sol: "/",
    bsol: "\\",
    num: "#",
    tab: "\t",
    newline: "\n",
    nbsp: " ",
  };
  return s.replace(
    /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (m, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = body.slice(hex ? 2 : 1);
        if (!hex && !/^[0-9]+$/.test(digits)) return m;
        const code = parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
        try {
          return String.fromCodePoint(code);
        } catch {
          return "";
        }
      }
      return named[body.toLowerCase()] ?? m;
    },
  );
}

// Control chars + space + DEL: browsers strip/ignore these inside URLs, so
// they must be removed BEFORE scheme matching ("java\tscript:" etc).
// eslint-disable-next-line no-control-regex
const URL_JUNK_RE = /[\u0000-\u0020\u007f]/g;

/** Decode entities and strip chars that browsers ignore inside URLs. */
function cleanUrl(raw: string): string {
  return decodeEntities(raw).replace(URL_JUNK_RE, "");
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Returns the cleaned URL when it is an absolute http(s) URL, else null.
 * Used for `img src` and for any profile/event-derived URL emitted by views.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = cleanUrl(raw);
  return /^https?:\/\/[^/]/i.test(url) ? url : null;
}

/**
 * Returns the cleaned URL when it is safe for an anchor href:
 * http(s), mailto, or scheme-less (relative path / #fragment). Else null.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const url = cleanUrl(raw);
  const m = SCHEME_RE.exec(url);
  if (!m || m[1] === undefined) return url; // relative / fragment / empty
  const scheme = m[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto"
    ? url
    : null;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

const A = (...extra: string[]) => new Set(["class", ...extra]);

/** Per-tag attribute allowlist. Tags absent from this map are dropped. */
const ALLOWED_TAGS: Record<string, ReadonlySet<string>> = {
  // Block structure
  p: A(),
  blockquote: A(),
  pre: A(),
  hr: A(),
  br: A(),
  div: A(),
  section: A(), // markdown-it-footnote wrapper
  h1: A("id"),
  h2: A("id"),
  h3: A("id"),
  h4: A("id"),
  h5: A("id"),
  h6: A("id"),
  ul: A(),
  ol: A("start"),
  li: A("id"), // footnote items carry ids
  table: A(),
  thead: A(),
  tbody: A(),
  tr: A(),
  th: A("style"),
  td: A("style"),
  // Inline
  a: A("href", "title", "id", "rel"), // footnote refs carry ids
  img: A("src", "alt", "title"),
  code: A(),
  span: A(), // highlight.js tokens
  em: A(),
  strong: A(),
  s: A(),
  del: A(),
  mark: A(),
  sup: A(),
  sub: A(),
  time: A("datetime"),
  input: A("type", "checked", "disabled"), // task-list checkboxes
};

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CLASS_RE = /^[A-Za-z0-9 _+.-]{1,256}$/;
const START_RE = /^[0-9]{1,6}$/;
const STYLE_RE = /^\s*text-align\s*:\s*(left|right|center)\s*;?\s*$/i;
const DATETIME_RE = /^[0-9TZ:+.\s-]{1,40}$/;
const ATTR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_TEXT_ATTR = 1024;

/**
 * Validate a single attribute for a given tag. Returns the value to emit
 * (entity-decoded; caller re-escapes) or null to drop the attribute.
 */
function validateAttr(tag: string, name: string, value: string): string | null {
  switch (name) {
    case "href":
      return safeHref(value);
    case "src":
      return safeHttpUrl(value);
    case "id":
      return ID_RE.test(value) ? value : null;
    case "class":
      return CLASS_RE.test(value) ? value : null;
    case "start":
      return START_RE.test(value) ? value : null;
    case "style":
      return STYLE_RE.test(value) ? value : null;
    case "datetime":
      return DATETIME_RE.test(value) ? value : null;
    case "type":
      return tag === "input" && value === "checkbox" ? value : null;
    case "checked":
    case "disabled":
      return ""; // boolean attributes
    case "title":
    case "alt":
    case "rel":
      return value.slice(0, MAX_TEXT_ATTR);
    default:
      return null;
  }
}

// Matches a whole tag at lastIndex. Quoted attribute values may not contain
// angle brackets (markdown-it entity-escapes them), which keeps the scan
// linear and prevents consuming across a following real tag.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"<>]*"|'[^'<>]*')*)>/y;

const ATTR_RE = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

/** Parse, filter, and re-serialize an opening tag. Returns null to drop it entirely. */
function rebuildOpenTag(tag: string, rawAttrs: string): string | null {
  const allowed = ALLOWED_TAGS[tag];
  if (!allowed) return null;

  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(rawAttrs)) !== null) {
    if (m.index === ATTR_RE.lastIndex) ATTR_RE.lastIndex++; // zero-width safety
    const rawName = m[1];
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (!ATTR_NAME_RE.test(name)) continue;
    if (name.startsWith("on")) continue; // belt AND braces: never event handlers
    if (!allowed.has(name)) continue;
    if (attrs.has(name)) continue; // browsers keep the first duplicate; so do we
    const rawValue = m[2] ?? m[3] ?? m[4] ?? "";
    const value = validateAttr(tag, name, decodeEntities(rawValue));
    if (value === null) continue;
    attrs.set(name, value);
  }

  // Tag-level requirements.
  if (tag === "img" && !attrs.has("src")) return null; // img MUST have http(s) src
  if (tag === "input" && attrs.get("type") !== "checkbox") return null;

  // External links: force a safe rel.
  const href = attrs.get("href");
  if (tag === "a" && href !== undefined && /^https?:/i.test(href)) {
    attrs.delete("rel");
    attrs.set("rel", "nofollow noopener");
  }

  let out = `<${tag}`;
  for (const [name, value] of attrs) {
    out += ` ${name}="${escapeHtml(value)}"`;
  }
  return out + ">";
}

/**
 * Allowlist pass over rendered HTML. Text outside tags is passed through
 * (markdown-it already entity-escaped it); every `<` that is not part of an
 * allowlisted, well-formed tag is escaped to `&lt;`.
 */
export function sanitizeHtml(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    const rawAttrs = m[3] ?? "";

    if (closing) {
      if (ALLOWED_TAGS[tag] && !VOID_TAGS.has(tag)) {
        out += `</${tag}>`;
        i = TAG_RE.lastIndex;
      } else {
        out += "&lt;";
        i = lt + 1;
      }
      continue;
    }

    const rebuilt = rebuildOpenTag(tag, rawAttrs);
    if (rebuilt === null) {
      if (ALLOWED_TAGS[tag]) {
        // Allowed tag that failed validation (e.g. img without http(s) src):
        // drop the whole tag silently.
        i = TAG_RE.lastIndex;
      } else {
        // Disallowed tag: escape the `<` so the rest renders as inert text.
        out += "&lt;";
        i = lt + 1;
      }
      continue;
    }
    out += rebuilt;
    i = TAG_RE.lastIndex;
  }

  return out;
}
