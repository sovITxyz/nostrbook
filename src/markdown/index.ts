/**
 * Markdown pipeline for NIP-23 post content.
 *
 * markdown-it with `html:false` — raw HTML in post content is entity-escaped
 * by markdown-it itself; this is the PRIMARY XSS line. The rendered output
 * then goes through the sanitize.ts allowlist pass as defense in depth.
 *
 * Plugins: footnote, task-lists, mark, sup, sub. Code fences are highlighted
 * with a language-registered highlight.js subset. Headings get slugified ids
 * with a per-render dedup counter.
 */
import MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import markPlugin from "markdown-it-mark";
import supPlugin from "markdown-it-sup";
import subPlugin from "markdown-it-sub";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { sanitizeHtml, escapeHtml } from "./sanitize";

// Registered subset only — keeps the worker bundle bounded. Aliases (js, ts,
// py, sh, html, ...) come with each language module.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** Info strings are attacker-controlled; only clean short names reach class="". */
const LANG_RE = /^[a-zA-Z0-9+#-]{1,30}$/;

function highlight(code: string, lang: string): string {
  if (lang && LANG_RE.test(lang) && hljs.getLanguage(lang)) {
    try {
      const { value } = hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true,
      });
      return `<pre><code class="hljs language-${escapeHtml(lang)}">${value}</code></pre>`;
    } catch {
      // fall through to markdown-it's own escaping
    }
  }
  return ""; // markdown-it escapes the fence body itself
}

/** ASCII slug for heading ids ("" when nothing survives). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Core rule: add slugified, per-render-deduped ids to headings.
 *
 * Dedup keeps a per-base next-suffix map alongside the used-set so each
 * collision scan resumes where the previous one stopped — amortized O(1)
 * per heading. A single restarting counter would be O(n²) across n
 * identical headings, which a crafted post could turn into a CPU burn.
 */
function headingIds(state: StateCore): void {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.type !== "heading_open") continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== "inline") continue;
    const text = (inline.children ?? [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join("");
    const base = slugify(text) || "section";
    let slug = base;
    let n = nextSuffix.get(base) ?? 1;
    while (used.has(slug)) slug = `${base}-${n++}`;
    nextSuffix.set(base, n);
    used.add(slug);
    token.attrSet("id", slug);
  }
}

const md = new MarkdownIt({
  html: false, // PRIMARY XSS line: raw HTML is escaped, never parsed
  xhtmlOut: false,
  breaks: false,
  linkify: true,
  typographer: false,
  highlight,
})
  .use(footnote)
  .use(taskLists, { enabled: false })
  .use(markPlugin)
  .use(supPlugin)
  .use(subPlugin);

// linkify: keep only http(s)/mailto autolinks (no ftp:, no bare "//host").
md.linkify.set({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false });
md.linkify.add("ftp:", null);
md.linkify.add("//", null);

md.core.ruler.push("nostrbook_heading_ids", headingIds);

/**
 * Cap on rendered markdown input. Anything larger is truncated before
 * parsing.
 *
 * Deliberately well BELOW the 256 KiB event content cap
 * (src/nostr/event.ts MAX_CONTENT_LENGTH): markdown-it is superlinear with
 * a large constant on hostile input ("![".repeat(n), "[".repeat(n),
 * "*a".repeat(n)), and renderPost runs synchronously on the post-page
 * request path. At 256 KiB a crafted post costs ~1s of CPU per render; at
 * 32 KiB the worst measured hostile input stays around ~150ms and legit
 * long-form posts (~5-8k words) still fit. Response caching (P3+) further
 * amortizes this; the cap is the render-path backstop.
 */
export const MAX_MARKDOWN_LENGTH = 32_768;

/**
 * Render NIP-23 markdown to safe HTML.
 * markdown-it (html:false) → sanitize.ts allowlist pass.
 */
export function renderPost(src: string): string {
  const input =
    typeof src === "string" ? src.slice(0, MAX_MARKDOWN_LENGTH) : "";
  return sanitizeHtml(md.render(input));
}
