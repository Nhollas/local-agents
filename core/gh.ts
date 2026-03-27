import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Run a gh CLI command and return stdout. */
export async function gh(...args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args);
  return stdout.trim();
}

/** Clone a repo to a target directory and checkout a branch. */
export async function cloneAndCheckout(repo: string, branch: string, targetDir: string): Promise<void> {
  await exec("gh", ["repo", "clone", repo, targetDir, "--", "--branch", branch]);
}
