import { Schema } from "effect";

const UrlString = Schema.String.pipe(
	Schema.filter((s) => (URL.canParse(s) ? undefined : `must be a valid URL`)),
);

export const ConfigFileSchema = Schema.Struct({
	tracker: Schema.Struct({
		kind: Schema.Literal("jira"),
		base_url: UrlString,
		project: Schema.NonEmptyString,
		trigger_label: Schema.NonEmptyString,
		statuses: Schema.Struct({
			pending: Schema.NonEmptyString,
			running: Schema.NonEmptyString,
			awaiting_review: Schema.NonEmptyString,
		}),
	}),
	code_host: Schema.Union(
		Schema.Struct({
			kind: Schema.Literal("gitlab"),
			scopes: Schema.NonEmptyArray(Schema.NonEmptyString),
			base_url: UrlString,
		}),
		Schema.Struct({
			kind: Schema.Literal("github"),
			scopes: Schema.NonEmptyArray(Schema.NonEmptyString),
		}),
	),
	defaults: Schema.Struct({
		polling_interval_ms: Schema.Int.pipe(Schema.positive()),
		max_concurrent: Schema.Int.pipe(Schema.positive()),
		workspace_root: Schema.NonEmptyString,
		log_dir: Schema.optionalWith(Schema.NonEmptyString, {
			default: () => "./logs",
		}),
	}),
	agent: Schema.optionalWith(
		Schema.Struct({
			env: Schema.optionalWith(
				Schema.Struct({
					include: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), {
						default: () => [],
					}),
					set: Schema.optionalWith(
						Schema.Record({ key: Schema.String, value: Schema.String }),
						{ default: () => ({}) },
					),
				}),
				{ default: () => ({ include: [], set: {} }) },
			),
		}),
		{ default: () => ({ env: { include: [], set: {} } }) },
	),
});

export type ConfigFile = typeof ConfigFileSchema.Type;
