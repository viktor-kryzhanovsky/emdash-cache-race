# EmDash object-cache race repro

A single EmDash process (`@astrojs/node` standalone, Postgres, `objectCache: memoryCache()`) with a
`posts` collection, plus scripts that update a post through the content API while concurrent readers
render the pages that show it.

**Symptom:** under concurrent reads, an update made through the content API is not reflected on
rendered pages. The old value keeps being served as a cache HIT until the next write to the
collection or until `defaultTtl` (1 hour by default).

**Suspected cause:** `ContentRepository.update` bumps the collection cache epoch immediately after
its `UPDATE`, while still inside the write transaction
(`packages/core/src/database/repositories/content.ts`, `if (hasColumnWrites) invalidateCollectionCache(type)`).
`handleContentUpdate` wraps the whole operation in one `withTransaction` and then performs up to
eight more statements before `COMMIT`. A reader that starts in that window reads the new epoch, runs
its query, sees the pre-update row under `READ COMMITTED`, and caches it under the new epoch.

## What decides whether it reproduces

The race needs a reader to start inside the window between the epoch bump and `COMMIT`, so the
**width of that window** is what matters. Two things widen it:

- **i18n.** `syncNonTranslatableFields` runs only when more than one locale is configured, the body
  carries `data`, and the entry is in a translation group. It then updates every sibling of the
  group — inside the transaction, after the bump. With six locales that is five extra row updates.
- **A slow database connection.** Every post-bump statement pays the round trip, so Postgres over a
  Docker/VM network boundary reproduces far more easily than one on a local socket.

On fast local Postgres without i18n the window can be too narrow to hit. **Use the i18n variant
below for a reliable reproduction.**

Requires Node >= 22.23.4 (Astro 7.4) and a Postgres database.

## Reliable reproduction (i18n)

```bash
npm install
export PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=pg PGDATABASE=repro

# 6 locales, translation groups, SEO, and one translatable:false field
node scripts/prepare-i18n.mjs > .token
npx astro build --config astro.config.i18n.mjs

# terminal 1
PORT=4399 HOST=127.0.0.1 node ./dist-i18n/server/entry.mjs

# terminal 2
TOKEN=$(cat .token) READERS=0  ROUNDS=12 TIMEOUT=3000 node scripts/race-i18n.mjs   # expect 0 stale
TOKEN=$(cat .token) READERS=32 ROUNDS=12 TIMEOUT=3000 node scripts/race-i18n.mjs   # expect all stale
```

Observed on emdash 1.4.0, Node 22.23.4, Postgres 18, Ubuntu 22.04 x86_64:

```
# READERS=0
0 of 10 rounds stale for > 5000 ms; 0 readers, ~0 req/s

# READERS=32
12 of 12 rounds stale for > 3000 ms; 32 readers, ~944 req/s
```

## Minimal variant (no i18n)

`scripts/prepare.mjs` + `scripts/race.mjs` with `astro.config.mjs` build the same site with a single
locale and one `title` field. It reproduces on a slow database connection and may not reproduce on a
local socket — on the machine above it gave `0 of 25`.

`scripts/prepare-seo.mjs` / `scripts/race-seo.mjs` add SEO only (no i18n); also `0 of 25` there.

## Negative result worth knowing

`scripts/race-deterministic.mjs` and `scripts/race-deterministic-i18n.mjs` hold the write
transaction open for 1.5 s after the epoch bump (`LOCK TABLE _emdash_seo IN ACCESS EXCLUSIVE MODE`
from a separate session, so `seoRepo.upsert` blocks) and issue a single read inside that window.
That read does return the old value, but after `COMMIT` the page is immediately fresh.

**So one reader inside a wide window is not sufficient — concurrent read load is required.** Any
explanation of the mechanism has to account for this.

## Testing a fix

```bash
npm install --no-save path/to/emdash-x.y.z.tgz   # from `pnpm pack` in packages/core
npx astro build --config astro.config.i18n.mjs
# restart the server, then re-run the loaded race
```

With the deferred-invalidation patch (`../tasks/emdash-object-cache-race-fix.patch`), the same loaded
run goes from `12 of 12 rounds stale` to:

```
0 of 12 rounds stale for > 3000 ms; 32 readers, ~742 req/s
```
