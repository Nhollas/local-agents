import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Create a temporary agents directory with mock agent modules.
 * Returns the path to the temp directory and a cleanup function.
 */
export async function createAgentFixture(
  agents: Array<{ name: string; moduleContent: string }>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-test-"));

  for (const agent of agents) {
    const agentDir = join(dir, agent.name);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "agent.ts"), agent.moduleContent);
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
