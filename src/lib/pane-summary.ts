import { hostname } from "node:os";
import { basename } from "node:path";
import { BUILTIN_AGENTS } from "./agents";
import type { SummaryTitleRule } from "./agents";
import { stripAnsi } from "./strip-ansi";

/**
 * Built once. The daemon asks for a session's summary on every enrich and
 * again on every scan tick's `syncPaneSummaries`, so a linear scan of the
 * agent table per call would land in a hot path.
 */
const RULES = new Map<string, SummaryTitleRule>(
  BUILTIN_AGENTS.flatMap((a) =>
    a.summaryTitle ? [[a.name, a.summaryTitle]] : [],
  ),
);

/**
 * This machine's name, read once. tmux seeds a new pane's title with it, so
 * every visible session on a scan tick would otherwise pay a syscall to learn
 * the same string.
 */
const HOSTNAME = hostname();

/**
 * The summary as it will be stored and rendered: no escape sequences, no
 * runs of whitespace, no surrounding space.
 *
 * A pane title is free text the agent wrote, exactly like the prompt, and it
 * reaches us through the same `#{pane_title}` read that can carry an escape
 * an agent embedded. Deliberately NOT the TUI's `normalizePrompt`: that one
 * also unwraps Claude's `<command-name>` log markup, which is a property of
 * Claude's JSONL transcript and has no business being applied to a title.
 *
 * `stripAnsi` handles well-formed sequences, so the control sweep after it is
 * what catches the rest: a lone ESC, a BEL, and the C1 block (U+0080-U+009F),
 * which is the practical residue once tmux's own title validation has had its
 * say. Each becomes a SPACE rather than nothing, so the `\s+` collapse behind
 * it still sees a separator: `\n` and `\t` fall under both rules, and
 * deleting them outright would weld two words together.
 */
function normalizeTitle(text: string): string {
  return stripAnsi(text)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The agent's own summary of what a session is doing, read off its tmux pane
 * title, or null when this agent writes nothing worth showing.
 *
 * Pure, and deliberately in `src/lib` rather than the TUI: the DAEMON runs it,
 * once per enrich, and ships the result as `EnrichedSession.summary`. Clients
 * render the shipped field; nothing in the TUI re-derives it.
 *
 * Built-in rules only. Custom agents get no summary for now (a rule shape on
 * `AgentConfig` can come when someone asks), so the lookup reads
 * `BUILTIN_AGENTS` directly, which also means a user who overrides `claude`
 * to recolor it cannot accidentally drop the rule.
 *
 * `host` is injectable for tests only; production always wants this machine.
 */
export function summaryFromPaneTitle(
  agentType: string | null | undefined,
  paneTitle: string | null | undefined,
  paneCwd: string | null | undefined,
  host: string = HOSTNAME,
): string | null {
  if (!agentType || !paneTitle) return null;
  const rule = RULES.get(agentType);
  if (!rule) return null;

  // Normalize the WHOLE title, not just the capture: every rule anchors on
  // `^`, so an escape sequence ahead of the agent's own marker would defeat
  // the match itself. Idempotent, so the capture comes out clean too.
  const title = normalizeTitle(paneTitle);
  if (title === "") return null;
  if (rule.empty?.some((re) => re.test(title))) return null;

  const text = rule.match.exec(title)?.[1]?.trim();
  if (!text) return null;
  if (rule.empty?.some((re) => re.test(text))) return null;
  if (rule.cwdBasenameIsEmpty && paneCwd && text === basename(paneCwd)) {
    return null;
  }
  // A pane whose agent never sets a title keeps tmux's hostname seed forever
  // (`allow-set-title off` is one way to get there), and a permissive rule
  // like cursor's would read that as the session's summary. Both spellings,
  // since tmux may seed the short name while `os.hostname()` answers the FQDN
  // or the reverse; case-insensitive because the two do not always agree
  // there either.
  const lower = text.toLowerCase();
  const lowerHost = host.toLowerCase();
  if (lower === lowerHost || lower === lowerHost.split(".")[0]) return null;
  return text;
}
