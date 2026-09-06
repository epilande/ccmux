import { basename } from "node:path";
import { BUILTIN_AGENTS } from "./agents";

/**
 * How one agent's tmux pane title reduces to a session summary.
 *
 * Every agent writes something to `pane_title`, but only four write a
 * generated summary of the work; the rest echo the cwd (already the `project`
 * column), their own run state (already `status`), or a static app name. So
 * this is a per-agent rule rather than a generic filter — the same shape
 * `terminalRules`, `errorRules` and `readyPattern` already take, for the same
 * reason: once one agent needs its own pattern there is a table either way.
 *
 * An agent with no rule has no summary, and its cell falls back to the prompt.
 */
export interface SummaryTitleRule {
  /**
   * Decoration around the summary: a status glyph, a spinner frame, an app
   * name the agent appends. Every pattern that matches is removed.
   *
   * Declaring any pattern also makes the rule STRICT: a title matching none
   * of them yields no summary. tmux seeds `pane_title` to the hostname, so a
   * pane whose agent has not written a title yet reads back as the machine
   * name, and a strip-only rule would happily show it as the session's
   * summary. Requiring the agent's own marker is what keeps that out.
   */
  strip?: RegExp[];
  /**
   * Whole titles that carry no summary — the app's own name, the placeholder
   * it shows before the first turn. Tested against the title both before and
   * after {@link strip}, so a rule can name either spelling.
   */
  empty?: RegExp[];
  /**
   * Whether a summary equal to the pane's cwd basename reads as empty.
   *
   * For omp, whose title is `π > <summary>` after a turn but `π > <cwd>`
   * before one: the prefix is present either way, so only the cwd comparison
   * separates a real session title from the directory name that the `project`
   * column already carries.
   */
  cwdBasenameIsEmpty?: boolean;
}

/**
 * The agent's own summary of what a session is doing, read off its tmux pane
 * title, or null when this agent writes nothing worth showing.
 *
 * Pure, and deliberately in `src/lib` rather than the TUI: the daemon runs it
 * too, to decide whether a title change is worth an SSE broadcast (the raw
 * string churns on every spinner frame, the normalized one does not).
 *
 * Built-in rules only. Custom agents get no summary for now — a rule shape on
 * `AgentConfig` can come when someone asks — so the lookup reads
 * `BUILTIN_AGENTS` directly, which also means a user who overrides `claude`
 * to recolor it cannot accidentally drop the rule.
 */
/**
 * Built once. Every row asks for its summary several times per measurement
 * pass (the row's own height, the flex budget, the cell), so a linear scan of
 * the agent table per call would land in the picker's hot path.
 */
const RULES = new Map<string, SummaryTitleRule>(
  BUILTIN_AGENTS.flatMap((a) => (a.summaryTitle ? [[a.name, a.summaryTitle]] : [])),
);

export function summaryFromPaneTitle(
  agentType: string | null | undefined,
  paneTitle: string | null | undefined,
  paneCwd: string | null | undefined,
): string | null {
  if (!agentType || !paneTitle) return null;
  const rule = RULES.get(agentType);
  if (!rule) return null;

  const raw = paneTitle.trim();
  if (raw === "") return null;
  if (rule.empty?.some((re) => re.test(raw))) return null;

  let text = raw;
  if (rule.strip && rule.strip.length > 0) {
    let matched = false;
    for (const re of rule.strip) {
      if (!re.test(text)) continue;
      matched = true;
      text = text.replace(re, "");
    }
    if (!matched) return null;
  }

  text = text.trim();
  if (text === "") return null;
  if (rule.empty?.some((re) => re.test(text))) return null;
  if (rule.cwdBasenameIsEmpty && paneCwd && text === basename(paneCwd)) {
    return null;
  }
  return text;
}
