import { FileSystem } from "@effect/platform";
import { Config, Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { ConfigFileSchema } from "./schema.ts";

export class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
	effect: Effect.gen(function* () {
		const path = yield* Config.string("CONFIG_PATH");
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(path);
		return yield* Schema.decodeUnknown(ConfigFileSchema)(parseYaml(raw), {
			onExcessProperty: "error",
		});
	}),
}) {}
