import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";
import {
  PROFILE_FIELD_MAX,
  type ProfileContentFields,
} from "../../services/profiles";

/**
 * Profile editor page (apex, session required): edit and publish the user's
 * Nostr kind 0 metadata. Exactly like the post editor, all signing happens
 * client-side (public/js/profile.js through NbreadSigner); this page ships
 * the form prefilled from the stored profile plus a JSON config blob. The
 * picture/banner fields get a Blossom upload button (public/js/blossom.js).
 *
 * XSS notes: every prefill value renders through hono/jsx auto-escaping
 * (profile fields are relay-sourced and hostile by assumption). The config
 * JSON is embedded in a non-executable script tag with every `<` escaped so
 * a crafted relay URL can never break out with `</script>`.
 */
export function ProfilePage(props: {
  pubkey: string;
  handle: string | null;
  mainHost: string;
  fields: ProfileContentFields;
  extra: Record<string, unknown>; // non-form kind 0 keys, preserved on publish
  prevCreatedAt: number | null; // stored kind 0's created_at (edit must exceed it)
  relays: string[];
  settingsAboutSet: boolean; // dashboard "About" setting shadows the kind-0 about
  published: boolean;
}) {
  const config = {
    pubkey: props.pubkey,
    relays: props.relays,
    prevCreatedAt: props.prevCreatedAt,
    extra: props.extra,
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const suggestedNip05 = props.handle
    ? `${props.handle}@${props.mainHost}`
    : null;
  const f = props.fields;

  return (
    <Layout title="Edit profile — nbread.lol">
      <SiteHeader variant="app" />
      <main>
        <h1>Edit profile</h1>
        <p>
          <a href="/dashboard">&larr; Dashboard</a>
        </p>
        <p>
          Your public Nostr profile (a <code>kind 0</code> event). Publishing
          signs it with your key and broadcasts it to your relays — it updates
          your blog header here and everywhere else on Nostr.
        </p>

        {props.published ? (
          <p class="settings-saved" role="status">
            Profile published.
          </p>
        ) : null}

        <form id="profile-form" class="profile-form">
          <p>
            <label>
              Name
              <br />
              <input
                id="profile-name"
                name="name"
                type="text"
                maxlength={PROFILE_FIELD_MAX.name}
                value={f.name}
                placeholder="satoshi"
              />
            </label>
          </p>
          <p>
            <label>
              Display name
              <br />
              <input
                id="profile-display-name"
                name="display_name"
                type="text"
                maxlength={PROFILE_FIELD_MAX.display_name}
                value={f.display_name}
                placeholder="Satoshi Nakamoto"
              />
            </label>
          </p>
          <p>
            <label>
              About
              <br />
              {/* Protective leading "\n" (the HTML parser eats one) so a bio
                  that begins with a newline survives the edit round-trip. */}
              <textarea
                id="profile-about"
                name="about"
                rows={4}
                cols={60}
                maxlength={PROFILE_FIELD_MAX.about}
                placeholder="A few lines about you"
              >
                {"\n" + f.about}
              </textarea>
            </label>
            {props.settingsAboutSet ? (
              <>
                <br />
                <small>
                  Note: the “About” text in your blog settings currently
                  overrides this bio in your blog header. Clear it there if you
                  want this one shown.
                </small>
              </>
            ) : null}
          </p>
          <p>
            <label>
              Picture (avatar URL)
              <br />
              <input
                id="profile-picture"
                name="picture"
                type="text"
                maxlength={PROFILE_FIELD_MAX.picture}
                value={f.picture}
                placeholder="https://…"
                spellcheck={false}
              />
            </label>{" "}
            <button
              type="button"
              class="profile-upload"
              data-upload-target="profile-picture"
            >
              Upload image
            </button>
            <input
              id="profile-picture-file"
              data-upload-for="profile-picture"
              type="file"
              accept="image/*"
              hidden
            />
          </p>
          <p>
            <label>
              Banner (header image URL)
              <br />
              <input
                id="profile-banner"
                name="banner"
                type="text"
                maxlength={PROFILE_FIELD_MAX.banner}
                value={f.banner}
                placeholder="https://…"
                spellcheck={false}
              />
            </label>{" "}
            <button
              type="button"
              class="profile-upload"
              data-upload-target="profile-banner"
            >
              Upload image
            </button>
            <input
              id="profile-banner-file"
              data-upload-for="profile-banner"
              type="file"
              accept="image/*"
              hidden
            />
          </p>
          <p>
            <label>
              Website
              <br />
              <input
                id="profile-website"
                name="website"
                type="text"
                maxlength={PROFILE_FIELD_MAX.website}
                value={f.website}
                placeholder="https://…"
                spellcheck={false}
              />
            </label>
          </p>
          <p>
            <label>
              NIP-05 identifier
              <br />
              <input
                id="profile-nip05"
                name="nip05"
                type="text"
                maxlength={PROFILE_FIELD_MAX.nip05}
                value={f.nip05 === "" && suggestedNip05 ? suggestedNip05 : f.nip05}
                placeholder="you@example.com"
                spellcheck={false}
              />
            </label>
            {suggestedNip05 ? (
              <>
                <br />
                <small>
                  <code>{suggestedNip05}</code> is already verified for your
                  handle here — keep it, or point it anywhere else you verify.
                </small>
              </>
            ) : null}
          </p>
          <p>
            <label>
              Lightning address (lud16)
              <br />
              <input
                id="profile-lud16"
                name="lud16"
                type="text"
                maxlength={PROFILE_FIELD_MAX.lud16}
                value={f.lud16}
                placeholder="you@walletofsatoshi.com"
                spellcheck={false}
              />
            </label>
            <br />
            <small>Lets readers send you sats (zaps).</small>
          </p>
          <p>
            <label>
              LNURL (lud06)
              <br />
              <input
                id="profile-lud06"
                name="lud06"
                type="text"
                maxlength={PROFILE_FIELD_MAX.lud06}
                value={f.lud06}
                placeholder="lnurl1…"
                spellcheck={false}
              />
            </label>
          </p>

          <p class="profile-actions">
            <button id="profile-publish" type="button">
              Sign &amp; publish profile
            </button>
          </p>
        </form>
        <p id="profile-status" role="status" aria-live="polite"></p>

        <script
          type="application/json"
          id="profile-config"
          dangerouslySetInnerHTML={{ __html: configJson }}
        ></script>
        <script src="/js/vendor/nostr-crypto.js"></script>
        <script src="/js/signer-core.js"></script>
        <script src="/js/signer.js"></script>
        <script src="/js/signer-nip46.js"></script>
        <script src="/js/blossom.js"></script>
        <script src="/js/profile.js"></script>
      </main>
      <SiteFooter />
    </Layout>
  );
}
