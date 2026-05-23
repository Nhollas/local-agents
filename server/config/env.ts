import { Config, Effect } from "effect";

export const processEnv = Effect.all({
	langfuse: Effect.all({
		publicKey: Config.redacted("LANGFUSE_PUBLIC_KEY"),
		secretKey: Config.redacted("LANGFUSE_SECRET_KEY"),
		host: Config.string("LANGFUSE_HOST").pipe(
			Config.validate({
				message: "LANGFUSE_HOST must be a valid URL",
				validation: (value) => URL.canParse(value),
			}),
			Config.withDefault("http://localhost:3100"),
		),
		projectId: Config.string("LANGFUSE_PROJECT_ID"),
	}),
});

export type LangfuseEnv = Effect.Effect.Success<typeof processEnv>["langfuse"];
