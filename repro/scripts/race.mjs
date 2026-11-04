// Updates one post through the content API while concurrent readers render
// pages that show it, then polls those pages until they show the new title.
// A round is STALE when a page still shows the old title after TIMEOUT ms.
//
//   TOKEN=ec_pat_... node scripts/race.mjs
//   READERS=0 TOKEN=... node scripts/race.mjs     # baseline without concurrent reads
//
// Env: BASE (http://127.0.0.1:4399), ROUNDS (25), READERS (32), TIMEOUT (5000).
const BASE = process.env.BASE ?? "http://127.0.0.1:4399";
const TOKEN = process.env.TOKEN;
const ROUNDS = Number(process.env.ROUNDS ?? 25);
const READERS = Number(process.env.READERS ?? 32);
const TIMEOUT = Number(process.env.TIMEOUT ?? 5000);
const SLUG = "post-0";
const WATCHED = ["/", `/posts/${SLUG}`];
const BACKGROUND = [...WATCHED, "/posts/post-1", "/posts/post-2", "/posts/post-3"];

if (!TOKEN) {
	console.error("TOKEN is required (see scripts/prepare.mjs)");
	process.exit(1);
}

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
		const path = BACKGROUND[(i + reads) % BACKGROUND.length];
		try {
			const res = await fetch(BASE + path);
			await res.arrayBuffer();
			reads++;
		} catch {
			await sleep(10);
		}
	}
}

async function waitForTitle(path, title) {
	const started = Date.now();
	while (Date.now() - started < TIMEOUT) {
		const html = await (await fetch(BASE + path)).text();
		if (html.includes(title)) return Date.now() - started;
		await sleep(50);
	}
	return null;
}

const readers = Array.from({ length: READERS }, (_, i) => reader(i));
await sleep(READERS > 0 ? 2000 : 0);
const readsBefore = reads;
const startedAt = Date.now();

let stale = 0;
for (let round = 1; round <= ROUNDS; round++) {
	const title = `Race ${round} ${Date.now()}`;
	await setTitle(title);
	const results = await Promise.all(WATCHED.map((path) => waitForTitle(path, title)));
	const line = WATCHED.map((path, i) =>
		results[i] === null ? `${path} STALE` : `${path} ${results[i]}ms`,
	).join("  ");
	if (results.includes(null)) stale++;
	console.log(`round ${String(round).padStart(2)}: ${line}`);
	await sleep(200);
}

const seconds = (Date.now() - startedAt) / 1000;
reading = false;
await Promise.all(readers);
await setTitle("Post 0");

console.log(
	`\n${stale} of ${ROUNDS} rounds stale for > ${TIMEOUT} ms; ` +
		`${READERS} readers, ~${Math.round((reads - readsBefore) / seconds)} req/s`,
);
process.exit(stale > 0 ? 1 : 0);
