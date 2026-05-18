import { Schema } from "effect";

export const ModelIdSchema = Schema.String.pipe(
	Schema.pattern(/^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$/, {
		message: () => "must be a Claude model id like 'claude-opus-4-7'",
	}),
);

export type ModelId = typeof ModelIdSchema.Type;
