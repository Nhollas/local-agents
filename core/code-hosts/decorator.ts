import { logger } from "../logger.ts";
import type { CodeHostAdapter } from "../types.ts";

export function decorateCodeHost(inner: CodeHostAdapter): CodeHostAdapter {
	return {
		async fetchFile(repo, path, ref) {
			const content = await inner.fetchFile(repo, path, ref);
			if (content === null) {
				logger.debug({ repo, path, ref }, "code-host.fetch_file_not_found");
			}
			return content;
		},

		cloneUrl(repo) {
			return inner.cloneUrl(repo);
		},

		async createChangeRequest(repo, head, base, title, body) {
			try {
				const pr = await inner.createChangeRequest(
					repo,
					head,
					base,
					title,
					body,
				);
				logger.info({ repo, pr: pr.url }, "code-host.pr_created");
				return pr;
			} catch (err) {
				logger.warn({ repo, head, base, err }, "code-host.pr_create_failed");
				throw err;
			}
		},
	};
}
