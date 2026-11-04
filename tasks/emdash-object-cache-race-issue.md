**Title:** Object cache can keep a pre-write value after a content update: the collection epoch is bumped before the transaction commits

---

### Description

With an object cache configured, a content update can leave the old version of an entry cached under the new collection epoch. Pages then show the old value until the next write to that collection or until `defaultTtl` (1 hour by default).

**Expected:** once `PUT /_emdash/api/content/{collection}/{id}` returns, renders show the new value.

**Actual:** under concurrent reads, a list or entry query keeps returning the old value. In the repro below, 15 of 25 updates were still stale after 5 s at ~520 req/s, and 0 of 10 without concurrent reads.

**Cause:** `ContentRepository.update` calls `invalidateCollectionCache(type)` straight after its `UPDATE` (`src/database/repositories/content.ts`, `if (hasColumnWrites) invalidateCollectionCache(type)`). `handleContentUpdate` runs it inside `withTransaction`, then continues with bylines, `syncNonTranslatableFields`, SEO, taxonomies and redirects before `COMMIT`. `invalidateObjectCache` stamps the new epoch in the isolate immediately.

In `cachedQueryWithEpochs` (`src/object-cache/index.ts`), a read that starts in that window:

1. reads the **new** epoch;
2. misses, and runs `load()` on a pool connection outside the transaction, so it sees the last **committed** (old) row;
3. stores `{ e: newEpochs, v: oldValue }`.

Every later read matches the new epoch and gets the old value as a HIT.

```
writer: BEGIN → UPDATE → epoch N → N+1 → … more statements … → COMMIT
reader:                  reads N+1 → SELECT (old row) → set(key, { e: [N+1], v: OLD })
later readers: epoch N+1 matches → OLD until the next write or the TTL
```

The comment in `cachedQueryWithEpochs` covers a write that invalidates *during* `load()`; this is the opposite order, where the bump lands before the write is visible to other connections.

Every handler in `api/handlers/content.ts` that invalidates inside `withTransaction` has the same window (create, update, duplicate, delete, restore, schedule, publish, unpublish, discard draft), as do the taxonomy, byline and schema writes that use it. On KV the window also reaches other isolates once the deferred epoch write lands before the commit.

Checked against `main` at c54ca68: the code is unchanged from 1.4.0 and the test below fails there.

### Steps to reproduce

**Minimal: an integration test against Postgres** (`EMDASH_TEST_PG=postgres://…`, `packages/core/tests/integration/database/object-cache-transaction.test.ts`):

```ts
it("does not keep a value read before the write committed", async () => {
	const repo = new ContentRepository(ctx.db);
	const post = await repo.create(createPostFixture({ data: { title: "Old" } }));

	const readTitle = () =>
		cachedQuery({
			namespace: contentNamespaces("post"),
			key: `entry:${post.id}`,
			load: async () => (await repo.findById("post", post.id))?.data.title,
		});

	await withTransaction(ctx.db, async (trx) => {
		await new ContentRepository(trx).update("post", post.id, { data: { title: "New" } });
		// A concurrent render outside the transaction still sees the committed row.
		expect(await readTitle()).toBe("Old");
		await flush();
	});
	await flush();

	expect(await readTitle()).toBe("New"); // fails on main: "Old"
});
```

(`memoryBackend()` is a plain `Map` backend set with `__setObjectCacheBackendForTests`; `flush()` is `setTimeout(0)`.)

**End to end: one Node process, the REST API, concurrent page renders.**

1. An Astro site with `@astrojs/node` (standalone), `emdash({ database: postgres(), objectCache: memoryCache() })`, and a `posts` collection (`supports: []`, one `title` field) with 20 published entries.
2. Two pages: `/` renders `getEmDashCollection("posts", { limit: 20 })` titles; `/posts/[slug]` renders `getEmDashEntry("posts", slug)`'s title.
3. Run 32 concurrent readers looping over `/`, `/posts/post-0` … `/posts/post-3`.
4. Repeatedly `PUT /_emdash/api/content/posts/post-0` with `{ "data": { "title": "<new>" } }`, then poll `/` and `/posts/post-0` every 50 ms until both show the new title (give up after 5 s).

<details>
<summary>Driver script (race.mjs)</summary>

