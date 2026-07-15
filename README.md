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
TCGPlayer Near Mint English -----+
                                 |
PokeTrace optional corroboration +--> freshness / floors / quorum
                                 |             |
HoodLiquid 500-card basket ------+             v
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

| Network | Chain ID | HL500 behavior |
| --- | ---: | --- |
| Robinhood Chain | 4663 | Disabled until all 500 mappings and exactly 8 approved snapshots are complete |
| Robinhood Chain Testnet | 46630 | Uses the same HoodLiquid constituent-completeness gate |

The committed registry contains these seven presets:

| Market | Type | Floor (USD) | Default card source |
| --- | --- | ---: | --- |
| HL500 | Index | 10,000 | HoodLiquid's reviewed 500-card constituent basket |
| CHARIZARD-X | Card | 100 | TCGPlayer Near Mint English |
| CHARIZARD-151 | Card | 50 | TCGPlayer Near Mint English |
| CHARIZARD-VSTAR-SWSH262 | Card | 5 | TCGPlayer Near Mint English |
| CHARIZARD-EX-SIR-OF | Card | 10 | TCGPlayer Near Mint English |
| MEGA-CHARIZARD-X-023 | Card | 5 | TCGPlayer Near Mint English |
| CHARIZARD-BS | Card | 50 | TCGPlayer Near Mint English |

The public HL500 file contains all 500 rows and the current seed list, but it
currently contains 0 TCGPlayer mappings and 0 approved snapshot exceptions.
Its seed sum is indicative only and is never accepted as a tradable mark.
HL500 therefore remains unavailable on both networks as committed.

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
The PostgreSQL container automatically creates the `hoodliquid_oracle` role
and `hoodliquid_oracle` database from `POSTGRES_USER` and `POSTGRES_DB`; the
manual role-creation steps below are only for a native PostgreSQL installation.

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

On Ubuntu, install and start PostgreSQL 16 before creating the role (use the
PostgreSQL upstream repository if your Ubuntu release does not provide 16):

~~~bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql
~~~

On macOS with Homebrew:

~~~bash
brew install postgresql@16
brew services start postgresql@16
~~~

Create the PostgreSQL login role and testnet database before running a
migration. The role name in the example `DATABASE_URL` is not created by npm.
Open PostgreSQL as its administrative user:

~~~bash
sudo -u postgres psql
~~~

On macOS with a Homebrew PostgreSQL installation, the equivalent is usually
`psql postgres` under the macOS user that installed PostgreSQL. Run the
following SQL inside `psql`; replace the example password first:

~~~sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hoodliquid_oracle') THEN
    CREATE ROLE hoodliquid_oracle LOGIN;
  END IF;
END
$$;

ALTER ROLE hoodliquid_oracle WITH PASSWORD 'replace-with-a-long-random-password';

SELECT 'CREATE DATABASE hoodliquid_oracle_testnet OWNER hoodliquid_oracle'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'hoodliquid_oracle_testnet'
)\gexec

REVOKE ALL ON DATABASE hoodliquid_oracle_testnet FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE hoodliquid_oracle_testnet TO hoodliquid_oracle;
\connect hoodliquid_oracle_testnet
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO hoodliquid_oracle;
\quit
~~~

The role owns the database, so it can create the tables, partitions, indexes,
and migration ledger. Test the exact credentials before installing the app:

~~~bash
PGPASSWORD='replace-with-a-long-random-password' \
psql -h 127.0.0.1 -U hoodliquid_oracle -d hoodliquid_oracle_testnet \
  -c 'select current_user, current_database();'
~~~

Then create the environment file and install dependencies:

~~~bash
cp .env.example .env
npm ci
npx playwright install chromium
~~~

On Ubuntu, install Playwright's browser and OS dependencies together:

~~~bash
npx playwright install --with-deps chromium
~~~

Set `.env` to the same password and database. Percent-encode any characters in
the password that have special meaning in a URL:

