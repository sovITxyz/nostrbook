import { BlogLayout, type BlogProfile } from "./layout";
import type { NostrEvent } from "../../nostr/event";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * Post page: title, published_at, rendered content.
 *
 * `bodyHtml` is the renderPost output (markdown-it html:false + allowlist
 * sanitizer) that mirrorEvent stored at INGEST time (events.rendered) — the
 * ONLY dangerouslySetInnerHTML sink for event content. This view never calls
 * renderPost itself (render-at-ingest contract, P2→P3 addendum).
 */
export function PostPage(props: {
  handle: string;
  profile: BlogProfile | null;
  event: NostrEvent;
  bodyHtml: string;
  themeCss?: string;
  mainHost: string;
  basePath?: string;
}) {
  const meta = postMeta(props.event);
  const date = isoDate(meta.published_at);

  return (
    <BlogLayout
      title={`${meta.title} — @${props.handle}`}
      handle={props.handle}
      mainHost={props.mainHost}
      profile={props.profile}
      themeCss={props.themeCss ?? ""}
      basePath={props.basePath ?? ""}
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
            dangerouslySetInnerHTML={{ __html: props.bodyHtml }}
          />
        </article>
      </main>
    </BlogLayout>
  );
}
