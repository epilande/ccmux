/**
 * One PR's or one issue's detail, for the Start view's preview: the body the
 * list does not carry, and for a PR its checks by name and its size.
 *
 * A sibling of `pr-list.ts` and `issue-list.ts`, on the same `gh` plumbing
 * (the injectable runner, the 15s timeout, `ghProblem`'s wording) and the
 * same contract: a failure is `{ ok: false, error }`, never an empty body,
 * because "this PR has no description" and "gh could not answer" are
 * different things to show.
 *
 * Read-only and per item. The list endpoints stay what they are, so a list
 * refresh never pays for bodies nobody is looking at; this runs only for the
 * row the cursor settles on.
 */

import {
  ghProblem,
  runGh,
  type GhRun,
  type SourceResult,
} from "./gh-spawn-source";
import { stripControlChars as stripC0C1 } from "./notify-text";
import { readRollup } from "./pr-list";
import { checkState, type CheckState } from "./pr-resolver";

/**
 * The most body text one answer carries. A body is markdown someone wrote,
 * and the preview shows its top; 20k characters is pages past what the pane
 * can show, and a cap keeps a pathological body (a pasted log) from becoming
 * a megabyte on every cursor move.
 */
export const BODY_MAX_CHARS = 20_000;

/** The most checks one PR detail lists. Matrix builds reach the dozens. */
const MAX_CHECKS = 100;

/**
 * The invisible and reordering characters `gh-spawn-source.ts` strips from
 * titles (bidi controls, zero-width padding, LS/PS), for the same Trojan
 * Source reason: a body is written by whoever opened the PR, on a fork that
 * is anyone, and it renders in the same terminal. C0 and C1 are handled by
 * `notify-text`, which keeps the newlines and tabs a body is made of.
 */
const INVISIBLE_CHARS =
  /[\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/**
 * A body made safe to draw: CRLF and every other control character gone
 * except newlines and tabs, the invisible set gone, and capped at
 * {@link BODY_MAX_CHARS} without splitting a surrogate pair.
 */
export function sanitizeBody(raw: string): {
  body: string;
  truncated: boolean;
} {
  const clean = stripC0C1(raw, { keepNewlines: true, keepTabs: true }).replace(
    INVISIBLE_CHARS,
    "",
  );
  if (clean.length <= BODY_MAX_CHARS) return { body: clean, truncated: false };
  let cut = clean.slice(0, BODY_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { body: cut, truncated: true };
}

/** One check, by name. */
export interface CheckDetail {
  name: string;
  state: CheckState;
}

export interface PRDetail {
  number: number;
  body: string;
  /** The body was cut at {@link BODY_MAX_CHARS}. */
  truncated: boolean;
  baseRefName: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  checks: CheckDetail[];
}

export interface IssueDetail {
  number: number;
  body: string;
  truncated: boolean;
}

/** What `GET /prs/detail` and `GET /issues/detail` answer with. */
export type DetailAnswer<T> =
  | { ok: true; detail: T }
  | { ok: false; error: string };

const PR_DETAIL_FIELDS = [
  "body",
  "baseRefName",
  "additions",
  "deletions",
  "changedFiles",
  "statusCheckRollup",
].join(",");

/** The JSON object a `gh ... view --json` printed, or the problem with it. */
function parseObject(
  what: string,
  stdout: string,
): SourceResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      error: `gh ${what} did not return valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      ok: false,
      error: `gh ${what} did not return valid JSON: expected an object`,
    };
  return { ok: true, value: parsed as Record<string, unknown> };
}

function count(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Every named check in a rollup, failing first, then pending, then the rest,
 * each group in gh's order. A check with no name is left out: a row that
 * says only "✗" tells the reader nothing the badge did not.
 */
export function readChecks(value: unknown): CheckDetail[] {
  const order: Record<CheckState, number> = {
    fail: 0,
    pending: 1,
    pass: 2,
    neutral: 3,
    skip: 4,
  };
  const checks: CheckDetail[] = [];
  for (const entry of readRollup(value) ?? []) {
    const raw = entry.name ?? entry.context;
    const name = raw ? stripC0C1(raw).replace(INVISIBLE_CHARS, "").trim() : "";
    if (name) checks.push({ name, state: checkState(entry) });
  }
  return checks
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        order[a.check.state] - order[b.check.state] || a.index - b.index,
    )
    .slice(0, MAX_CHECKS)
    .map(({ check }) => check);
}

/** PR `number`'s detail, run in `cwd` so gh resolves the repo every other
 *  surface does. Never throws. */
export async function readPRDetail(
  cwd: string,
  number: number,
  run: GhRun = runGh,
): Promise<SourceResult<PRDetail>> {
  const result = await run(cwd, [
    "pr",
    "view",
    String(number),
    "--json",
    PR_DETAIL_FIELDS,
  ]);
  const problem = ghProblem("pr view", result);
  if (problem) return { ok: false, error: problem };
  const parsed = parseObject("pr view", result.stdout);
  if (!parsed.ok) return parsed;
  const row = parsed.value;
  const { body, truncated } = sanitizeBody(
    typeof row.body === "string" ? row.body : "",
  );
  const base = typeof row.baseRefName === "string" ? row.baseRefName : "";
  return {
    ok: true,
    value: {
      number,
      body,
      truncated,
      baseRefName: base ? stripC0C1(base).replace(INVISIBLE_CHARS, "") : null,
      additions: count(row, "additions"),
      deletions: count(row, "deletions"),
      changedFiles: count(row, "changedFiles"),
      checks: readChecks(row.statusCheckRollup),
    },
  };
}

/** Issue `number`'s body. Comments are deliberately not read: they are
 *  unbounded, and the preview is for what the issue asks. */
export async function readIssueDetail(
  cwd: string,
  number: number,
  run: GhRun = runGh,
): Promise<SourceResult<IssueDetail>> {
  const result = await run(cwd, [
    "issue",
    "view",
    String(number),
    "--json",
    "body",
  ]);
  const problem = ghProblem("issue view", result);
  if (problem) return { ok: false, error: problem };
  const parsed = parseObject("issue view", result.stdout);
  if (!parsed.ok) return parsed;
  const { body, truncated } = sanitizeBody(
    typeof parsed.value.body === "string" ? parsed.value.body : "",
  );
  return { ok: true, value: { number, body, truncated } };
}

/**
 * A small counting semaphore. Detail reads are one `gh` process each, and
 * two pickers on a slow network could otherwise stack several; past the
 * limit a read waits its turn rather than spawning.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    // A waiter is handed the finishing task's slot directly (`active` is
    // not decremented in between), so a newcomer arriving in that gap
    // cannot take it as well and run one over the limit.
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
