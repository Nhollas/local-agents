import { FileSystem } from "@effect/platform";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { type RepoSlug, repoSlug } from "../types/brands.ts";
import { type ConfigFile, ConfigFileSchema } from "./schema.ts";

type WithBrandedScopes<T> = T extends { scopes: ReadonlyArray<string> }
	? Omit<T, "scopes"> & { readonly scopes: ReadonlyArray<RepoSlug> }
	: never;

export type AppConfigShape = Omit<ConfigFile, "code_host"> & {
	readonly code_host: WithBrandedScopes<ConfigFile["code_host"]>;
};

export class AppConfig extends Context.Tag("AppConfig")<
	AppConfig,
	AppConfigShape
>() {}

export const AppConfigLive = Layer.effect(
	AppConfig,
	Effect.gen(function* () {
		const path = yield* Config.string("CONFIG_PATH");
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(path);
		const file = yield* Schema.decodeUnknown(ConfigFileSchema)(parseYaml(raw), {
			onExcessProperty: "error",
		});
		return {
			...file,
			code_host: {
				...file.code_host,
				scopes: file.code_host.scopes.map(repoSlug),
			},
		};
	}),
);
