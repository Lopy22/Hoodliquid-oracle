# HoodLiquid Oracle

HoodLiquid Oracle is a standalone, reproducible pricing node for the seven
markets used by HoodLiquid. It collects upstream card observations, validates
and smooths them, stores accepted marks in PostgreSQL, and exposes the marks
through a small read-only API.

This repository is not a decentralized oracle network and is not an authorized
HoodLiquid reporter. It deliberately contains no blockchain private keys,
contracts, EIP-712 signing, transaction outbox, relayer, indexer, automation, or
on-chain publication code.

## Data flow and trust boundary

~~~text
TCGPlayer Near Mint English ----+
                                |
PokeTrace optional corroboration+--> freshness / floors / quorum
                                |             |
PokeLiquid PL500 (testnet) -----+             v
                                         adaptive EWMA
                                               |
                                               v
                          PostgreSQL observations + marks + candles
                                               |
                                     +---------+---------+
                                     |                   |
                                read-only REST       status CLI

  This public repository stops here.
  ---------------------------------- private HoodLiquid boundary
       report construction -> EIP-712 reporter signature -> relayer -> chain
~~~

Running this node reproduces the off-chain pricing process. It does not give the
node authority to publish prices to HoodLiquid. HoodLiquid's private reporter
and relayer independently consume reviewed price data, sign chain-bound reports,
and submit transactions. Those components are intentionally excluded.

## Supported networks and markets

One running instance is bound to one chain ID and one database:

| Network | Chain ID | PL500 behavior |
| --- | ---: | --- |
| Robinhood Chain | 4663 | Disabled until all 500 mappings and exactly 8 approved snapshots are complete |
| Robinhood Chain Testnet | 46630 | May use the public PokeLiquid PL500 observation |

The committed registry contains these seven presets:

| Market | Type | Floor (USD) | Default card source |
| --- | --- | ---: | --- |
| PL500 | Index | 10,000 | PokeLiquid on testnet; complete constituent basket on mainnet |
| CHARIZARD-X | Card | 100 | TCGPlayer Near Mint English |
| CHARIZARD-151 | Card | 50 | TCGPlayer Near Mint English |
| CHARIZARD-VSTAR-SWSH262 | Card | 5 | TCGPlayer Near Mint English |
| CHARIZARD-EX-SIR-OF | Card | 10 | TCGPlayer Near Mint English |
| MEGA-CHARIZARD-X-023 | Card | 5 | TCGPlayer Near Mint English |
| CHARIZARD-BS | Card | 50 | TCGPlayer Near Mint English |

The public PL500 file contains all 500 rows and the current seed list, but it
currently contains 0 TCGPlayer mappings and 0 approved snapshot exceptions.
Its seed sum is indicative only and is never accepted as a tradable mark.
Mainnet PL500 therefore remains unavailable as committed.

## Compliance requirement for TCGPlayer

