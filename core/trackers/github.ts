import { gh } from "../gh.ts";
import type { Issue, TrackerAdapter } from "../types.ts";

type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  url: string;
};

export function createGitHubTracker(
  repo: string,
  label: string,
  activeStates: string[] = ["open"],
): TrackerAdapter {
  return {
    async fetchActiveIssues(): Promise<Issue[]> {
      const results: GitHubIssue[] = [];

      for (const state of activeStates) {
        const stdout = await gh(
          "issue",
          "list",
          "--repo",
          repo,
          "--label",
          label,
          "--state",
          state,
          "--json",
          "number,title,body,state,labels,url",
        );
        results.push(...JSON.parse(stdout));
      }

      const seen = new Set<number>();

      return results.filter((i) => {
        if (seen.has(i.number)) return false;
        seen.add(i.number);
        return true;
      }).map((i) => ({
        id: i.number,
        key: `${repo}#${i.number}`,
        number: i.number,
        title: i.title,
        description: i.body ?? "",
        state: i.state.toLowerCase(),
        labels: i.labels.map((l) => l.name),
        url: i.url,
      }));
    },

    async fetchIssueState(issueNumber: number): Promise<string | null> {
      try {
        const stdout = await gh(
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repo,
          "--json",
          "state",
          "--jq",
          ".state",
        );
        return stdout.toLowerCase();
      } catch {
        return null;
      }
    },
  };
}
