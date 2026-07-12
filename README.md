# Nostrbook

Nostr-native blogging platform. Your posts are [NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md)
`kind 30023` events signed by **your** key — Nostrbook mirrors them into a fast
edge database and renders them beautifully at `you.nostrbook.net`.

- **Own your words**: every post is a signed Nostr event; Nostrbook is just a
  renderer. Take your key elsewhere any time and your blog comes with you.
- **No accounts, no passwords**: log in with a NIP-07 browser extension.
- **Fast + minimal**: one Cloudflare Worker, server-side rendering, no
  client-side framework, aggressive edge caching.

## Stack

Cloudflare Worker + Static Assets, [Hono](https://hono.dev) with `hono/jsx`
SSR, D1 (SQLite) mirror + FTS5 search, KV for sessions, TypeScript strict,
Vitest with `@cloudflare/vitest-pool-workers`.

## Development

```sh
npm install
npm run dev            # wrangler dev on http://127.0.0.1:8787
npm run typecheck      # tsc --noEmit
npm test               # vitest (Workers pool, real D1/KV bindings)
npm run smoke          # boots wrangler dev and curls the endpoints
npm run migrate:local  # apply D1 migrations to the local database
npm run fixtures       # regenerate committed test fixtures (throwaway keys)
```

Deployment/DNS setup: see [docs/setup.md](docs/setup.md).
Operations (rate limits, WAF, incident notes, deploy gates, blocklist
admin): see [docs/ops.md](docs/ops.md).
Phase-by-phase build plan: see [docs/phases/](docs/phases/).

## License

Copyright (C) 2026 sovITxyz <git@sovit.xyz>

[AGPL-3.0-only](LICENSE). If you run a modified Nostrbook as a service, you
must offer its source to your users.
