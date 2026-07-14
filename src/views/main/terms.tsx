import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/** /terms — plain-English terms of service. Static JSX, no data access. */
export function TermsPage() {
  return (
    <Layout
      title="Terms — nbread.lol"
      description="The deal: you own your content, nbread.lol mirrors and renders it, don't abuse the service."
    >
      <SiteHeader />
      <main class="info-page">
        <h1>Terms of Service</h1>
        <p class="updated">Last updated: 2026-07-14</p>

        <h2>Your content</h2>
        <p>
          You own your content — posts are your signed Nostr events. By
          publishing here you grant nbread.lol the right to mirror, render,
          and distribute them; that <em>is</em> the service.
        </p>

        <h2>Acceptable use</h2>
        <p>No illegal content, spam, malware, or impersonation.</p>

        <h2>Handles</h2>
        <p>
          Handles are first-come, one per key. A handle may be reclaimed in
          cases of squatting, impersonation, or abuse.
        </p>

        <h2>Moderation</h2>
        <p>
          We may block blogs from this service. Your events remain on the
          relays you published to.
        </p>

        <h2>No warranty</h2>
        <p>
          The service is free and provided as-is, without warranty. It may
          change or shut down — your posts survive on Nostr relays
          regardless.
        </p>

        <h2>Changes</h2>
        <p>Changes to these terms are announced on this page.</p>

        <h2>Contact</h2>
        <p>
          <a href="mailto:git@sovit.xyz">git@sovit.xyz</a> or the{" "}
          <a href="https://github.com/sovITxyz/nbread">GitHub repo</a>.
        </p>
      </main>
      <SiteFooter />
    </Layout>
  );
}
