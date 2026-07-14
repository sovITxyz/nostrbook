import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";
import { FeedList, type FeedItem } from "./feed";

/**
 * Discover page: recent posts by claimed, non-blocked users across all
 * blogs, paginated. Items come pre-scoped from listRecentClaimedPosts;
 * every string renders through hono/jsx auto-escaping.
 *
 * `error` (rate-limit denial) replaces the feed and pager entirely.
 */
export function DiscoverPage(props: {
  items: FeedItem[];
  page: number;
  hasNext: boolean;
  mainHost: string;
  error?: string | null;
}) {
  return (
    <Layout title="Discover — nbread.lol">
      <SiteHeader current="discover" />
      <main class="discover">
        <h1>Discover</h1>
        <p class="page-intro">
          Recent posts from blogs on {props.mainHost}.
        </p>
        {props.error ? (
          <p class="discover-error" role="alert">
            {props.error}
          </p>
        ) : props.items.length === 0 ? (
          <p class="empty">No posts here yet.</p>
        ) : (
          <FeedList items={props.items} />
        )}
        {!props.error && (props.page > 1 || props.hasNext) ? (
          <nav class="pager" aria-label="Pagination">
            {props.page > 1 ? (
              <a rel="prev" href={`/discover?page=${props.page - 1}`}>
                ← Newer
              </a>
            ) : null}
            {props.hasNext ? (
              <a rel="next" href={`/discover?page=${props.page + 1}`}>
                Older →
              </a>
            ) : null}
          </nav>
        ) : null}
      </main>
      <SiteFooter />
    </Layout>
  );
}
