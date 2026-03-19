import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ReviewJob } from "./types.ts";

function jobKey(repo: string, prNumber: number): string {
  return `${repo.replace("/", "-")}-${prNumber}`;
}

function jobPath(dataDir: string, repo: string, prNumber: number): string {
  return path.join(dataDir, "reviews", `${jobKey(repo, prNumber)}.json`);
}

export async function saveJob(
  dataDir: string,
  job: ReviewJob
): Promise<void> {
  const dir = path.join(dataDir, "reviews");
  await mkdir(dir, { recursive: true });
  await writeFile(
    jobPath(dataDir, job.repo, job.prNumber),
    JSON.stringify(job, null, 2)
  );
}

export async function loadJob(
  dataDir: string,
  repo: string,
  prNumber: number
): Promise<ReviewJob | null> {
  try {
    const data = await readFile(jobPath(dataDir, repo, prNumber), "utf-8");
    return JSON.parse(data) as ReviewJob;
  } catch {
    return null;
  }
}
