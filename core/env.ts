import "dotenv/config";
import { z } from "zod";

function parseEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
	const result = schema.safeParse(process.env);

	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		console.error(`Invalid environment variables:\n${issues}`);
		process.exit(1);
	}

	return result.data;
}

const envSchema = z.object({
	CONFIG_PATH: z.string().default("./config.yaml"),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.string().default("info"),
	GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
});

export function loadEnv() {
	return parseEnv(envSchema);
}
