// Deterministic variant: hold the write transaction open AFTER the cache epoch
// is bumped, by locking the table that seoRepo.upsert needs. No load required.
import { Client } from "pg";
const BASE = process.env.BASE ?? "http://127.0.0.1:4399";
const TOKEN = process.env.TOKEN;
const SLUG = "post-0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = async () => {
  const html = await (await fetch(`${BASE}/posts/${SLUG}`)).text();
  return (html.match(/<h1>([^<]*)<\/h1>/) ?? [])[1] ?? "(none)";
};
const listing = async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  return (html.match(/<li[^>]*>([^<]*)<\/li>/) ?? [])[1] ?? "(none)";
};

const NEW = `Deterministic ${Date.now()}`;
console.log("before        :", await title());

const blocker = new Client();
await blocker.connect();
await blocker.query("BEGIN");
await blocker.query("LOCK TABLE _emdash_seo IN ACCESS EXCLUSIVE MODE");
console.log("blocker       : _emdash_seo locked, transaction open");

let putStatus = "pending";
const put = fetch(`${BASE}/_emdash/api/content/posts/${SLUG}?locale=en`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ data: { title: NEW, shared: NEW }, seo: { title: NEW } }),
}).then(async (r) => { putStatus = r.status; return r.ok ? null : await r.text(); });

await sleep(1500);
console.log("PUT status    :", putStatus, "(should still be pending — blocked after the epoch bump)");
const during = await title();
const duringList = await listing();
console.log("read DURING   :", during, "| listing:", duringList);

await blocker.query("COMMIT");
await blocker.end();
const err = await put;
console.log("PUT status    :", putStatus, err ? `error: ${err}` : "");

for (const d of [0, 500, 2000]) {
  await sleep(d);
  console.log(`read after +${String(d).padStart(4)}ms:`, await title(), "| listing:", await listing());
}
const final = await title();
console.log("\nRESULT:", final === NEW ? "fresh — no stale cache" : `STALE — page still shows ${JSON.stringify(final)} instead of ${JSON.stringify(NEW)}`);
