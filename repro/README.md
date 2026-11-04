# EmDash object-cache race repro

One EmDash process (emdash 1.4.0, `@astrojs/node` standalone, Postgres, `objectCache: memoryCache()`),
a `posts` collection, and a script that updates a post through the REST API while concurrent readers
render pages that show it.

Requires Node >= 22.23.4 (Astro 7.4) and a Postgres database.

```bash
npm install
export PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=pg PGDATABASE=repro

node scripts/prepare.mjs > .token        # migrations, 20 posts, admin user, API token
npx astro build

# terminal 1
PORT=4399 HOST=127.0.0.1 node ./dist/server/entry.mjs

# terminal 2
TOKEN=$(cat .token) READERS=0 ROUNDS=10 node scripts/race.mjs   # baseline: 0 stale
TOKEN=$(cat .token) node scripts/race.mjs                       # 32 readers: stale rounds
```

To test a local EmDash build, `npm install --no-save path/to/emdash-x.y.z.tgz` (from `pnpm pack` in
`packages/core`), rebuild, and restart the server.
