import { Layout } from "../layout";
import { LogoMark } from "../brand";
import { SiteFooter } from "./chrome";

/**
 * Landing page: bearblog-style hero + feature list. No SiteHeader here —
 * the hero carries the brand; nav lives in the CTA and landing links.
 */
export function MainHome() {
  return (
    <Layout
      title="nbread.lol — Nostr-native blogging"
      description="Nostr-native, no-nonsense, super-fast blogging. Your posts are NIP-23 events signed by your key."
    >
      <main class="landing">
        <div class="hero">
          <LogoMark size={72} class="logo-hero" />
          <h1>nbread.lol</h1>
          <p class="tagline">
            Nostr-native, no-nonsense, super-fast blogging.
          </p>
          <p class="tagline-sub">
            Your posts are NIP-23 events signed by your key — we just render
            them beautifully at <code>you.nbread.lol</code>.
          </p>
          <p class="landing-cta">
            <a class="cta-button" href="/login">
              Sign in with Nostr
            </a>
            <a class="cta-secondary" href="/discover">
              Discover blogs →
            </a>
          </p>
        </div>

        <ul class="feature-list">
          <li>
            <strong>Your keys, your words</strong> — every post is a signed
            event on public relays; leave any time and take everything with
            you.
          </li>
          <li>
            <strong>A real blog, not a feed</strong> — a clean site at{" "}
            <code>handle.nbread.lol</code> with RSS, Atom, and a sitemap.
          </li>
          <li>
            <strong>Free NIP-05</strong> — be{" "}
            <code>handle@nbread.lol</code> everywhere on Nostr.
          </li>
          <li>
            <strong>Write anywhere</strong> — the built-in markdown editor
            with NIP-07 signing, or any Nostr client; your blog stays in sync
            with the relays.
          </li>
          <li>
            <strong>Make it yours</strong> — custom theme CSS, no build step
            required.
          </li>
          <li>
            <strong>No ads, no trackers, no JavaScript on blogs</strong> —
            tiny pages, fast everywhere.
          </li>
        </ul>

        <p class="landing-links">
          <a href="/discover">Discover recent posts</a> ·{" "}
          <a href="/search">Search</a> · <a href="/docs">Docs</a>
        </p>
      </main>
      <SiteFooter />
    </Layout>
  );
}
