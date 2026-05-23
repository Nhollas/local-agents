import { FileSystem } from "@effect/platform";
import { Config, Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { type RepoSlug, repoSlug } from "../types/brands.ts";
import { type ConfigFile, ConfigFileSchema } from "./schema.ts";

type WithBrandedScopes<T> = T extends { scopes: ReadonlyArray<string> }
	? Omit<T, "scopes"> & { readonly scopes: ReadonlyArray<RepoSlug> }
	: never;

export type AppConfigShape = Omit<ConfigFile, "code_host"> & {
	readonly code_host: WithBrandedScopes<ConfigFile["code_host"]>;
};

export class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
	effect: Effect.gen(function* () {
		const path = yield* Config.string("CONFIG_PATH");
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(path);
		const file = yield* Schema.decodeUnknown(ConfigFileSchema)(parseYaml(raw), {
			onExcessProperty: "error",
		});
		const shape: AppConfigShape = {
			...file,
			code_host: {
				...file.code_host,
				scopes: file.code_host.scopes.map(repoSlug),
			},
		};
		return shape;
	}),
}) {}
