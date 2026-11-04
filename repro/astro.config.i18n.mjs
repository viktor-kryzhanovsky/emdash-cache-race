import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { memoryCache } from "emdash/astro";
import { postgres } from "emdash/db";

// node-postgres reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE at runtime.
export default defineConfig({
	output: "server",
	outDir: "./dist-i18n",
	// EmDash reads locales from astroConfig.i18n (integration/index.ts:664).
	// isI18nEnabled() is true only with more than one locale.
	i18n: {
		defaultLocale: "en",
		locales: ["en", "uk", "es", "ru", "zh", "pt"],
		routing: { prefixDefaultLocale: false },
	},
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
