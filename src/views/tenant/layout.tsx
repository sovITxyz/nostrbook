import type { Child } from "hono/jsx";
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
  themeCss?: string;
  basePath?: string;
  children?: Child;
}) {
  const base = props.basePath ?? "";
  const css = sanitizeCss(props.themeCss ?? "");
  const name = props.profile?.name?.trim() || `@${props.handle}`;
  const picture = safeHttpUrl(props.profile?.picture);
  const about = props.profile?.about?.trim() || null;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
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
            <a href={`https://${props.mainHost}/`}>Nostrbook</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
