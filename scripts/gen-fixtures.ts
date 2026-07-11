/**
 * Fixture generator — run once, commit the output:
 *   node --experimental-strip-types scripts/gen-fixtures.ts
 *
 * Produces test/fixtures/keys.json and test/fixtures/events.json:
 *   - 3 test keypairs (alice, bob, mallory) — THROWAWAY KEYS, never real users
 *   - signed kind 0 profiles + kind 30023 posts (markdown torture + XSS payloads)
 *   - tampered variants (bad sig / bad id / wrong pubkey)
 *   - a kind 5 delete
 *   - stale-vs-newer replaceable pair (same pubkey/kind/d-tag)
 *
 * All tests consume these committed fixtures — never generate keys at test time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from "nostr-tools/pure";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

// ---------------------------------------------------------------------------
// THROWAWAY TEST KEYS — deliberately trivial patterns. DO NOT use anywhere real.
// ---------------------------------------------------------------------------
const TEST_SECRET_KEYS: Record<string, string> = {
  alice: "01".repeat(32),
  bob: "02".repeat(32),
  mallory: "03".repeat(32),
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

type Keypair = { sk: string; skBytes: Uint8Array; pk: string };

const keys: Record<string, Keypair> = {};
for (const [name, sk] of Object.entries(TEST_SECRET_KEYS)) {
  const skBytes = hexToBytes(sk);
  keys[name] = { sk, skBytes, pk: getPublicKey(skBytes) };
}
const alice = keys["alice"]!;
const bob = keys["bob"]!;
const mallory = keys["mallory"]!;

// Fixed timestamps keep event ids stable across regenerations.
const T0 = 1700000000;

function sign(kp: Keypair, ev: EventTemplate): NostrEvent {
  return finalizeEvent(ev, kp.skBytes);
}

// --- kind 0 profiles ---------------------------------------------------------
const profiles: Record<string, NostrEvent> = {
  alice: sign(alice, {
    kind: 0,
    created_at: T0,
    tags: [],
    content: JSON.stringify({
      name: "alice-test",
      about: "Nostrbook throwaway test profile (alice)",
      picture: "https://example.com/alice.png",
      nip05: "alice@nostrbook.net",
    }),
  }),
  bob: sign(bob, {
    kind: 0,
    created_at: T0 + 1,
    tags: [],
    content: JSON.stringify({
      name: "bob-test",
      about: "Nostrbook throwaway test profile (bob)",
    }),
  }),
  mallory: sign(mallory, {
    kind: 0,
    created_at: T0 + 2,
    tags: [],
    content: JSON.stringify({
      name: "mallory-test",
      about: "Nostrbook throwaway test profile (mallory)",
    }),
  }),
};

// --- kind 30023 posts --------------------------------------------------------
const MARKDOWN_TORTURE = `# Heading 1

## Heading 2 with \`inline code\`

Paragraph with **bold**, *italic*, ~~strike~~, ==mark==, H~2~O and x^2^.

> Blockquote line one
> line two

- bullet one
- bullet two
  - nested
1. ordered
2. list

- [ ] task open
- [x] task done

\`\`\`js
const x = { a: 1 };
console.log(x);
\`\`\`

| col a | col b |
| ----- | ----- |
| 1     | 2     |

[link](https://example.com) and ![image](https://example.com/img.png)

Footnote reference[^1].

[^1]: The footnote body.

---

Final paragraph with a bare url https://example.com/bare and an emoji 🦩.
`;

const XSS_CONTENT = `# XSS torture post

<script>alert('xss-1')</script>

<img src=x onerror="alert('xss-2')">

[click me](javascript:alert('xss-3'))

<a href="javascript:alert('xss-4')">anchor</a>

<iframe src="https://evil.example.com"></iframe>

<svg onload="alert('xss-5')"></svg>

<style>body { background: url('https://evil.example.com/steal') }</style>

</style><script>alert('xss-6')</script>

<div onclick="alert('xss-7')">div handler</div>

![img](x"onerror="alert('xss-8'))

<a href="data:text/html,<script>alert('xss-9')</script>">data url</a>

\`\`\`html
<script>alert('inside-code-block-should-render-as-text')</script>
\`\`\`
`;

// NIP-01 escaping torture: every risky JSON escaping class in one signed
// event so the canonical-serialization byte-exactness is pinned by fixtures —
// the short escapes (\" \\ \b \t \n \f \r), a raw C0 control char, U+2028 and
// U+2029 line separators (legal unescaped in JSON, hostile in JS source), and
// non-BMP surrogate pairs. Lone surrogates are deliberately excluded: they
// are not representable in the UTF-8 fixture file / relay wire format.
const ESCAPING_TORTURE = `# Escaping torture

Quote " backslash \\ slash / tab \t backspace \b formfeed \f carriage-return \r end-of-line.

Raw controls: SOH \u0001 and US \u001f between words.

Line separator \u2028 and paragraph separator \u2029 inline.

Non-BMP: crab \u{1F980}, clef \u{1D11E}, family 👨‍👩‍👧‍👦, flag 🏴󠁧󠁢󠁳󠁣󠁴󠁿.
`;

const posts: Record<string, NostrEvent> = {
  aliceHello: sign(alice, {
    kind: 30023,
    created_at: T0 + 100,
    tags: [
      ["d", "hello-world"],
      ["title", "Hello world"],
      ["summary", "Alice's first Nostrbook test post"],
      ["published_at", String(T0 + 100)],
    ],
    content: "# Hello world\n\nThis is **alice**'s first post.\n",
  }),
  aliceTorture: sign(alice, {
    kind: 30023,
    created_at: T0 + 200,
    tags: [
      ["d", "markdown-torture"],
      ["title", "Markdown torture test"],
      ["summary", "Every markdown feature in one post"],
      ["published_at", String(T0 + 200)],
    ],
    content: MARKDOWN_TORTURE,
  }),
  aliceXss: sign(alice, {
    kind: 30023,
    created_at: T0 + 300,
    tags: [
      ["d", "xss-test"],
      ["title", "XSS <script>alert('title')</script> torture"],
      ["summary", "<img src=x onerror=alert('summary')>"],
      ["published_at", String(T0 + 300)],
    ],
    content: XSS_CONTENT,
  }),
  bobFirst: sign(bob, {
    kind: 30023,
    created_at: T0 + 400,
    tags: [
      ["d", "bob-first"],
      ["title", "Bob's first post"],
      ["summary", "A second author for feed/search tests"],
      ["published_at", String(T0 + 400)],
    ],
    content: "Bob writes about *relays*.\n",
  }),
  aliceEscapes: sign(alice, {
    kind: 30023,
    created_at: T0 + 450,
    tags: [
      ["d", "escaping-torture"],
      ["title", 'Escaping "torture" \t \u2028 title'],
      ["summary", "Control chars, line separators, and non-BMP in content"],
      ["published_at", String(T0 + 450)],
    ],
    content: ESCAPING_TORTURE,
  }),
};

// --- replaceable pair (same pubkey/kind/d-tag, different created_at) ----------
const replaceableStale = sign(alice, {
  kind: 30023,
  created_at: T0 + 500,
  tags: [
    ["d", "replaceable"],
    ["title", "Replaceable v1 (stale)"],
    ["published_at", String(T0 + 500)],
  ],
  content: "Version 1 — should LOSE to the newer event.\n",
});
const replaceableNewer = sign(alice, {
  kind: 30023,
  created_at: T0 + 600,
  tags: [
    ["d", "replaceable"],
    ["title", "Replaceable v2 (newer)"],
    ["published_at", String(T0 + 600)],
  ],
  content: "Version 2 — should WIN over the stale event.\n",
});

// --- kind 5 delete (alice deletes her hello-world post) -----------------------
const deleteEvent = sign(alice, {
  kind: 5,
  created_at: T0 + 700,
  tags: [
    ["e", posts["aliceHello"]!.id],
    ["a", `30023:${alice.pk}:hello-world`],
  ],
  content: "delete test",
});

// --- tampered variants ---------------------------------------------------------
const base = posts["aliceHello"]!;

// 1. bad sig: flip the last hex nibble of the signature.
const badSig: NostrEvent = {
  ...base,
  sig:
    base.sig.slice(0, -1) + (base.sig.endsWith("0") ? "1" : "0"),
};

// 2. bad id: id does not match the canonical serialization hash.
const badId: NostrEvent = {
  ...base,
  id: base.id.slice(0, -1) + (base.id.endsWith("0") ? "1" : "0"),
};

// 3. wrong pubkey: swap in bob's pubkey, recompute id so the id is internally
//    consistent, but keep alice's signature → schnorr verify must fail.
const wrongPubkeyUnsigned = { ...base, pubkey: bob.pk };
const wrongPubkey: NostrEvent = {
  ...wrongPubkeyUnsigned,
  id: getEventHash(wrongPubkeyUnsigned),
  sig: base.sig,
};

const tampered = [
  { reason: "bad_sig", event: badSig },
  { reason: "bad_id", event: badId },
  { reason: "wrong_pubkey", event: wrongPubkey },
];

// nostr-tools caches verification results on a symbol property that object
// spread copies along; a JSON round-trip strips it so verifyEvent really runs.
function stripCache<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// --- self-check ----------------------------------------------------------------
const validEvents: NostrEvent[] = [
  ...Object.values(profiles),
  ...Object.values(posts),
  replaceableStale,
  replaceableNewer,
  deleteEvent,
];
for (const ev of validEvents) {
  if (!verifyEvent(stripCache(ev))) {
    throw new Error(`self-check failed: valid event does not verify: ${ev.id}`);
  }
}
for (const t of tampered) {
  if (verifyEvent(stripCache(t.event))) {
    throw new Error(`self-check failed: tampered event (${t.reason}) verifies`);
  }
}
console.log(
  `self-check OK: ${validEvents.length} valid events verify, ${tampered.length} tampered events rejected`,
);

// --- write output ----------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(
  join(OUT_DIR, "keys.json"),
  JSON.stringify(
    {
      WARNING:
        "THROWAWAY TEST KEYS for Nostrbook fixtures only. Trivial patterns, publicly committed — NEVER use for anything real.",
      alice: { sk: alice.sk, pk: alice.pk },
      bob: { sk: bob.sk, pk: bob.pk },
      mallory: { sk: mallory.sk, pk: mallory.pk },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(OUT_DIR, "events.json"),
  JSON.stringify(
    {
      WARNING:
        "Generated by scripts/gen-fixtures.ts from throwaway test keys. Do not edit by hand.",
      profiles,
      posts,
      replaceable: { stale: replaceableStale, newer: replaceableNewer },
      delete: deleteEvent,
      tampered,
    },
    null,
    2,
  ) + "\n",
);

console.log(`fixtures written to ${OUT_DIR}`);
