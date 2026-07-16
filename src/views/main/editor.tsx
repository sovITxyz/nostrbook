import type { Child } from "hono/jsx";
import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/**
 * Editor page (new post / edit existing). All signing happens client-side in
 * public/js/editor.js through the NbreadSigner abstraction (NIP-07 extension,
 * NIP-46 remote bunker, NIP-55/Amber redirect, or a stored local key); this
 * page only ships the form plus a JSON config blob the scripts read. The
 * markdown toolbar, Write/Preview tabs, counter, and draft autosave are wired
 * by public/js/editor-toolbar.js on top of the DOM-free text core in
 * public/js/editor-md.js — script order at the bottom matters (signer stack
 * first, then the editor scripts).
 *
 * XSS notes: every field value renders through hono/jsx auto-escaping (post
 * titles/summaries/content are relay-sourced and hostile by assumption). The
 * config JSON is embedded in a non-executable script tag with every `<`
 * escaped to < so a crafted d-tag/relay URL can never break out with
 * `</script>`. No inline executable script anywhere (CSP: script-src 'self').
 */

/** One toolbar button: kebab action id + accessible name + text glyph. */
type ToolbarButton = {
  action: string;
  name: string;
  shortcut?: string;
  glyph: Child;
};

// Three groups (inline styles / block structure / media), rendered with a
// .toolbar-sep between groups. Actions map 1:1 to editor-toolbar.js.
const TOOLBAR_GROUPS: ToolbarButton[][] = [
  [
    { action: "bold", name: "Bold", shortcut: "Ctrl+B", glyph: <strong>B</strong> },
    { action: "italic", name: "Italic", shortcut: "Ctrl+I", glyph: <em>I</em> },
    {
      action: "strike",
      name: "Strikethrough",
      shortcut: "Ctrl+Shift+X",
      glyph: <s>S</s>,
    },
    { action: "mark", name: "Highlight", glyph: "==" },
    { action: "code", name: "Inline code", shortcut: "Ctrl+E", glyph: "</>" },
  ],
  [
    { action: "heading", name: "Heading", glyph: "H" },
    { action: "quote", name: "Blockquote", shortcut: "Ctrl+Shift+.", glyph: "❝" },
    { action: "ul", name: "Bulleted list", shortcut: "Ctrl+Shift+8", glyph: "•" },
    { action: "ol", name: "Numbered list", shortcut: "Ctrl+Shift+7", glyph: "1." },
    {
      action: "task",
      name: "Task list",
      shortcut: "Ctrl+Shift+9",
      glyph: "☑︎",
    },
    { action: "fence", name: "Code block", glyph: "```" },
    { action: "table", name: "Table", glyph: "⊞" },
    { action: "footnote", name: "Footnote", glyph: "[^]" },
    { action: "hr", name: "Horizontal rule", glyph: "—" },
  ],
  [
    { action: "link", name: "Link", shortcut: "Ctrl+K", glyph: <u>a</u> },
    { action: "image", name: "Image", glyph: "▣" },
  ],
];

