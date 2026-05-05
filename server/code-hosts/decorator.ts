import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "./types.ts";

export function decorateCodeHost(inner: CodeHostAdapter): CodeHostAdapter {
	return {
		...inner,
		async createChangeRequest(repo, head, base, title, body) {
			const pr = await inner.createChangeRequest(repo, head, base, title, body);
			canonicalLog.set({ pr_url: pr.url });
			return pr;
		},
	};
}
