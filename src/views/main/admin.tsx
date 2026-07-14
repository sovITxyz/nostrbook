import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/** One blocked-user row on the admin page. */
export type BlockedEntry = {
  /** npub encoding of the blocked pubkey (used as the unblock target). */
  npub: string;
  /** Claimed handle, or null for keys blocked before ever claiming. */
  handle: string | null;
};

/**
 * Admin page (P7 abuse blocklist). Reachable ONLY through the admin gate in
 * src/routes/admin.ts (ADMIN_PUBKEY session match — everyone else 404s).
 * All dynamic strings (handles, npubs, error text) render through hono/jsx
 * auto-escaping; the unblock target rides a hidden input, POSTed same-origin
 * (CSRF middleware covers all unsafe methods on the apex).
 */
export function AdminPage(props: {
  mainHost: string;
  error: string | null;
  notice: string | null;
  blocked: BlockedEntry[];
}) {
  return (
    <Layout title="Admin — nbread.lol">
      <SiteHeader variant="app" />
      <main class="admin">
        <h1>Admin</h1>

        {props.error ? (
          <p class="claim-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.notice ? (
          <p class="settings-saved" role="status">
            {props.notice}
          </p>
        ) : null}

        <section class="admin-block">
          <h2>Block a user</h2>
          <p>
            Blocking 404s the blog subdomain and npub pages (cached copies are
            invalidated), drops the author from discover, search, and NIP-05
            (<code>nostr.json</code>), and refuses writes and handle claims.
            Unblocking restores everything.
          </p>
          <form method="post" action="/admin/block">
            <label>
              Handle, npub, or hex pubkey{" "}
              <input
                name="target"
                type="text"
                required
                maxlength={128}
                autocomplete="off"
                spellcheck={false}
                placeholder="handle, npub1…, or 64-char hex"
              />
            </label>{" "}
            <button type="submit" class="danger">
              Block
            </button>
          </form>
        </section>

        <section class="admin-blocked">
          <h2>Blocked users ({props.blocked.length})</h2>
          {props.blocked.length === 0 ? (
            <p class="empty">Nobody is blocked.</p>
          ) : (
            <ul class="blocked-list">
              {props.blocked.map((entry) => (
                <li>
                  {entry.handle ? (
                    <>
                      <code>{entry.handle}</code>{" "}
                    </>
                  ) : null}
                  <code class="blocked-npub">{entry.npub}</code>{" "}
                  <form
                    method="post"
                    action="/admin/unblock"
                    class="unblock-form"
                  >
                    <input type="hidden" name="target" value={entry.npub} />
                    <button type="submit">Unblock</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <SiteFooter />
    </Layout>
  );
}
