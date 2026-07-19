import type { Child } from "hono/jsx";
import { FAVICON_HREF } from "../brand";
import { sanitizeCss } from "../../markdown/css-sanitize";
import { safeHttpUrl } from "../../markdown/sanitize";

/**
 * Blog profile header data (from the owner's kind 0 event). All fields are
 * untrusted relay content: text renders through hono/jsx auto-escaping, and
 * the picture URL must pass safeHttpUrl before reaching an attribute.
 */
export type BlogProfile = {
  name: string | null;
  picture: string | null;
  about: string | null;
  /** Lightning address from the kind 0 (zap affordance) — untrusted; views
   *  must gate on safeLud16 before building any href from it. */
  lud16: string | null;
};

/**
 * Base layout for blog (tenant) pages: profile header + sanitized per-blog
 * theme CSS. `themeCss` is sanitized HERE (last gate before the <style> tag)
 * regardless of what callers pass.
 *
 * `basePath` prefixes all blog-internal links ("" on subdomains; "/npub1…"
 * when the same views render an unclaimed blog under the apex).
 */
export function BlogLayout(props: {
  title: string;
  handle: string;
  mainHost: string;
  profile: BlogProfile | null;
  /**
   * Dashboard-configured about blurb (users.settings.$.about). When non-empty
   * it OVERRIDES the kind-0 profile's about, so the setting the owner types in
   * the dashboard actually shows on their blog; otherwise the profile about
   * (relay-sourced kind 0) is used. Both render through hono/jsx escaping.
   */
  about?: string | null;
  themeCss?: string;
  basePath?: string;
  children?: Child;
}) {
  const base = props.basePath ?? "";
  const css = sanitizeCss(props.themeCss ?? "");
  const name = props.profile?.name?.trim() || `@${props.handle}`;
  const picture = safeHttpUrl(props.profile?.picture);
  const about =
    props.about?.trim() || props.profile?.about?.trim() || null;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" type="image/svg+xml" href={FAVICON_HREF} />
        <link rel="stylesheet" href="/css/style.css" />
        <link
          rel="alternate"
          type="application/rss+xml"
          title={`${name} (RSS)`}
          href={`${base}/rss.xml`}
        />
        <link
          rel="alternate"
          type="application/atom+xml"
          title={`${name} (Atom)`}
          href={`${base}/atom.xml`}
        />
        {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      </head>
      <body>
        <header class="blog-header">
          {picture ? (
            <img
              class="blog-avatar"
              src={picture}
              alt=""
              width="64"
              height="64"
            />
          ) : null}
          <p class="blog-name">
            <a href={`${base}/`}>{name}</a>
          </p>
          <p class="blog-handle">@{props.handle}</p>
          {about ? <p class="blog-about">{about}</p> : null}
        </header>
        {props.children}
        <footer class="blog-footer">
          <p>
            Published with{" "}
            <a href={`https://${props.mainHost}/`}>nbread.lol</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
