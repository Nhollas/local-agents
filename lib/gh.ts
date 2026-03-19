/**
 * Shared GitHub CLI helpers.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Run a gh CLI command and return stdout. */
export async function gh(...args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args);
  return stdout.trim();
}

/** Get PR details (head branch, base branch). */
export async function getPrDetails(
  repo: string,
  prNumber: number
): Promise<{ headBranch: string; baseBranch: string }> {
  const stdout = await gh(
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "headRefName,baseRefName",
  );
  const data = JSON.parse(stdout);
  return { headBranch: data.headRefName, baseBranch: data.baseRefName };
}

/** Get the diff for a PR. */
export async function getPrDiff(repo: string, prNumber: number): Promise<string> {
  return gh("pr", "diff", String(prNumber), "--repo", repo);
}

/** Check if a PR is still open. */
export async function isPrOpen(repo: string, prNumber: number): Promise<boolean> {
  const state = await gh(
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "state",
    "--jq", ".state",
  );
  return state === "OPEN";
}

/** Post a comment on a PR. Returns the comment ID. */
export async function postComment(repo: string, prNumber: number, body: string): Promise<number> {
  const result = await gh("pr", "comment", String(prNumber), "--repo", repo, "--body", body);
  const match = result.match(/#issuecomment-(\d+)/);
  if (match) return Number(match[1]);

  const comments = await gh("api", `repos/${repo}/issues/${prNumber}/comments`, "--jq", ".[-1].id");
  return Number(comments);
}

/** Update an existing comment. */
export async function updateComment(repo: string, commentId: number, body: string): Promise<void> {
  await gh("api", `repos/${repo}/issues/comments/${commentId}`, "--method", "PATCH", "--field", `body=${body}`);
}

/** Post a reply comment on a PR. */
export async function postReply(repo: string, prNumber: number, body: string): Promise<void> {
  await gh("pr", "comment", String(prNumber), "--repo", repo, "--body", body);
}

/** Delete a comment. */
export async function deleteComment(repo: string, commentId: number): Promise<void> {
  await gh("api", `repos/${repo}/issues/comments/${commentId}`, "--method", "DELETE");
}

/** Clone a repo to a target directory and checkout a branch. */
export async function cloneAndCheckout(repo: string, branch: string, targetDir: string): Promise<void> {
  await exec("gh", ["repo", "clone", repo, targetDir, "--", "--branch", branch]);
}

/** Find the agent's review comment on a PR by marker. */
export async function findReviewComment(
  repo: string,
  prNumber: number
): Promise<{ commentId: number; body: string; reviewId: string } | null> {
  const commentsJson = await gh(
    "api", `repos/${repo}/issues/${prNumber}/comments`,
    "--jq", "[.[] | {id: .id, body: .body}]",
  );
  const comments: { id: number; body: string }[] = JSON.parse(commentsJson);

  for (const comment of comments) {
    const match = comment.body.match(/<!-- agent:review-id:(\w+) -->/);
    if (match) {
      return { commentId: comment.id, body: comment.body, reviewId: match[1] };
    }
  }
  return null;
}

/** Parse checked items from a markdown checkbox comment. */
export function parseCheckedItems(body: string): string[] {
  const regex = /- \[x\] \*\*(.+?)\*\*/gi;
  return Array.from(body.matchAll(regex), (m) => m[1]);
}
