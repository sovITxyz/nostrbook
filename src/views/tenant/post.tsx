import { BlogLayout, type BlogProfile } from "./layout";
import type { NostrEvent } from "../../nostr/event";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * Zap affordance data (#12 v1), precomputed by the ROUTE: `lud16` has passed
 * safeLud16 (shape-validated, safe inside a `lightning:` href) and `naddr`
 * is our own nip19 encoding of the post address. Totals come from the
 * zap_totals rollup. Everything renders as plain server-side links/text —
 * blog pages stay JS-free (BLOG_CSP has no script-src).
 */
export type PostZap = {
  lud16: string;
  naddr: string;
  msatTotal: number;
  zapCount: number;
};

/**
 * Post page: title, published_at, rendered content, zap footer.
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
  about?: string | null;
  themeCss?: string;
  mainHost: string;
  basePath?: string;
  zap?: PostZap | null;
}) {
  const meta = postMeta(props.event);
  const date = isoDate(meta.published_at);
  const zap = props.zap ?? null;
  const sats = zap ? Math.floor(zap.msatTotal / 1000) : 0;

  return (
    <BlogLayout
      title={`${meta.title} — @${props.handle}`}
      handle={props.handle}
      mainHost={props.mainHost}
      profile={props.profile}
      about={props.about}
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
          {zap ? (
            <footer class="post-zap">
              <p>
                {/* Hand-off to a Nostr client for an ATTRIBUTED zap (its 9735
                    references this post and feeds the counts); the lightning:
                    link is the walletless plain-tip fallback (no receipt, not
                    counted). */}
                <a
                  href={`https://njump.me/${zap.naddr}`}
                  rel="noopener nofollow"
                >
                  ⚡ Zap this post
                </a>
                {" · "}
                <a href={`lightning:${zap.lud16}`} rel="nofollow">
                  tip {zap.lud16}
                </a>
                {zap.zapCount > 0 ? (
                  <span class="zap-totals">
                    {" · "}
                    {sats.toLocaleString("en-US")} sats · {zap.zapCount}{" "}
                    {zap.zapCount === 1 ? "zap" : "zaps"}
                  </span>
                ) : null}
              </p>
            </footer>
          ) : null}
        </article>
      </main>
    </BlogLayout>
  );
}
