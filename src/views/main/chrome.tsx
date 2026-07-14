import { LogoMark } from "../brand";

/**
 * Shared apex-site header. `variant` picks the nav set:
 *   - "public" (default): Discover · Search · Docs · Log in
 *   - "app": Discover · Search · Dashboard
 *
 * The header is 100% static markup — /, /discover, and /search are
 * shared-cached across visitors, so nothing session-dependent may ever
 * render here. Session-gated pages (dashboard, admin) opt into "app".
 */
export function SiteHeader(props: {
  current?: "discover" | "search" | "docs";
  variant?: "public" | "app";
}) {
  const variant = props.variant ?? "public";
  const cur = (page: "discover" | "search" | "docs") =>
    props.current === page ? "page" : undefined;
  return (
    <header class="site-header">
      <a class="site-brand" href="/">
        <LogoMark size={28} /> nbread.lol
      </a>
      <nav class="site-nav-links">
        <a href="/discover" aria-current={cur("discover")}>
          Discover
        </a>
        <a href="/search" aria-current={cur("search")}>
          Search
        </a>
        {variant === "app" ? (
          <a href="/dashboard">Dashboard</a>
        ) : (
          <>
            <a href="/docs" aria-current={cur("docs")}>
              Docs
            </a>
            <a href="/login">Log in</a>
          </>
        )}
      </nav>
    </header>
  );
}

/** Shared apex-site footer: legal/docs/source links + credit line. */
export function SiteFooter() {
  return (
    <footer class="site-footer">
      <p>
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·{" "}
        <a href="/docs">Docs</a> ·{" "}
        <a href="https://github.com/sovITxyz/nbread" rel="noopener">
          Source (AGPL)
        </a>
      </p>
      <p>
        Created by{" "}
        <a href="https://sovit.xyz" rel="noopener">
          sovit.xyz
        </a>{" "}
        — inspired by{" "}
        <a href="https://herman.bearblog.dev" rel="noopener">
          Herman
        </a>
        &apos;s{" "}
        <a href="https://bearblog.dev" rel="noopener">
          Bear Blog
        </a>
        .
      </p>
    </footer>
  );
}
