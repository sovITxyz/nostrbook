import { Layout } from "../layout";

/** 404 page for blog subdomains (unknown slug / unknown path). */
export function NotFoundPage(props: { handle?: string }) {
  return (
    <Layout title="Not found — Nostrbook">
      <main class="not-found">
        <h1>404</h1>
        <p>
          {props.handle
            ? `There is no such page on @${props.handle}'s blog.`
            : "There is no such page."}
        </p>
        <p>
          <a href="/">Back to the front page</a>
        </p>
      </main>
    </Layout>
  );
}
