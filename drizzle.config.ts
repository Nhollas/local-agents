import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./core/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: `${process.env.DATA_DIR ?? ".data"}/gateway.db`,
	},
});