```js
const BASE = process.env.BASE ?? "http://127.0.0.1:4399";
const TOKEN = process.env.TOKEN;
const ROUNDS = Number(process.env.ROUNDS ?? 25);
const READERS = Number(process.env.READERS ?? 32);
const TIMEOUT = Number(process.env.TIMEOUT ?? 5000);
const SLUG = "post-0";
const WATCHED = ["/", `/posts/${SLUG}`];
const BACKGROUND = [...WATCHED, "/posts/post-1", "/posts/post-2", "/posts/post-3"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setTitle(title) {
	const res = await fetch(`${BASE}/_emdash/api/content/posts/${SLUG}`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify({ data: { title } }),
	});
	if (!res.ok) throw new Error(`PUT ${res.status}: ${await res.text()}`);
}

let reading = true;
let reads = 0;
async function reader(i) {
	while (reading) {
		try {
			await (await fetch(BASE + BACKGROUND[(i + reads) % BACKGROUND.length])).arrayBuffer();
			reads++;
		} catch {
			await sleep(10);
		}
	}
}

async function waitForTitle(path, title) {
	const started = Date.now();
	while (Date.now() - started < TIMEOUT) {
		if ((await (await fetch(BASE + path)).text()).includes(title)) return Date.now() - started;
		await sleep(50);
	}
	return null;
}

const readers = Array.from({ length: READERS }, (_, i) => reader(i));
await sleep(READERS > 0 ? 2000 : 0);
let stale = 0;
for (let round = 1; round <= ROUNDS; round++) {
	const title = `Race ${round} ${Date.now()}`;
	await setTitle(title);
	const results = await Promise.all(WATCHED.map((path) => waitForTitle(path, title)));
	if (results.includes(null)) stale++;
	console.log(round, WATCHED.map((p, i) => `${p} ${results[i] ?? "STALE"}`).join("  "));
	await sleep(200);
}
reading = false;
await Promise.all(readers);
await setTitle("Post 0");
console.log(`${stale} of ${ROUNDS} rounds stale for > ${TIMEOUT} ms`);
```

</details>

Results (Postgres 17.6, one process):

| Build | Concurrent readers | Stale after 5 s |
| --- | --- | --- |
| emdash 1.4.0 (npm) | 0 | 0 of 10 |
| emdash 1.4.0 (npm) | 32 (~520 req/s) | 15 of 25 |
| `main` c54ca68 | 32 (~540 req/s) | 9 of 25 |
| `main` + fix below | 32 (~530 req/s) | 0 of 50 |

When a page does pick up the new title, it does so in 7–150 ms. A stale page stays stale until the next write to the collection.

### Suggested fix

Hold invalidations made inside `withTransaction` and apply them once the transaction settles (commit or rollback). A read that runs while the transaction is open then captures the old epoch, and whatever it caches is orphaned by the post-commit bump.

- `object-cache/index.ts`: add `deferObjectCacheInvalidations(fn)`, an `AsyncLocalStorage` scope like `coalesceObjectCacheWrites`. Inside it, `invalidateObjectCache` records the namespace and returns. When `fn` settles, each recorded namespace is invalidated once. Nested scopes join the outermost one.
- `database/transaction.ts`: `withTransaction` runs its body inside that scope.

This keeps one backend epoch write per namespace (none are added; repeated bumps of a namespace in one transaction become one), and `stampLastContentWrite` moves to after the commit as well. On D1, where `withTransaction` runs without a transaction, the bump just moves to the end of the handler's writes. I have a patch with the regression test above; `packages/core` unit and integration tests pass on SQLite and Postgres with it.

Out of scope: the three direct `db.transaction()` callers (`redirect.ts`, `api/setup-complete.ts`, `media/usage/collection-deletion.ts`) do not invalidate content namespaces.

### Environment

- emdash 1.4.0 (npm) and `main` at c54ca68
- astro 7.4.4, @astrojs/node 11.1.9 (standalone)
- Node.js 24.22.1
- PostgreSQL 17.6 (`emdash/db` `postgres()`, pool 10, default READ COMMITTED)
- `objectCache: memoryCache()`
- macOS (also seen on Linux in Docker, 1 vCPU)

### Screenshots

Not applicable.

---

_Prepared with AI assistance (Claude Code, Claude Opus 5.5): code analysis, the test, the repro script and this text. Reproduced and reviewed by me._
