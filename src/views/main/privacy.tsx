import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/** /privacy — plain-English privacy policy. Static JSX, no data access. */
export function PrivacyPage() {
  return (
    <Layout
      title="Privacy — nbread.lol"
      description="What nbread.lol stores, what it doesn't, and why everything you publish here is public by design."
    >
      <SiteHeader />
      <main class="info-page">
        <h1>Privacy Policy</h1>
        <p class="updated">Last updated: 2026-07-14</p>

        <h2>The short version</h2>
        <p>
          No accounts, no emails, no passwords, no trackers. Your identity is
          your Nostr public key, and everything you publish is public by
          design.
        </p>

        <h2>What we store</h2>
        <p>
          A mirror of your <strong>public</strong> Nostr events, pulled from
          public relays: long-form posts (kind 30023), profiles (kind 0), and
          deletes (kind 5). If you claim a handle, we also store it along with
          your blog settings — theme CSS, about text, and relay list.
        </p>

        <h2>Sessions</h2>
        <p>
          Signing in with your Nostr key sets one first-party cookie, valid
          for up to 90 days, that maps to your public key. Nothing else. Your
          signer settings — and, if you choose the pasted-key option, your
          secret key — are stored in your browser's localStorage and never
          sent to the server.
        </p>

        <h2>Operational data</h2>
        <p>
          We keep per-IP rate-limit counters (from the CF-Connecting-IP
          header) used only for abuse throttling; stale counters are purged
          on a schedule, within two days of their window ending — not a
          durable access log. No analytics, no ads, no third-party trackers.
        </p>

        <h2>Public by design</h2>
        <p>
          Your posts live on public Nostr relays. Deleting a post (NIP-09) is
          honored by our mirror, but other relays and mirrors may retain
          copies. Treat everything you publish as permanent.
        </p>

        <h2>Third parties</h2>
        <p>
          Cloudflare hosts the service, so your IP address passes through it.
          Cloudflare Turnstile runs only on handle claim, where your IP is
          forwarded for the bot check. Nostr relays — by default
          relay.damus.io, nos.lol, and relay.nostr.band, plus any you
          configure — receive what you publish.
        </p>

        <h2>Moderation</h2>
        <p>
          An admin blocklist can unlist a blog from this service: it 404s and
          disappears from discover, search, and NIP-05. Your events on the
          relays are untouched.
        </p>

        <h2>Source</h2>
        <p>
          nbread.lol is open source under AGPL-3.0:{" "}
          <a href="https://github.com/sovITxyz/nbread">
            github.com/sovITxyz/nbread
          </a>
          .
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy:{" "}
          <a href="mailto:git@sovit.xyz">git@sovit.xyz</a> or open an issue on{" "}
          <a href="https://github.com/sovITxyz/nbread">GitHub</a>.
        </p>
      </main>
      <SiteFooter />
    </Layout>
  );
}
