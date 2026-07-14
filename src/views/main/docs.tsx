import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/** /docs — user-facing help: signing in, claiming, writing, theming. */
export function DocsPage() {
  return (
    <Layout
      title="Docs — nbread.lol"
      description="How nbread.lol works: NIP-07 sign-in, handles, the markdown editor, feeds, theme CSS, and relays."
    >
      <SiteHeader current="docs" />
      <main class="info-page">
        <h1>Docs</h1>
        <p class="updated">Last updated: 2026-07-14</p>

        <h2>What is nbread.lol</h2>
        <p>
          Posts are NIP-23 long-form events (kind 30023) on public Nostr
          relays, which nbread.lol mirrors into an edge database and renders
          at <code>handle.nbread.lol</code>.
        </p>

        <h2>Signing in</h2>
        <p>
          You need a NIP-07 browser extension such as Alby or nos2x. You sign
          a one-time challenge; your keys never leave the extension.
        </p>

        <h2>Claiming a handle</h2>
        <p>
          Lowercase letters, digits, and hyphens, 2–31 characters; it must
          start and end with a letter or digit, and some names are reserved.
          One handle per key, plus a quick human check.
        </p>

        <h2>Writing</h2>
        <p>
          The built-in editor is markdown with a formatting toolbar and a
          live server preview; publish with <em>Sign & publish</em> via
          NIP-07. Or publish long-form from any Nostr client — the blog syncs
          from your relays within about 15 minutes.
        </p>

        <h2>Your blog</h2>
        <p>
          Your blog lives at <code>handle.nbread.lol</code>, with{" "}
          <code>/rss.xml</code>, <code>/atom.xml</code>, and{" "}
          <code>/sitemap.xml</code>.
        </p>

        <h2>NIP-05</h2>
        <p>
          You are <code>handle@nbread.lol</code>.
        </p>

        <h2>Markdown support</h2>
        <p>
          Headings, bold/italic/strikethrough, <code>==highlight==</code>,
          links, images by URL, code blocks with syntax highlighting, tables,
          footnotes, and task lists.
        </p>

        <h2>Theme CSS</h2>
        <p>
          Set custom CSS in dashboard settings — a sanitized CSS subset
          applied after the base stylesheet. Stable hooks:{" "}
          <code>.blog-header</code>, <code>.blog-name</code>,{" "}
          <code>.post-list</code>, <code>.post-item</code>,{" "}
          <code>.post-date</code>, <code>.post-content</code>. For example:
        </p>
        <pre>
          <code>{`a { color: #b04a2f; }
body { font-family: Georgia, serif; }
.blog-name { color: #b04a2f; }`}</code>
        </pre>

        <h2>Deleting posts</h2>
        <p>
          NIP-09 deletes are honored by the mirror. Other relays may retain
          copies.
        </p>

        <h2>Relays</h2>
        <p>
          Defaults: relay.damus.io, nos.lol, and relay.nostr.band. Set your
          own in the dashboard.
        </p>

        <h2>Unclaimed blogs</h2>
        <p>
          Any npub renders read-only at <code>nbread.lol/npub1…</code>.
        </p>

        <h2>Source & license</h2>
        <p>
          AGPL-3.0 —{" "}
          <a href="https://github.com/sovITxyz/nbread">
            github.com/sovITxyz/nbread
          </a>
          . Run your own if you like.
        </p>
      </main>
      <SiteFooter />
    </Layout>
  );
}
