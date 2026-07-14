import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/** Apex 404 page (mainApp.notFound). Static JSX — safe on any unknown path. */
export function MainNotFound() {
  return (
    <Layout title="404 — nbread.lol">
      <SiteHeader />
      <main class="info-page">
        <h1>404</h1>
        <p>There's no page here — it may have moved, or never existed.</p>
        <p>
          Head back <a href="/">home</a> or{" "}
          <a href="/discover">discover recent posts</a>.
        </p>
      </main>
      <SiteFooter />
    </Layout>
  );
}
