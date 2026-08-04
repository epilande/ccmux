/**
 * Shared classifier for pi and oh-my-pi (omp), which write byte-identical
 * JSONL schemas (`~/.pi/agent/sessions/...` and `~/.omp/agent/sessions/...`
 * respectively; omp's real dir is `~/.omp/`, NOT `~/.oh-my-pi/`). Not a
 * registered reader itself — `pi.ts` and `omp.ts` each wrap this with their
 * own `agentType`.
 *
 * Envelope: `{type, id, parentId, timestamp, ...}`. Only `type: "message"`
 * carries conversation; `session`, `model_change`, `thinking_level_change`
 * (omp adds `title`, `title_change`, `service_tier_change`, `custom`,
 * `custom_message`) are skipped.
 *
 * `message: {role, content[], timestamp, stopReason}`. Roles: `user`,
 * `assistant`, and `toolResult` — a FIRST-CLASS role, not a content block,
 * and always skipped: omp had a single 146,515-char toolResult message that
 * was 95% of a 155KB file, exactly the case the >256 KiB line-skip and
 * per-turn cap exist for.
 *
 * An assistant message only counts when `stopReason: "stop"` (vs
 * `"toolUse"`, mid-turn tool calls with no user-facing text); its `text`
 * content blocks are the whole turn's response (`thinking`/`toolCall` blocks
 * are skipped).
 *
 * Timestamp drift found vs the research notes (2026-08-03 data claimed
 * "ISO-8601" at both envelope and message level): the ENVELOPE `timestamp`
 * is ISO-8601, but the nested `message.timestamp` is an integer epoch-ms
 * number in every real sample checked. The envelope one is used; the
 * message-level number is ignored rather than reformatted, to avoid
 * silently mis-parsing if a future version changes its unit.
 */

import type { LineMeaning } from "../transcript-read";
import { SKIP_LINE } from "../transcript-read";

function collectTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text") continue; // thinking / toolCall carry no response text
    if (typeof typed.text === "string" && typed.text.length > 0) {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}

export function classifyPiFamilyLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as {
    type?: unknown;
    timestamp?: unknown;
    message?: unknown;
  };
  if (record.type !== "message") return SKIP_LINE;
  const message = record.message;
  if (!message || typeof message !== "object") return SKIP_LINE;
  const typed = message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  // Envelope-level timestamp only; see the module doc for why.
  const timestamp =
    typeof record.timestamp === "string" ? record.timestamp : undefined;

  if (typed.role === "assistant") {
    if (typed.stopReason !== "stop") return SKIP_LINE; // still mid-turn (toolUse)
    const text = collectTextBlocks(typed.content);
    if (!text) return SKIP_LINE;
    return { kind: "assistant", text, timestamp };
  }

  if (typed.role === "user") {
    const text = collectTextBlocks(typed.content);
    if (!text) return SKIP_LINE;
    return { kind: "user", text, timestamp };
  }

  return SKIP_LINE; // toolResult and anything else
}
