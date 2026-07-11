import { BlogLayout, type BlogProfile } from "./layout";
import type { User } from "../../services/users";
import type { NostrEvent } from "../../nostr/event";
import { renderPost } from "../../markdown";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * Post page: title, published_at, rendered content.
 * The body HTML comes from renderPost (markdown-it html:false + allowlist
 * sanitizer) — the ONLY dangerouslySetInnerHTML sink for event content.
 */
export function PostPage(props: {
  user: User;
  profile: BlogProfile | null;
  event: NostrEvent;
  themeCss?: string;
  mainHost: string;
}) {
  const handle = props.user.handle ?? "";
  const meta = postMeta(props.event);
  const date = isoDate(meta.published_at);
  const body = renderPost(props.event.content);

  return (
    <BlogLayout
      title={`${meta.title} — @${handle}`}
      handle={handle}
      mainHost={props.mainHost}
      profile={props.profile}
      themeCss={props.themeCss ?? ""}
    >
      <main class="blog-main">
        <article class="post">
          <header class="post-header">
            <h1 class="post-title">{meta.title}</h1>
            <p class="post-meta">
              <time class="post-date" datetime={date}>
                {date}
              </time>
            </p>
          </header>
          <div
            class="post-content"
            dangerouslySetInnerHTML={{ __html: body }}
          />
        </article>
      </main>
    </BlogLayout>
  );
}
