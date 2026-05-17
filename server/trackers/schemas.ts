import { Schema } from "effect";

const JiraIssueKey = Schema.transform(
	Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]*-\d+$/)),
	Schema.Struct({
		raw: Schema.String,
		number: Schema.Number,
	}),
	{
		strict: true,
		decode: (s) => ({
			raw: s,
			number: Number.parseInt(s.slice(s.indexOf("-") + 1), 10),
		}),
		encode: ({ raw }) => raw,
	},
);

export const JiraIssueSchema = Schema.Struct({
	key: JiraIssueKey,
	fields: Schema.Struct({
		summary: Schema.String,
		description: Schema.optional(Schema.NullOr(Schema.String)),
		created: Schema.String,
		labels: Schema.Array(Schema.String),
		status: Schema.Struct({ name: Schema.String }),
	}),
});
export type JiraIssue = typeof JiraIssueSchema.Type;

export const JiraSearchSchema = Schema.Struct({
	issues: Schema.Array(JiraIssueSchema),
});

export const JiraTransitionSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	to: Schema.Struct({ name: Schema.String }),
});
export type JiraTransition = typeof JiraTransitionSchema.Type;

export const JiraTransitionsSchema = Schema.Struct({
	transitions: Schema.Array(JiraTransitionSchema),
});

export const JiraMyselfSchema = Schema.Struct({
	accountId: Schema.String,
});
export type JiraMyself = typeof JiraMyselfSchema.Type;
