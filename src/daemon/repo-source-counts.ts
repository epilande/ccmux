import {
  ghProblem,
  runGh,
  type GhRun,
  type SourceResult,
} from "./gh-spawn-source";

export interface RepoSourceCounts {
  prs: number;
  issues: number;
}
/** Counts are exact even when the source lists reach their display cap. */
export async function readRepoSourceCounts(
  cwd: string,
  run: GhRun = runGh,
): Promise<SourceResult<RepoSourceCounts>> {
  const response = await run(cwd, [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-f",
    "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN){totalCount} issues(states:OPEN){totalCount}}}",
  ]);
  const problem = ghProblem("repo counts", response);
  if (problem) return { ok: false, error: problem };
  try {
    const body: unknown = JSON.parse(response.stdout);
    const object = (v: unknown): Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    const repo = object(object(object(body).data).repository);
    const prs = object(repo.pullRequests).totalCount;
    const issues = object(repo.issues).totalCount;
    if (
      typeof prs !== "number" ||
      typeof issues !== "number" ||
      !Number.isSafeInteger(prs) ||
      !Number.isSafeInteger(issues) ||
      prs < 0 ||
      issues < 0
    )
      throw new Error("missing counts");
    return { ok: true, value: { prs, issues } };
  } catch {
    return { ok: false, error: "GitHub did not return repository counts" };
  }
}
