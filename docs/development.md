# Development notes

Local-dev setup and the gotchas that have bitten us. None of this is needed to
*use* the app; it is for working on this repo.

## Running locally

```bash
npm install
cp .env.example .env   # then set ENCRYPTION_KEY (.env is gitignored)
npm run deploy         # creates db/passport.db: domain tables + the 23 midnight_* plugin tables
npm start              # cds-tsx serve  ->  http://localhost:4004
```

Both `PassportService` (`/api/v1/passport`) and the `@odatano/nightgate` plugin
services (`/api/v1/nightgate` plus indexer/analytics/admin) co-serve on port 4004.

## Start with `cds-tsx serve`, not `cds serve`

`npm start` runs `cds-tsx serve`. The TypeScript service implementation (tier
gating, `generatePassport`) only loads under the TS loader. Plain `cds serve`
has no TS loader and silently falls back to a generic CRUD handler with no tier
gating.

## Only one `@sap/cds` may load

`@odatano/nightgate` is installed from npm, so a fresh clone needs no sibling
repo. Only one copy of `@sap/cds` may load at a time. If you `npm link` a local
NIGHTGATE checkout instead, CAP can load `@sap/cds` from two locations ("loaded
from different locations") and the server will not bind. Use the npm dependency,
not a link.

## Deploy runs a node script

`npm run deploy` deploys the merged model via a small node script (`cds.deploy`),
not the `cds` CLI.
