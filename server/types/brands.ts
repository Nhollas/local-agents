import { z } from "zod";

export const repoSlugSchema = z.string().min(1).brand<"RepoSlug">();
export type RepoSlug = z.infer<typeof repoSlugSchema>;
export const repoSlug = (value: string): RepoSlug => value as RepoSlug;

export const issueKeySchema = z.string().min(1).brand<"IssueKey">();
export type IssueKey = z.infer<typeof issueKeySchema>;
export const issueKey = (value: string): IssueKey => value as IssueKey;

export const issueNumberSchema = z.number().brand<"IssueNumber">();
export type IssueNumber = z.infer<typeof issueNumberSchema>;
export const issueNumber = (value: number): IssueNumber => value as IssueNumber;

export const runIdSchema = z.string().min(1).brand<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;
export const runId = (value: string): RunId => value as RunId;
