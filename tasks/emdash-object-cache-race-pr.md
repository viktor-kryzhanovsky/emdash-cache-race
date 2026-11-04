<!-- Submitted as https://github.com/emdash-cms/emdash/pull/4651 -->

## What does this PR do?

Defers object-cache invalidation until a write transaction has settled, so a content update is no longer lost to a stale cache entry under concurrent read load.

A content write bumped the collection's cache epoch immediately after its `UPDATE`, while the transaction was still open. A render that started in that window read the new epoch but, under `READ COMMITTED`, still saw the pre-update row, and cached it under the very epoch that was meant to supersede it. The entry then matched the current epoch, so the stale value was served as a cache hit until the next write to that collection or until the TTL expired — an hour by default.

This also breaks an invariant `cachedQueryWithEpochs` documents for itself: epochs are captured *before* `load()` precisely so a write landing during the load orphans the stored value. That protection assumes the epoch moves at or after the moment the new data becomes readable.

The change collects the invalidations raised inside `withTransaction` and applies them once it has committed or rolled back. It wraps the shared helper, so the path used where transactions are unavailable (D1) is covered too.

**How I ran into it.** I was load-testing EmDash against other Node CMSs on the full chain site → CMS → Postgres, and saw rendered pages keep serving a previous title for longer than fifteen seconds while the site was under read load. Full reproduction, including the measurements below and the negative results that constrain the diagnosis: https://github.com/viktor-kryzhanovsky/emdash-cache-race

**How I verified it.** Same harness, same database, same load, only the EmDash build swapped:

| Build | Result |
|---|---|
| 1.4.0 as published | 12 of 12 update-then-poll rounds still stale after 3 s, at ~930 req/s with 32 concurrent readers (repeated twice) |
| this change | 0 of 12 stale, twice |
| either build, no concurrent readers | 0 stale; the update is visible in 7–43 ms |

The window is widest where a write does more work after the row update — a localized collection syncing non-translatable fields to every sibling of the translation group — and on setups whose database connection is slow. On fast local Postgres with a single locale it can be too narrow to observe, which is why the reproduction uses six locales.

One result I could not explain, noted for reviewers: holding the transaction open for 1.5 s after the bump and issuing a *single* read inside that window does not poison the cache, so concurrent load appears to be required rather than merely a wide window.

Closes #4650

## Type of change

- [x] Bug fix
- [ ] Feature (requires an [accepted feature plan or RFC](https://github.com/emdash-cms/emdash/tree/main/proposals))
- [ ] Refactor (no behavior change)
- [ ] Translation
- [ ] Documentation
- [ ] Performance improvement
- [ ] Tests
- [ ] Chore (dependencies, CI, tooling)

## Your connection to this change

- [x] I use EmDash and ran into the problem this PR addresses
- [ ] I maintain a tool, dependency, or service that EmDash uses, and this change concerns that integration
- [ ] A Maintainer approved this specific change before I opened the PR

## Checklist

- [x] I have read [CONTRIBUTING.md](https://github.com/emdash-cms/emdash/blob/main/CONTRIBUTING.md)
- [x] `pnpm typecheck` passes
- [x] `pnpm lint` passes
- [x] `pnpm test` passes (or targeted tests for my change)
- [x] `pnpm format` has been run
- [x] I have added/updated tests for my changes (if applicable)
- [x] User-visible strings in the admin UI are [wrapped for translation](https://github.com/emdash-cms/emdash/blob/main/CONTRIBUTING.md#internationalization-i18n) (if applicable) — not applicable, no admin strings change
- [x] I have added and reviewed the user-facing [changeset](https://github.com/emdash-cms/emdash/blob/main/.changeset/README.md) (if this PR changes a published package)
- [x] New features link to their merged design PR — not applicable, this is a bug fix
- [x] I have included screenshots below if this PR changes the UI — not applicable, no UI change

## AI assistance disclosure

- [x] This PR includes AI-generated code or text — model/tool: Claude Opus 5 via Claude Code (fix, regression test, changeset and PR text) and Claude Opus 5.5 via Claude Code (verification runs and edits to this PR body)

## Screenshots / test output

Not applicable — no UI change.

Added `packages/core/tests/integration/database/object-cache-transaction.test.ts`: it reads through `cachedQuery` inside an open transaction, asserts the read still returns the committed value, and asserts the cached entry is refreshed once the transaction commits. It fails on `main` and passes with this change.

With `packages/core/src/database/transaction.ts` and `packages/core/src/object-cache/index.ts` reverted to `main` and the test kept:

```
$ EMDASH_TEST_PG=postgres://postgres:pg@localhost:55432/postgres \
    pnpm --filter emdash exec vitest run object-cache-transaction

 RUN  v4.1.10 <repo>/packages/core

 ❯ tests/integration/database/object-cache-transaction.test.ts (1 test | 1 failed) 2123ms
     × does not keep a value read before the write committed 2121ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/integration/database/object-cache-transaction.test.ts > object cache: content writes inside a transaction > does not keep a value read before the write committed
AssertionError: expected 'Old' to be 'New' // Object.is equality

Expected: "New"
Received: "Old"

 ❯ tests/integration/database/object-cache-transaction.test.ts:70:29
     68|   await flush();
     69|
     70|   expect(await readTitle()).toBe("New");
       |                             ^
     71|  });
     72| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  16:17:16
   Duration  4.11s (transform 1.25s, setup 0ms, import 1.80s, tests 2.12s, environment 0ms)
```

With this change:

```
$ EMDASH_TEST_PG=postgres://postgres:pg@localhost:55432/postgres \
    pnpm --filter emdash exec vitest run object-cache-transaction

 RUN  v4.1.10 <repo>/packages/core

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  16:17:40
   Duration  4.06s (transform 1.25s, setup 0ms, import 1.84s, tests 2.03s, environment 0ms)
```

The rest of `packages/core` was run as well, on SQLite and Postgres: 12,454 passed, 17 skipped, 3 failed. The three failures are timeouts in `datetime-normalization-migration`, `mcp/transfer` and `transfer/step-ceiling` on a shared container rather than assertion failures; each of those files passes on its own with this change (52/52), and none of them exercise the changed code path.

Load-test harness from the reproduction:

```
# published 1.4.0, 32 concurrent readers
12 of 12 rounds stale for > 3000 ms; 32 readers, ~944 req/s

# this change, same database and scenario
0 of 12 rounds stale for > 3000 ms; 32 readers, ~742 req/s
```
