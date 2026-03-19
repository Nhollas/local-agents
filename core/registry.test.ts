import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "./registry.ts";

vi.mock("./logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const validModule = `
export default {
  name: "test-agent",
  triggers: [{ event: "pull_request", action: "opened" }],
  handler: async () => {},
};
`;

let tempDir: string;

async function setup(
  agents: Array<{ name: string; content: string; isFile?: boolean }>,
) {
  tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
  for (const agent of agents) {
    if (agent.isFile) {
      await writeFile(join(tempDir, agent.name), agent.content);
    } else {
      const dir = join(tempDir, agent.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "agent.ts"), agent.content);
    }
  }
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("loadRegistry", () => {
  it("loads a valid agent module", async () => {
    await setup([{ name: "my-agent", content: validModule }]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("test-agent");
    expect(agents[0].triggers).toEqual([{ event: "pull_request", action: "opened" }]);
    expect(typeof agents[0].handler).toBe("function");
  });

  it("skips a module with missing handler", async () => {
    const noHandler = `
export default {
  name: "bad",
  triggers: [{ event: "push" }],
};
`;
    await setup([{ name: "bad-agent", content: noHandler }]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(0);
  });

  it("skips a module with empty triggers", async () => {
    const emptyTriggers = `
export default {
  name: "bad",
  triggers: [],
  handler: async () => {},
};
`;
    await setup([{ name: "bad-agent", content: emptyTriggers }]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(0);
  });

  it("skips a module with no default export", async () => {
    const namedOnly = `
export const agent = {
  name: "named",
  triggers: [{ event: "push" }],
  handler: async () => {},
};
`;
    await setup([{ name: "named-agent", content: namedOnly }]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(0);
  });

  it("ignores non-directory entries", async () => {
    await setup([
      { name: "stray-file.ts", content: "export default {}", isFile: true },
      { name: "valid-agent", content: validModule },
    ]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("test-agent");
  });

  it("skips a directory without agent.ts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
    await mkdir(join(tempDir, "empty-agent"));
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(0);
  });

  it("loads multiple valid agents", async () => {
    const agentA = `
export default {
  name: "agent-a",
  triggers: [{ event: "pull_request", action: "opened" }],
  handler: async () => {},
};
`;
    const agentB = `
export default {
  name: "agent-b",
  triggers: [{ event: "issues", action: "created" }],
  handler: async () => {},
};
`;
    await setup([
      { name: "a", content: agentA },
      { name: "b", content: agentB },
    ]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("returns only valid agents from a mixed set", async () => {
    const invalid = `
export default {
  name: "",
  triggers: [{ event: "push" }],
  handler: async () => {},
};
`;
    await setup([
      { name: "good", content: validModule },
      { name: "bad", content: invalid },
    ]);
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("test-agent");
  });

  it("returns empty for an empty directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
    const agents = await loadRegistry(tempDir);
    expect(agents).toHaveLength(0);
  });

  it("returns empty when directory does not exist", async () => {
    const agents = await loadRegistry("/tmp/nonexistent-agents-dir-12345");
    expect(agents).toHaveLength(0);
  });
});
