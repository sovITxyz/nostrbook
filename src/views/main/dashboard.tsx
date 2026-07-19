import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";
import type { BlogSettings } from "../../services/users";

/** One row of the dashboard post list. */
export type DashboardPost = {
  slug: string;
  title: string;
  date: string; // YYYY-MM-DD
};

/**
 * Authed dashboard: the signed-in npub, handle claim (until claimed), the
 * user's own mirrored posts with edit links, a "new post" button, blog
 * settings (theme CSS / about / relays), and logout.
 *
 * All dynamic strings render through hono/jsx auto-escaping; edit links
 * additionally encodeURIComponent the slug (d-tags are arbitrary strings).
 */
export function DashboardPage(props: {
  npub: string;
  handle: string | null;
  mainHost: string;
  turnstileSiteKey: string;
  error: string | null;
  saved: boolean;
  posts: DashboardPost[];
  settings: BlogSettings;
}) {
  return (
    <Layout title="Dashboard — nbread.lol">
      <SiteHeader variant="app" />
      <main>
        <h1>Dashboard</h1>
        <p class="dashboard-npub">
          Signed in as <code>{props.npub}</code>
        </p>

        {props.error ? (
          <p class="claim-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.saved ? (
          <p class="settings-saved" role="status">
            Settings saved.
          </p>
        ) : null}

        {props.handle ? (
          <section class="dashboard-handle">
            <h2>Your blog</h2>
            <p>
              <a href={`https://${props.handle}.${props.mainHost}/`}>
                {props.handle}.{props.mainHost}
              </a>
            </p>
            <p>
              Your NIP-05 identifier:{" "}
              <code>
                {props.handle}@{props.mainHost}
              </code>
            </p>
          </section>
        ) : (
          <section class="dashboard-claim">
            <h2>Claim your handle</h2>
            <p>
              Pick the subdomain your blog will live at. One handle per key —
              choose carefully.
            </p>
            <form method="post" action="/dashboard/claim">
              <label>
                Handle{" "}
                <input
                  name="handle"
                  type="text"
                  required
                  minlength={2}
                  maxlength={31}
                  pattern="[a-z0-9][a-z0-9\-]{0,29}[a-z0-9]"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="yourname"
                />
              </label>
              <span class="claim-suffix">.{props.mainHost}</span>
              <div
                class="cf-turnstile"
                data-sitekey={props.turnstileSiteKey}
              ></div>
              <button type="submit">Claim</button>
            </form>
            <script
              src="https://challenges.cloudflare.com/turnstile/v0/api.js"
              async
              defer
            ></script>
          </section>
        )}

        <section class="dashboard-posts">
          <h2>Your posts</h2>
          <p>
            <a class="new-post-button" href="/dashboard/posts/new">
              New post
            </a>
          </p>
          {props.posts.length === 0 ? (
            <p class="posts-empty">
              No posts yet — write your first one, or wait for the next relay
              sync to mirror what you have published elsewhere.
            </p>
          ) : (
            <ul class="post-list">
              {props.posts.map((post) => (
                <li>
                  <span class="post-title">{post.title}</span>{" "}
                  <time>{post.date}</time>{" "}
                  {post.slug !== "" ? (
                    <a
                      class="post-edit-link"
                      href={`/dashboard/editor?slug=${encodeURIComponent(post.slug)}`}
                    >
                      Edit
                    </a>
                  ) : (
                    <span class="post-no-slug">(no slug — not editable)</span>
                  )}{" "}
                  {props.handle && post.slug !== "" ? (
                    <a
                      href={`https://${props.handle}.${props.mainHost}/${encodeURIComponent(post.slug)}`}
                    >
                      View
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="dashboard-profile">
          <h2>Your profile</h2>
          <p>
            Name, avatar, bio, lightning address — your public Nostr profile
            (kind 0). <a href="/dashboard/profile">Edit profile</a>
          </p>
        </section>

        <section class="dashboard-settings">
          <h2>Blog settings</h2>
          <form method="post" action="/dashboard/settings">
            <p>
              <label>
                About
                <br />
                <textarea
                  name="about"
                  rows={3}
                  cols={60}
                  maxlength={1000}
                  placeholder="A short blurb about your blog"
                >
                  {props.settings.about}
                </textarea>
              </label>
            </p>
            <p>
              <label>
                Theme CSS
                <br />
                {/* Protective leading "\n" (the HTML parser eats one) so CSS
                    that begins with a newline survives the edit round-trip. */}
                <textarea
                  name="css"
                  rows={8}
                  cols={60}
                  spellcheck={false}
                  placeholder={"body { background: #fffdf5; }"}
                >
                  {"\n" + props.settings.css}
                </textarea>
              </label>
            </p>
            <p>
              <label>
                Your relays (wss:// URLs, one per line)
                <br />
                <small>
                  Add your own relays to broadcast and mirror from. Leave blank
                  to use the nbread.lol defaults.
                </small>
                <br />
                <textarea
                  name="relays"
                  rows={3}
                  cols={60}
                  spellcheck={false}
                  placeholder={"wss://relay.damus.io\nwss://relay.primal.net"}
                >
                  {props.settings.relays.join("\n")}
                </textarea>
              </label>
            </p>
            <button type="submit">Save settings</button>
          </form>
        </section>

        <form method="post" action="/logout" class="logout-form">
          <button type="submit">Sign out</button>
        </form>
      </main>
      <SiteFooter />
    </Layout>
  );
}
