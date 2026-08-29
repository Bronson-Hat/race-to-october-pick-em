# Hat Trick Sportsbook Worker

This directory contains the Cloudflare Worker behind the Race to October Pick 'Em game.

## Production resources

- Worker: `hat-trick-sportsbook`
- D1 binding: `DB`
- D1 database: `hat-trick-sportsbook`
- Public variable: `CUSTOMER_ACCOUNT_CLIENT_ID`
- Encrypted secret retained in Cloudflare: `HASH_PEPPER`

The encrypted secret is intentionally not stored in Git. A normal Wrangler or Cloudflare Builds deployment preserves the existing production secret unless it is explicitly changed or deleted in Cloudflare.

## Local checks

```sh
npm install
npm run check
```

For local development, copy `.dev.vars.example` to `.dev.vars` and replace the placeholder with a local-only value.

## Deployment

Until Cloudflare Builds is connected, deploy from this directory with:

```sh
npm run deploy
```

The Worker name in `wrangler.jsonc` must remain `hat-trick-sportsbook` so deployments update the existing Worker rather than creating a second one.
