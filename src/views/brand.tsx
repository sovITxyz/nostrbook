/**
 * nbread.lol brand mark: a geometric ostrich reading an open book, served as
 * a static asset (public/logo.svg) and referenced with <img>. An inline
 * <svg> would trip the findXssVectors test guard (which bans svg elements
 * in rendered documents as sanitizer defense-in-depth), so the mark ships
 * as a file: accent colors are literal with an embedded prefers-color-scheme
 * switch, and the eye/spine are true fill-rule holes so the silhouette works
 * on any background.
 */
export function LogoMark(props: { size?: number; class?: string }) {
  const size = props.size ?? 28;
  return (
    <img class={props.class} src="/logo.svg" width={size} height={size} alt="" />
  );
}

/**
 * Favicon: the same mark as a standalone SVG document, served as a static
 * asset (public/favicon.svg — colors are literal there, with an embedded
 * prefers-color-scheme switch, because a favicon cannot see page CSS vars).
 * A same-origin file keeps every page's HTML small and stays clear of the
 * data:-URL checks in the XSS-vector test guard.
 */
export const FAVICON_HREF = "/favicon.svg";
