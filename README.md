# Filecoin Pay Volume indexer

`fpv-indexer` indexes Filecoin Pay and Service Rewards Actor on-chain events,
including contracts, payment rails, settlements, token changes, fee auctions,
and service orchestrator activity. It maintains the indexing state in
PostgreSQL and calculates service orchestrators' quarterly volume according to
[FIP-0118](https://github.com/filecoin-project/FIPs/blob/master/FIPS/fip-0118.md).

The application exposes a REST API for querying calculated quarterly volumes,
indexing status, and related data, with interactive OpenAPI documentation at
the root route.

## Public instances

| Network | URL | Notes |
| --- | --- | --- |
| Filecoin Calibration | https://fpv-indexer.calibration.allocator.tech/ | FIP-0118 calibnet rehearsal; `EPOCHS_PER_QUARTER=2880` (one quarter per day), `ACTIVATION_EPOCH=4109134` |
| Filecoin Mainnet | TBD | to be stood up for the network upgrade |

Interactive OpenAPI documentation is served at the root route of each
instance. All endpoints are read-only and require no authentication.

## Deployment

The application is distributed as a Docker image. The image generates the
database types, builds the NestJS application, and runs pending Prisma
migrations before starting the API.

Build the image from the repository root:

```sh
docker build --pull -t fpv-indexer .
```

The container requires a PostgreSQL connection and the indexer configuration
listed in `.env.example`. At minimum, set `DATABASE_URL`, `ARCHIVE_RPC_URL`,
`ARCHIVE_RPC_THRESHOLD`, `ACTIVATION_EPOCH`, `EPOCHS_PER_QUARTER`, and
`SERVICE_REWARDS_ACTOR_ADDRESS`.

Back up the database before applying schema changes. The container uses
`prisma migrate deploy`.

## Self-hosting and scaling

Run exactly one active `fpv-indexer` instance for each database and indexer
configuration. `fpv-indexer` is not horizontally scalable in its current form:
the scheduled indexer runs inside every application process, and the
`isRunning` guard only prevents overlapping runs within one process. It does
not provide a distributed lock across containers.

If two instances share the same database, both can read the same
`indexer_state`, process overlapping block ranges, and write state back at the
same time. A later or stale write can overwrite the other run's progress and
leave indexing state inconsistent. Running multiple replicas therefore does
not safely provide higher indexing throughput or availability.

For self-hosting, scale the PostgreSQL instance and place a reverse proxy in
front of the single application container if needed. Horizontal application
scaling requires a coordination mechanism such as a database advisory lock or
a dedicated leader-election/indexer-worker architecture before multiple
instances are enabled.

## RESTful API

Filecoin Pay Volume indexer instance exposes a RESTful API to query Service Orchestrators' quarterly volume calculated according to FIP-0118, along with additional endpoints for checking service health and in general improving auditability and visibility. OpenAPI documentation of available endpoints and returned data types is available on root route (`/`) of running indexer instance.

## FIP-0118 adherence tests

The e2e suite applies the real Prisma migrations to an explicitly named PostgreSQL test database, runs a real Nest application with mocked RPC clients, and verifies indexed events, materialized pricing periods, and volume calculation through HTTP endpoints.

```sh
npm run test:e2e
```

The suite truncates its tables before running and must never be pointed at a development or production database.
