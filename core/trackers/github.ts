import { gh } from "../gh.ts";
import type { Issue, TrackerAdapter } from "../types.ts";

type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
  createdAt: string;
};

export function createGitHubTracker(
  activeStates: string[] = ["open"],
): TrackerAdapter {
  return {
    async fetchActiveIssues(repo: string, label: string): Promise<Issue[]> {
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
          "number,title,body,labels,url,createdAt",
        );
        results.push(...JSON.parse(stdout));
      }

      const seen = new Set<number>();

      return results.filter((i) => {
        if (seen.has(i.number)) return false;
        seen.add(i.number);
        return true;
      }).map((i) => ({
        key: `${repo}#${i.number}`,
        number: i.number,
        title: i.title,
        description: i.body ?? "",
        labels: i.labels.map((l) => l.name),
        url: i.url,
        createdAt: i.createdAt,
      }));
    },
  };
}
