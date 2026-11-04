import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { memoryCache } from "emdash/astro";
import { postgres } from "emdash/db";

// node-postgres reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE at runtime.
export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: postgres({ pool: { max: 10 } }),
			objectCache: memoryCache(),
		}),
	],
	devToolbar: { enabled: false },
});
