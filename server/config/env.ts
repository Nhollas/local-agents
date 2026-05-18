import { Config, Effect, type Redacted } from "effect";

export type LangfuseEnv = {
	readonly publicKey: Redacted.Redacted;
	readonly secretKey: Redacted.Redacted;
	readonly host: string;
	readonly projectId: string;
};

const port = Config.integer("PORT").pipe(Config.withDefault(3000));

const langfuseHost = Config.string("LANGFUSE_HOST").pipe(
	Config.validate({
		message: "LANGFUSE_HOST must be a valid URL",
		validation: (value) => URL.canParse(value),
	}),
	Config.withDefault("http://localhost:3100"),
);

export const processEnv = Effect.all({
	port,
	langfuse: Effect.all({
		publicKey: Config.redacted("LANGFUSE_PUBLIC_KEY"),
		secretKey: Config.redacted("LANGFUSE_SECRET_KEY"),
		host: langfuseHost,
		projectId: Config.string("LANGFUSE_PROJECT_ID"),
	}),
});
