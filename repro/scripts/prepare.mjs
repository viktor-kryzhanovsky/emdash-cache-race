// Prepares the database for the race repro and prints an API token:
// migrations, a `posts` collection with 20 published entries, an admin user,
// the setup-complete flag, and a token with content:read/content:write.
//
// The admin UI signs in with passkeys, which a script cannot do, so the user
// and the token are inserted directly, hashed the way EmDash does.
//
//   PGHOST=... PGDATABASE=... node scripts/prepare.mjs   -> prints ec_pat_...
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ulid } from "emdash";
import { runMigrations } from "emdash/db";
import { createDialect } from "emdash/db/postgres";
import { applySeed } from "emdash/seed";
import { Kysely } from "kysely";

const fromEmdash = createRequire(import.meta.resolve("emdash"));
const { generatePrefixedToken } = await import(
	pathToFileURL(fromEmdash.resolve("@emdash-cms/auth")).href
);

const POSTS = 20;
const EMAIL = "repro@example.com";
const ADMIN_ROLE = 50;

const db = new Kysely({ dialect: createDialect({}) });

try {
	await runMigrations(db);

	await applySeed(
		db,
		{
			version: "1",
			collections: [
				{
					slug: "posts",
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					fields: [{ slug: "title", label: "Title", type: "string", required: true }],
				},
			],
			content: {
				posts: Array.from({ length: POSTS }, (_, i) => ({
					id: `post-${i}`,
					slug: `post-${i}`,
					status: "published",
					data: { title: `Post ${i}` },
				})),
			},
		},
		{ includeContent: true, onConflict: "update" },
	);

	let user = await db.selectFrom("users").select("id").where("email", "=", EMAIL).executeTakeFirst();
	if (!user) {
		user = { id: ulid() };
		await db
			.insertInto("users")
			.values({ id: user.id, email: EMAIL, name: "Repro", role: ADMIN_ROLE, email_verified: 1 })
			.execute();
	}

	await db
		.insertInto("options")
		.values({ name: "emdash:setup_complete", value: "true" })
		.onConflict((oc) => oc.column("name").doUpdateSet({ value: "true" }))
		.execute();

	await db.deleteFrom("_emdash_api_tokens").where("user_id", "=", user.id).execute();
	const { raw, hash, prefix } = generatePrefixedToken("ec_pat_");
	await db
		.insertInto("_emdash_api_tokens")
		.values({
			id: ulid(),
			name: "repro",
			token_hash: hash,
			prefix,
			user_id: user.id,
			scopes: JSON.stringify(["content:read", "content:write"]),
		})
		.execute();
	console.log(raw);
} finally {
	await db.destroy();
}