export function EditorPage(props: {
  mode: "new" | "edit";
  slug: string; // "" for new posts
  title: string;
  summary: string;
  content: string;
  publishedAt: number | null; // original publication time, preserved on edit
  prevCreatedAt: number | null; // stored version's created_at (edit must exceed it)
  eventId: string | null; // stored event id (delete e-tags it)
  pubkey: string;
  relays: string[];
  handle: string | null;
  mainHost: string;
}) {
  const config = {
    mode: props.mode,
    slug: props.slug,
    publishedAt: props.publishedAt,
    prevCreatedAt: props.prevCreatedAt,
    eventId: props.eventId,
    pubkey: props.pubkey,
    relays: props.relays,
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const isEdit = props.mode === "edit";

  return (
    <Layout
      title={isEdit ? "Edit post — nbread.lol" : "New post — nbread.lol"}
      bodyClass="editor-wide"
    >
      <SiteHeader variant="app" />
      <main>
        <h1>{isEdit ? "Edit post" : "New post"}</h1>
        <p>
          <a href="/dashboard">&larr; Dashboard</a>
          {isEdit && props.handle && props.slug !== "" ? (
            <>
              {" · "}
              <a
                href={`https://${props.handle}.${props.mainHost}/${encodeURIComponent(props.slug)}`}
              >
                View published
              </a>
            </>
          ) : null}
        </p>

        {/* Unhidden by editor-toolbar.js when a newer local draft exists. */}
        <div class="draft-notice" id="draft-notice" hidden>
          <span id="draft-notice-text"></span>{" "}
          <button type="button" id="draft-restore">
            Restore
          </button>{" "}
          <button type="button" id="draft-discard">
            Discard
          </button>
        </div>

        <form id="editor-form" class="editor-form">
          <p>
            <label>
              Title
              <br />
              <input
                id="post-title"
                name="title"
                type="text"
                required
                maxlength={200}
                value={props.title}
                placeholder="Post title"
              />
            </label>
          </p>
          <p>
            <label>
              Slug (d-tag){" "}
              {isEdit ? (
                <input
                  id="post-slug"
                  name="slug"
                  type="text"
                  value={props.slug}
                  readonly
                />
              ) : (
                <input
                  id="post-slug"
                  name="slug"
                  type="text"
                  maxlength={64}
                  placeholder="derived from the title when empty"
                  autocomplete="off"
                  spellcheck={false}
                />
              )}
            </label>
          </p>
          <p>
            <label>
              Summary
              <br />
              <input
                id="post-summary"
                name="summary"
                type="text"
                maxlength={500}
                value={props.summary}
                placeholder="Optional one-line summary"
              />
            </label>
          </p>

          <div class="editor-tabs" role="tablist" aria-label="Editor view">
            <button
              type="button"
              role="tab"
              id="tab-write"
              aria-controls="write-panel"
              aria-selected="true"
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              id="tab-preview"
              aria-controls="preview"
              aria-selected="false"
              tabindex={-1}
            >
              Preview
            </button>
          </div>

          <div id="write-panel" role="tabpanel" aria-labelledby="tab-write">
            <div class="editor-toolbar" role="toolbar" aria-label="Formatting">
              {TOOLBAR_GROUPS.map((group, gi) => (
                <>
                  {gi > 0 ? (
                    <span class="toolbar-sep" aria-hidden="true"></span>
                  ) : null}
                  {group.map((b) => (
                    <button
                      type="button"
                      data-md-action={b.action}
                      aria-label={b.name}
                      title={b.shortcut ? `${b.name} (${b.shortcut})` : b.name}
                    >
                      {b.glyph}
                    </button>
                  ))}
                </>
              ))}
            </div>
            <p>
              <label>
                Markdown
                <br />
                {/* The textarea is seeded with a protective leading "\n" the
                    HTML parser eats exactly one of, so content that itself
                    starts with a newline round-trips unchanged — otherwise
                    republishing would strip it and mint a different event id. */}
                <textarea
                  id="post-content"
                  name="content"
                  rows={20}
                  cols={80}
                  required
                  spellcheck={true}
                >
                  {"\n" + props.content}
                </textarea>
              </label>
            </p>
            <p class="editor-meta" id="editor-meta"></p>
          </div>

          <p class="editor-actions">
            <button id="publish-button" type="button">
              {isEdit ? "Sign & republish" : "Sign & publish"}
            </button>
            {isEdit ? (
              <>
                {" "}
                <button id="delete-button" type="button" class="danger">
                  Delete post
                </button>
              </>
            ) : null}
          </p>
        </form>
        <p id="editor-status" role="status" aria-live="polite"></p>

        <section id="preview" role="tabpanel" aria-labelledby="tab-preview" hidden>
          <h2>Preview</h2>
          <div id="preview-body" class="post-content"></div>
        </section>

        <script
          type="application/json"
          id="editor-config"
          dangerouslySetInnerHTML={{ __html: configJson }}
        ></script>
        <script src="/js/vendor/nostr-crypto.js"></script>
        <script src="/js/signer-core.js"></script>
        <script src="/js/signer.js"></script>
        <script src="/js/signer-nip46.js"></script>
        <script src="/js/editor-md.js"></script>
        <script src="/js/editor-toolbar.js"></script>
        <script src="/js/editor.js"></script>
      </main>
      <SiteFooter />
    </Layout>
  );
}
