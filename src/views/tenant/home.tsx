import { BlogLayout, type BlogProfile } from "./layout";
import type { NostrEvent } from "../../nostr/event";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * Blog home: post list (title + summary + date from 30023 tags).
 * All strings are event/profile-derived and untrusted; hono/jsx escapes
 * text and attribute contexts.
 */
export function BlogHome(props: {
  handle: string;
  profile: BlogProfile | null;
  posts: NostrEvent[];
  about?: string | null;
  themeCss?: string;
  mainHost: string;
  basePath?: string;
}) {
  const base = props.basePath ?? "";
  const name = props.profile?.name?.trim() || `@${props.handle}`;
  // Drop d-tagless posts (slug ""): they have no addressable URL — the link
  // would be href="/" and just point back at this page. Feeds and the
  // sitemap filter the same way (views/tenant/xml.ts).
  const metas = props.posts.map(postMeta).filter((m) => m.slug !== "");

  return (
    <BlogLayout
      title={`${name} — nbread.lol`}
      handle={props.handle}
      mainHost={props.mainHost}
      profile={props.profile}
      about={props.about}
      themeCss={props.themeCss ?? ""}
      basePath={base}
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
                  <a
                    class="post-link"
                    href={`${base}/${encodeURIComponent(m.slug)}`}
                  >
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
