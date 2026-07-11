import { BlogLayout, type BlogProfile } from "./layout";
import type { User } from "../../services/users";
import type { NostrEvent } from "../../nostr/event";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * Blog home: post list (title + summary + date from 30023 tags).
 * All strings are event/profile-derived and untrusted; hono/jsx escapes
 * text and attribute contexts.
 */
export function BlogHome(props: {
  user: User;
  profile: BlogProfile | null;
  posts: NostrEvent[];
  themeCss?: string;
  mainHost: string;
}) {
  const handle = props.user.handle ?? "";
  const name = props.profile?.name?.trim() || `@${handle}`;
  // Drop d-tagless posts (slug ""): they have no addressable URL — the link
  // would be href="/" and just point back at this page. Feeds and the
  // sitemap filter the same way (views/tenant/xml.ts).
  const metas = props.posts.map(postMeta).filter((m) => m.slug !== "");

  return (
    <BlogLayout
      title={`${name} — Nostrbook`}
      handle={handle}
      mainHost={props.mainHost}
      profile={props.profile}
      themeCss={props.themeCss ?? ""}
    >
      <main class="blog-main">
        {metas.length === 0 ? (
          <p class="empty">No posts yet.</p>
        ) : (
          <ul class="post-list">
            {metas.map((m) => {
              const date = isoDate(m.published_at);
              return (
                <li class="post-item">
                  <a class="post-link" href={`/${encodeURIComponent(m.slug)}`}>
                    {m.title}
                  </a>{" "}
                  <time class="post-date" datetime={date}>
                    {date}
                  </time>
                  {m.summary ? <p class="post-summary">{m.summary}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </BlogLayout>
  );
}
