# EmDash object-cache race

A reproduction for a stale-cache bug in [EmDash](https://github.com/emdash-cms/emdash) 1.4.0, plus a
proposed fix.

**Symptom.** With `objectCache: memoryCache()` on Postgres, an update made through the content API is
not reflected on rendered pages while the site is under concurrent read load. The old value keeps
being served as a cache HIT until the next write to the collection or until `defaultTtl` — one hour
by default.

**Cause.** `ContentRepository.update` bumps the collection cache epoch immediately after its
`UPDATE`, while still inside the write transaction
([`content.ts`](https://github.com/emdash-cms/emdash/blob/main/packages/core/src/database/repositories/content.ts),
`if (hasColumnWrites) invalidateCollectionCache(type)`). `handleContentUpdate` wraps the whole
operation in one `withTransaction` and then performs up to eight more statements before `COMMIT`. A
reader that starts in that window reads the new epoch, runs its query, sees the pre-update row under
`READ COMMITTED`, and caches it under the new epoch. The cached envelope matches the current epoch
from then on, so the stale value is served as a hit.

This breaks an invariant the reader documents for itself in `object-cache/index.ts`: epochs are
captured *before* `load()` precisely so that a write landing during the load orphans the stored
value. That protection assumes the epoch moves at or after the moment the new data becomes readable.

## Results

| Configuration | Result |
|---|---|
| 32 concurrent readers (~930 req/s), i18n | **12 of 12 rounds stale** (repeated twice) |
| no concurrent readers | 0 stale, update visible in 7–43 ms |
| 32 readers, **with the patch below** | **0 of 12 rounds stale** (repeated twice) |

Observed on emdash 1.4.0 (npm), Node 22.23.4, Astro 7.4.4, `@astrojs/node` 11.1.9 standalone, single
process, PostgreSQL 18 with the default `READ COMMITTED`.

## What decides whether it reproduces

The race needs a reader to start inside the window between the epoch bump and `COMMIT`, so the width
of that window is what matters. Two things widen it:

- **i18n** — `syncNonTranslatableFields` updates every sibling of the translation group inside that
  window, and it runs only when more than one locale is configured.
- **A slow database connection** — every post-bump statement pays its round trip, so Postgres across
  a container or VM boundary reproduces far more easily than one on a local socket.

On fast local Postgres with a single locale the window can be too narrow to hit. Use the i18n recipe.

## Layout

| Path | What |
|---|---|
| [`repro/`](repro/) | the reproduction: a minimal EmDash site, seed scripts and the race harness. Start with [`repro/README.md`](repro/README.md) |
| [`tasks/emdash-object-cache-race-fix.patch`](tasks/emdash-object-cache-race-fix.patch) | proposed fix: defer object-cache invalidations until the transaction settles, plus an integration test |
| [`tasks/emdash-object-cache-race-issue.md`](tasks/emdash-object-cache-race-issue.md) | the upstream bug report |

## Proposed fix

[`tasks/emdash-object-cache-race-fix.patch`](tasks/emdash-object-cache-race-fix.patch) wraps
`withTransaction` in an `AsyncLocalStorage` scope that collects object-cache invalidations and
applies them once the transaction has committed or rolled back. It wraps the inner `runTransaction`,
so the non-transactional path (D1) is covered too, and it adds
`packages/core/tests/integration/database/object-cache-transaction.test.ts`.

With the patch applied, the same loaded run goes from 12 of 12 stale to 0 of 12.

## Upstream

- Issue: https://github.com/emdash-cms/emdash/issues/4650
- Pull request: https://github.com/emdash-cms/emdash/pull/4651
