Upstream bug report for https://github.com/emdash-cms/emdash
Filed as: https://github.com/emdash-cms/emdash/issues/4650

---

**Title:** Object cache serves stale content under concurrent reads: the collection epoch is bumped before the write transaction commits

---

### Description

With `objectCache: memoryCache()` on Postgres, an update made through the content API is not
reflected on rendered pages while the site is under concurrent read load. The old value keeps being
served as a cache HIT until the next write to the collection or until `defaultTtl` (1 hour by
default).

**Expected:** once the content API call returns, reads serve the new value.

**Actual:** with 32 concurrent readers (~930 req/s), 12 of 12 update-then-poll rounds time out at
3 s — reproducibly, twice. With no concurrent readers the same update is visible in 7–43 ms.

### Cause

`ContentRepository.update` bumps the collection epoch right after the `UPDATE`, still inside the
write transaction:

```ts
// packages/core/src/database/repositories/content.ts:1150
if (hasColumnWrites) invalidateCollectionCache(type);
```

`handleContentUpdate` wraps the whole operation in one `withTransaction`
(`api/handlers/content.ts:1631`) and, after that bump, still performs up to eight further database
operations before `COMMIT`: `setContentBylines` (:1717), `createSlugChangeRedirect` (:1730),
`syncNonTranslatableFields` (:1745), `seoRepo.upsert` (:1756), `hydrateBylines` (:1762),
`assignTaxonomies` (:1769), `writeReferenceSelection` (:1780), `removeShadowingAutoRedirect` (:1785).

A reader that starts in that window reads epoch `N+1` in `cachedQueryWithEpochs`
(`object-cache/index.ts:771`), runs `load()`, and under `READ COMMITTED` sees the row as it was
before the uncommitted `UPDATE` — then stores `{ e: [N+1], v: OLD }`:

```
writer: BEGIN → UPDATE → invalidateCollectionCache (N → N+1) → …statements… → COMMIT
reader:                   reads epoch N+1 → SELECT returns the old, uncommitted row
                          → set(key, { e: [N+1], v: OLD })
later:  current epoch is still N+1 → envelope matches → OLD is served as a HIT
```

This breaks an invariant the reader documents for itself (`object-cache/index.ts:783`): epochs are
captured *before* `load()` precisely so that a write landing during the load orphans the stored
value. That protection assumes the epoch moves at or after the moment the new data becomes readable.

The same pattern appears wherever `invalidateCollectionCache` is called from inside a transaction —
`content.ts` lines 537, 1260, 1333, 1520, 1589, 1699, 1740, 1767, 2211, 2262, 2633, 2770 and 2855
(publish, unpublish, delete, restore, schedule). It would be worth auditing which of those run with
a `trx`.

### What decides whether it reproduces

The width of the window between the bump and `COMMIT`. Two things widen it: **i18n**, because
`syncNonTranslatableFields` updates every sibling of the translation group inside that window and
runs only when more than one locale is configured; and **a slow database connection**, because every
post-bump statement pays its round trip. On fast local Postgres with a single locale the window can
be too narrow to hit — the i18n recipe in the reproduction is the reliable one.

### One result that does not fit this explanation

Holding the write transaction open for 1.5 s after the bump (locking `_emdash_seo` from a separate
session so `seoRepo.upsert` blocks) and issuing a single read inside that window does **not** poison
the cache: the read does return the old value, but after `COMMIT` the page is immediately fresh. So
a single reader inside a wide window is not sufficient — concurrent read load is required, and I
could not explain why. `scripts/race-deterministic-i18n.mjs` in the reproduction shows this.

### Relationship to #4530 / #4531

Same subsystem, different defect. #4530 concerns widget areas on KV/Workers, where the epoch's
persistence is deferred so a route purge lands before the epoch write is visible to other isolates.
This report is the content path on Postgres in a single process. The `waitForPersist: true` option
added in #4531 does not address it: waiting for the epoch write to settle does not help if the epoch
moved too early relative to the data's visibility.

I use EmDash and hit this on my own site while load-testing it; before filing I reproduced it from a clean
clone of the reproduction repository below, and confirmed that a regression test fails without the fix and
passes with it. AI assistance was used in preparing this report — Claude Opus 5 and Claude Opus 5.5 via
Claude Code — for the code analysis, the reproduction scripts and the text of this issue; I reviewed, ran
and verified all of it myself.

### Steps to reproduce

Full reproduction: https://github.com/viktor-kryzhanovsky/emdash-cache-race

```bash
git clone https://github.com/viktor-kryzhanovsky/emdash-cache-race
cd emdash-cache-race/repro && npm install
export PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=pg PGDATABASE=repro

node scripts/prepare-i18n.mjs > .token      # 6 locales, translation groups, SEO, a translatable:false field
npx astro build --config astro.config.i18n.mjs
PORT=4399 HOST=127.0.0.1 node ./dist-i18n/server/entry.mjs   # terminal 1

# terminal 2
TOKEN=$(cat .token) READERS=0  ROUNDS=12 TIMEOUT=3000 node scripts/race-i18n.mjs   # 0 stale
TOKEN=$(cat .token) READERS=32 ROUNDS=12 TIMEOUT=3000 node scripts/race-i18n.mjs   # all stale
```

### Environment

- emdash version: 1.4.0 (npm); the code path is unchanged in `main` at `e6397f58e`
- Node.js version: 22.23.4
- Runtime: Node, `@astrojs/node` 11.1.9 standalone, single process
- Astro: 7.4.4
- Database: PostgreSQL 17.6 and 18, default `READ COMMITTED` (reproduced on both)
- Object cache: `objectCache: memoryCache()`
- Collection: `supports: ["seo"]`, 6 locales, one `translatable: false` field
- OS: Ubuntu 22.04 x86_64

### Screenshots

Not applicable.

### Logs / error output

```
round  1: / STALE  /posts/post-0 STALE
round  2: / STALE  /posts/post-0 STALE
round  3: / STALE  /posts/post-0 STALE
round  4: / STALE  /posts/post-0 STALE
round  5: / STALE  /posts/post-0 STALE
round  6: / STALE  /posts/post-0 STALE
round  7: / STALE  /posts/post-0 STALE
round  8: / STALE  /posts/post-0 STALE
round  9: / STALE  /posts/post-0 STALE
round 10: / STALE  /posts/post-0 STALE
round 11: / STALE  /posts/post-0 STALE
round 12: / STALE  /posts/post-0 STALE

12 of 12 rounds stale for > 3000 ms; 32 readers, ~944 req/s

# with tasks/emdash-object-cache-race-fix.patch applied, same database and scenario:
0 of 12 rounds stale for > 3000 ms; 32 readers, ~742 req/s
```

### Fix

`tasks/emdash-object-cache-race-fix.patch` in the reproduction repository wraps `withTransaction` in
an `AsyncLocalStorage` scope that collects object-cache invalidations and applies them once the
transaction has committed or rolled back. It wraps the inner `runTransaction`, so the
non-transactional path (D1) is covered too, and it adds
`packages/core/tests/integration/database/object-cache-transaction.test.ts`.

Happy to open it as a PR.