TCGPlayer's Terms of Service prohibit scraping without express permission, and
its API has separate purpose and usage restrictions. Review the
[TCGPlayer Terms of Service](https://help.tcgplayer.com/hc/en-us/articles/205004918-Terms-of-Service)
and [TCGPlayer API Terms](https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions)
before selecting a collection method.

Playwright collection is disabled by a mandatory acknowledgement gate. It runs
only when both values are configured:

~~~dotenv
ORACLE_TCGPLAYER_SOURCE=playwright
ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED=true
~~~

Set the confirmation only after obtaining the permission required for your use.
The flag records an operator acknowledgement; it does not itself grant
permission. The project does not implement CAPTCHA solving, anti-bot bypass,
proxy rotation, fingerprint evasion, or detection bypass.

An approved TCGPlayer API bearer token can be used instead:

~~~dotenv
ORACLE_TCGPLAYER_SOURCE=api
TCGPLAYER_BEARER_TOKEN=your-approved-token
~~~

## Docker quickstart

Requirements: Docker Engine with Compose v2.

~~~bash
cp .env.example .env
~~~

Add a PostgreSQL password to the new file:

~~~dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
~~~

Then select an upstream mode. For approved Playwright use, set the explicit
permission confirmation. For approved API use, select API and provide the
token. Start the stack:

~~~bash
docker compose up --build
~~~

Compose starts PostgreSQL 16, runs migrations once, then starts the ingestion
worker and API. It binds the API to loopback port 8080 by default.

~~~bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/api/v1/46630/prices
docker compose logs -f ingest
~~~

Readiness returns HTTP 503 until a permitted source is configured, a successful
ingestion cycle has completed, and every enabled market has a fresh accepted
mark.

## Native Node.js and PM2

Requirements:

- Node.js 22
- PostgreSQL 16
- Playwright Chromium when Playwright mode is selected
- PM2 for the optional service manager workflow

Create a database and environment file:

~~~bash
createdb hoodliquid_oracle_testnet
cp .env.example .env
npm ci
npx playwright install chromium
~~~

On Ubuntu, install Playwright's browser and OS dependencies together:

~~~bash
npx playwright install --with-deps chromium
~~~

Edit DATABASE_URL and the source settings in .env, then run:

~~~bash
npm run db:migrate
npm run oracle:once
npm run oracle:check
npm run oracle:status
~~~

For long-running native services:

~~~bash
npm run oracle:watch
npm run api
~~~

They can instead be managed by PM2. Put production values in
.env.production and run:

~~~bash
NODE_ENV=production npm run db:migrate
npm run pm2:start
pm2 logs hoodliquid-oracle-ingest-rh-testnet
pm2 save
~~~

The PM2 file runs one API and one ingestion process. PostgreSQL advisory locks
ensure that only one ingestion leader operates for a database even if a second
worker is accidentally started.

### Running testnet and mainnet together

Use separate databases, environment files, API ports, and PM2 process sets.
Do not point both chain IDs at the same database. A testnet instance uses
CHAIN_ID 46630. A mainnet instance uses CHAIN_ID 4663 and must set
ORACLE_PL500_SOURCE to constituents; PL500 will stay disabled until the
committed mapping gate is complete. The other six registry markets can operate
independently of that PL500 gate.

The PM2 file derives unique process names from CHAIN_ID. To launch two copies
from one checkout, provide each environment file explicitly:

~~~bash
ENV_FILE=.env.testnet.production npm run pm2:start
ENV_FILE=.env.mainnet.production npm run pm2:start
~~~

## Commands

| Command | Purpose |
| --- | --- |
| npm run db:migrate | Apply idempotent PostgreSQL migrations |
| npm run oracle:check | Print readiness and exit nonzero when not ready |
| npm run oracle:once | Run one authoritative database ingestion cycle |
| npm run oracle:watch | Run database ingestion on the configured cadence |
| npm run oracle:status | Print worker lease, latest run, and mark ages |
| npm run oracle:scrape | Write non-authoritative local JSON diagnostics |
| npm run api | Start the read-only REST API |
| npm run pm2:start | Start API and ingestion under PM2 |
| npm test | Run fixture-only unit/API tests; no upstream network calls |
| npm run test:integration | Run destructive tests against an explicitly named test database |

The diagnostic scrape command may create ignored JSON caches in data/oracle.
Those files are never authoritative and must not be committed.

## Public API

Only three routes are exposed:

~~~text
GET /health/live
GET /health/ready
GET /api/v1/{chainId}/prices
~~~

Only chain IDs 4663 and 46630 are valid, and an instance answers price requests
only for its configured chain.

Example price response:

~~~json
{
  "chainId": 46630,
  "priceScale": 1000000,
  "updatedAt": "2026-07-15T00:00:00.000Z",
  "prices": {
    "CHARIZARD-X": {
      "price": "854250000",
      "rawPrice": "855000000",
      "priceUsd": 854.25,
      "rawPriceUsd": 855,
      "confidenceBps": 9500,
      "source": "tcgplayer-playwright",
      "sourceCount": 1,
      "sourceHash": "0x...",
      "observedAt": 1784073600,
      "observedAtIso": "2026-07-15T00:00:00.000Z",
      "smoothing": {
        "status": "accepted",
        "tier": "direct",
        "alpha": 1
      },
      "sourceMetadata": {},
      "stale": false,
      "tradable": true
    }
  }
}
~~~

The integer strings are authoritative fixed-precision values. The USD numbers
are display-only conversions.

## Pricing methodology

### Acquisition and source selection

The six card markets target their registry-specific TCGPlayer product and the
Near Mint, English condition. The default primary is TCGPlayer. PokeTrace can
optionally corroborate it using sold-listing EWAP when that endpoint is
available, or the documented aggregate fallback. ORACLE_PRIMARY_SOURCE can
explicitly select PokeTrace first.

Default quorum is one. A second independent source counts toward quorum only
when its deviation from the selected quote is no more than
ORACLE_MAX_SOURCE_DEVIATION_BPS, which defaults to 3000 basis points. Divergent
secondary observations are stored as rejected observations and do not increase
the accepted source count.

### Floors and adaptive EWMA

All USD values use fixed precision of 1e6. A raw observation below its market
floor is rejected. When a prior accepted quote exists, rejection preserves both
the old price and old observation timestamp, so a failed source never makes
stale data appear fresh.

For the absolute deviation from the previous mark:

| Deviation | Alpha | Mode |
| --- | ---: | --- |
| Less than 3% | 1 | Direct |
| 3% to less than 5% | 0.3 | Moderate |
| 5% through 15% | 0.1 | Heavy |
| Greater than 15% | 0.01 | Spike rejection |

The next mark is alpha multiplied by the raw price plus one minus alpha
multiplied by the previous mark, rounded to fixed precision.

### Confidence and provenance

Default confidence values are:

| Source | Confidence (basis points) |
| --- | ---: |
| PokeLiquid | 8500 |
| TCGPlayer API or Playwright | 9500 |
| PokeTrace sold-listing EWAP | 9750 |
| PokeTrace aggregate | 9400 |
| Approved snapshot | 9000 |
| Indicative PL500 seed list | 0 |

Each accepted source hash is SHA-256 over a stable serialization of market,
source, raw price, smoothed price, and source observation time. Repeated
observations are idempotent.

### PL500

On testnet, ORACLE_PL500_SOURCE may be pokeliquid-api. The node requests the
latest public PokeLiquid PL500 row without authentication and rejects missing,
nonpositive, stale, or more-than-five-minutes-future observations. It also
requires the transaction signature field to look like a 60-to-100-character
Base58 Solana signature.

That is signature-format-only validation. This repository does not
cryptographically verify the signature, transaction contents, account identity,
or the upstream computation. PokeLiquid is an unauthenticated external
dependency and its observation receives a lower confidence value before the
local adaptive EWMA is applied.

On mainnet, the external PokeLiquid shortcut is never enabled. A constituent
index becomes live only when the file has exactly 500 usable rows and exactly 8
approved snapshot exceptions. Until then, the seed sum is marked indicative,
non-tradable, and excluded from accepted marks.

## PostgreSQL model

The database is authoritative for this repository and contains only:

- schema_migrations and markets
- source_observations and source_state
- oracle_marks and oracle_mark_history
- candles
- worker_leases and worker_runs

Source observations and mark history are partitioned monthly. Raw observations,
raw mark history, and one-minute candles are retained for 90 days. Hourly and
daily candles remain available. Price integers use numeric(78,0).

Useful inspection commands:

~~~bash
psql "$DATABASE_URL" -c "select market_id,price,source,observed_at from oracle_marks order by market_id"
psql "$DATABASE_URL" -c "select worker,success,started_at,finished_at,details from worker_runs order by id desc limit 10"
psql "$DATABASE_URL" -c "select market_id,source,accepted,rejection_reason,observed_at from source_observations order by observed_at desc limit 25"
psql "$DATABASE_URL" -c "select market_id,interval_seconds,bucket,open,high,low,close from candles order by bucket desc limit 25"
~~~

## Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| CHAIN_ID | none | Required: 4663 or 46630 |
| DATABASE_URL | none | Required PostgreSQL connection string |
| HOST | 127.0.0.1 | API listen address |
| PORT | 8080 | API listen port |
| PG_SSL | false | Enable PostgreSQL TLS |
| PG_POOL_MAX | 10 | Maximum connections per process |
| ORACLE_SCRAPE_INTERVAL_MS | 60000 | Worker cadence; minimum practical cadence is 60 seconds |
| ORACLE_MARK_MAX_AGE_SECONDS | 1800 | Freshness used by readiness and REST |
| ORACLE_SOURCE_QUORUM | 1 | Required accepted independent sources |
| ORACLE_MAX_SOURCE_DEVIATION_BPS | 3000 | Secondary-source deviation bound |
| ORACLE_MARKETS | ALL | Comma-separated market/product filter |
| ORACLE_SCRAPE_CONCURRENCY | 22 | Parallel product collection, from 1 to 100 |
| ORACLE_TCGPLAYER_SOURCE | playwright | playwright, api, or auto |
| ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED | false | Mandatory acknowledgement for Playwright |
| ORACLE_HEADLESS | true | Playwright browser mode |
| TCGPLAYER_BEARER_TOKEN | empty | Approved API bearer token |
| TCGPLAYER_PUBLIC_KEY / TCGPLAYER_PRIVATE_KEY | empty | Approved API OAuth credentials |
| POKETRACE_API_KEY | empty | Enables optional PokeTrace corroboration |
| ORACLE_PRIMARY_SOURCE | tcgplayer | tcgplayer or poketrace |
| ORACLE_POKETRACE_POLL_INTERVAL_MS | 900000 | PokeTrace polling cadence |
| ORACLE_POKETRACE_MAX_AGE_SECONDS | 1800 | Maximum corroboration age |
| ORACLE_POKETRACE_USE_LISTINGS | true | Try the sold-listings endpoint; false uses aggregate mode |
| ORACLE_PL500_SOURCE | pokeliquid-api | pokeliquid-api, constituents, or disabled |
| ORACLE_POKELIQUID_MAX_AGE_SECONDS | 900 | Testnet upstream age limit |
| ORACLE_PRICE_FLOORS | data/oracle/price-floors.json | Optional floor file override |
| ORACLE_MARKET_REGISTRY | data/oracle/market-registry.json | Optional registry override |
| ORACLE_PL500_CONSTITUENTS | data/oracle/pl500-constituents.json | Optional PL500 file override |

## Customizing markets

Edit data/oracle/market-registry.json for market identity, source product,
condition, floor, and display metadata. Keep priceApiMarket unique and preserve
positive floors. Update data/oracle/price-floors.json as an auditable mirror.
For PL500, edit data/oracle/pl500-constituents.json and use the included
resolver only with approved API access:

~~~bash
node scripts/resolve-pl500-tcgplayer-ids.cjs --dry-run
~~~

Run npm test after every registry change. Mainnet PL500 will not activate unless
the exact 500-usable-row and 8-snapshot gate passes.

## Testing

Automated tests use recorded in-memory fixtures and never contact TCGPlayer,
PokeTrace, or PokeLiquid. Run:

~~~bash
npm run check
~~~

PostgreSQL integration tests reset the public schema, so they refuse any
database whose name does not contain the word test:

~~~bash
createdb hoodliquid_oracle_test
RUN_POSTGRES_TESTS=true \
TEST_DATABASE_URL=postgresql:///hoodliquid_oracle_test \
npm test
~~~

CI performs syntax checks, fixture tests, PostgreSQL 16 integration tests,
secret-pattern checks, dependency audit, Compose validation, and a container
build.

## Troubleshooting

Readiness says permission confirmation is missing:

- Obtain the required upstream permission, then set the confirmation to true;
  or configure approved API mode and credentials.

No accepted mark appears:

- Run npm run oracle:status.
- Inspect rejected source_observations and their rejection_reason.
- Check the floor, freshness, source quorum, and deviation settings.
- Confirm PostgreSQL migrations ran against the same DATABASE_URL.

PL500 is absent on mainnet:

- This is intentional while the committed constituent mapping is incomplete.
- Do not select PokeLiquid as a mainnet shortcut.

Worker says an active leader exists:

- Another process holds the PostgreSQL advisory lock. Stop the duplicate rather
  than deleting worker_leases; the table is descriptive and is not the lock.

Playwright cannot launch:

- Run npx playwright install --with-deps chromium on Linux.

## Security, attribution, and licensing

The node requires no blockchain private key. Never add reporter, relayer,
deployer, wallet, or mnemonic material. Keep database passwords and upstream API
credentials in ignored environment files or a secret manager. Bind the API to
loopback behind your own authenticated/restricted reverse proxy when required.

Source names and market/product references belong to their respective owners.
TCGPlayer, PokeTrace, PokeLiquid, Pokémon, Robinhood, and any other referenced
services do not endorse this repository. Operators are responsible for their
own contractual, legal, data-protection, and licensing obligations.

The MIT license covers this repository's code only. It does not license
third-party data, trademarks, images, APIs, website content, or upstream
services, and it does not grant permission to scrape or use any third-party
source.
