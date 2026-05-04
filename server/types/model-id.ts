import { z } from "zod";

export const modelIdSchema = z
	.string()
	.regex(
		/^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$/,
		"must be a Claude model id like 'claude-opus-4-7'",
	);
