import type { AgentDef, TerminalRule } from "../lib/agents";
import type { AttentionType, SessionStatus } from "../types/session";
import { stripAnsi } from "../lib/strip-ansi";

export interface TerminalDetectionResult {
  status: SessionStatus;
  attentionType: AttentionType;
  pendingTool: string | null;
}

function matchesRule(content: string, rule: TerminalRule): boolean {
  if (rule.match) return rule.match.test(content);

  if (rule.matchAll) {
    return rule.matchAll.every((pattern) =>
      content.includes(pattern.toLowerCase()),
    );
  }

  return (
    rule.matchAny?.some((pattern) => content.includes(pattern.toLowerCase())) ??
    false
  );
}

function toDetectionResult(rule: TerminalRule): TerminalDetectionResult {
  return {
    status: rule.status,
    attentionType: rule.attentionType,
    pendingTool: rule.pendingTool,
  };
}

/**
 * Return the detection result from the first matching terminal rule, or
 * `null` when nothing matches. Use this when the caller wants to
 * distinguish "rule fired" from "no rule matched" (e.g. the reconciler's
 * Option Y overlay, which keeps log-derived state when no terminal rule
 * fires instead of defaulting to idle).
 */
export function matchTerminalRule(
  content: string,
  agent: AgentDef,
): TerminalDetectionResult | null {
  const stripped = stripAnsi(content);
  // Trim trailing empty lines first: agents like Cursor render permission
  // prompts with significant vertical padding (the prompt text sits 25+
  // lines above the bottom of the pane), which would otherwise push the
  // discriminator outside the last-30-line inspection window. Trimming
  // doesn't reach further back into history because capturePane already
  // caps the input at 50 lines via `-S-50`.
  const trimmed = stripped.replace(/\n+$/, "");
  const lastLines = trimmed.split("\n").slice(-30).join("\n").toLowerCase();

  for (const rule of agent.terminalRules) {
    if (matchesRule(lastLines, rule)) {
      return toDetectionResult(rule);
    }
  }

  return null;
}

/**
 * Terminal-rule detection with a default-idle fallback. Preserved for
 * callers that want a non-null result regardless of rule matches
 * (notably `detectPaneState` in pane-classify.ts for Claude pane inspection).
 */
export function detectTerminalStatus(
  content: string,
  agent: AgentDef,
): TerminalDetectionResult {
  return (
    matchTerminalRule(content, agent) ?? {
      status: "idle",
      attentionType: null,
      pendingTool: null,
    }
  );
}