~~~dotenv
CHAIN_ID=46630
DATABASE_URL=postgresql://hoodliquid_oracle:replace-with-a-long-random-password@127.0.0.1:5432/hoodliquid_oracle_testnet
~~~

Then run the migration and one ingestion cycle:

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
`CHAIN_ID=46630`. A mainnet instance uses `CHAIN_ID=4663`; HL500 will stay
unavailable until the committed mapping gate is complete. The other six
registry markets can operate independently of that gate. Create a separate
mainnet database (and preferably a separate production login role) using the
SQL procedure above.

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
| Complete HoodLiquid HL500 basket | 9500 |
| TCGPlayer API or Playwright | 9500 |
| PokeTrace sold-listing EWAP | 9750 |
| PokeTrace aggregate | 9400 |
| Approved snapshot | 9000 |
| Indicative HL500 seed list | 0 |

Each accepted source hash is SHA-256 over a stable serialization of market,
source, raw price, smoothed price, and source observation time. Repeated
observations are idempotent.

### HL500

HL500 is HoodLiquid's own fixed 500-card index on both networks. The worker
loads `data/oracle/hl500-constituents.json`, obtains each reviewed constituent's
TCGPlayer observation (or one of exactly eight approved snapshot exceptions),
applies row-level smoothing, and sums the 500 accepted USD marks into the raw
index value. The index then passes the same floor and adaptive-EWMA rules as the
other markets.

The index becomes authoritative only when the file contains exactly 500 usable
rows: 492 reviewed TCGPlayer product mappings and exactly 8 approved snapshots.
There is no external index fallback. Until that gate passes, the seed sum is
marked `hoodliquid-hl500-seed`, has zero confidence, is non-tradable, and is
excluded from accepted marks and on-chain publication.

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
| ORACLE_HL500_ENABLED | true | Enables HL500 evaluation; completeness remains mandatory |
| ORACLE_PRICE_FLOORS | data/oracle/price-floors.json | Optional floor file override |
| ORACLE_MARKET_REGISTRY | data/oracle/market-registry.json | Optional registry override |
| ORACLE_HL500_CONSTITUENTS | data/oracle/hl500-constituents.json | Optional HL500 file override |

## Customizing markets

Edit data/oracle/market-registry.json for market identity, source product,
condition, floor, and display metadata. Keep priceApiMarket unique and preserve
positive floors. Update data/oracle/price-floors.json as an auditable mirror.
For HL500, edit data/oracle/hl500-constituents.json and use the included
resolver only with approved API access:

~~~bash
node scripts/resolve-hl500-tcgplayer-ids.cjs --dry-run
~~~

Run npm test after every registry change. Mainnet HL500 will not activate unless
the exact 500-usable-row and 8-snapshot gate passes.

## Testing

Automated tests use recorded in-memory fixtures and never contact TCGPlayer or
PokeTrace. Run:

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

HL500 is absent on testnet or mainnet:

- This is intentional while the committed constituent mapping is incomplete.
- Complete and review all 492 product mappings and 8 snapshot exceptions.

Migration says role `hoodliquid_oracle` does not exist:

- `npm run db:migrate` creates tables inside an existing database; it does not
  create PostgreSQL server roles or databases.
- Run the role/database SQL in the Native Node.js section as a PostgreSQL
  administrator, then verify the exact `DATABASE_URL` with `psql`.

Migration says permission denied for the database or schema:

- As an administrator, grant `CONNECT` on the database and `USAGE, CREATE` on
  its `public` schema as shown above.
- Confirm the database owner with
  `psql postgres -c "select datname, pg_get_userbyid(datdba) from pg_database where datname='hoodliquid_oracle_testnet'"`.

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
TCGPlayer, PokeTrace, Pokémon, Robinhood, and any other referenced
services do not endorse this repository. Operators are responsible for their
own contractual, legal, data-protection, and licensing obligations.

The MIT license covers this repository's code only. It does not license
third-party data, trademarks, images, APIs, website content, or upstream
services, and it does not grant permission to scrape or use any third-party
source.
