import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";
import { FeedList, type FeedItem } from "./feed";
import { SEARCH_MAX_QUERY_CHARS } from "../../services/search";

/**
 * Search page: query form + results. The echoed query is UNTRUSTED user
 * input and renders exclusively through hono/jsx text/attribute children
 * (strictly escaped) — never raw().
 *
 * `results === null` means "no query yet" (just the form); an empty array
 * means the query matched nothing.
 */
export function SearchPage(props: {
  query: string;
  results: FeedItem[] | null;
  mainHost: string;
  error?: string | null;
}) {
  return (
    <Layout title="Search — nbread.lol">
      <SiteHeader current="search" />
      <main class="search">
        <h1>Search</h1>
        <form method="get" action="/search" class="search-form" role="search">
          <input
            type="search"
            name="q"
            value={props.query}
            maxlength={SEARCH_MAX_QUERY_CHARS}
            placeholder="Search posts"
            aria-label="Search posts"
          />{" "}
          <button type="submit">Search</button>
        </form>
        {props.error ? (
          <p class="search-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.results === null ? (
          <p class="search-hint">
            Search every post published on {props.mainHost}.
          </p>
        ) : props.results.length === 0 ? (
          <p class="empty">No posts matched “{props.query}”.</p>
        ) : (
          <>
            <p class="search-count">
              {props.results.length}{" "}
              {props.results.length === 1 ? "result" : "results"} for “
              {props.query}”
            </p>
            <FeedList items={props.results} />
          </>
        )}
      </main>
      <SiteFooter />
    </Layout>
  );
}
