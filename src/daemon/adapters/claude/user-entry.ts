/**
 * What a Claude Code transcript `user` entry actually is. Claude writes far
 * more than prompts under `type: "user"`, and two consumers must agree on the
 * difference: the status machine (does this entry start a turn?) and the
 * transcript reader (are these the user's words?). One classifier keeps a
 * transcript format change from being fixed in one and missed in the other.
 */

export type ClaudeUserEntryKind =
  /** Something Claude answers with a turn: a typed prompt, a background-task
   *  notification, a teammate message, a `!` shell command. */
  | "prompt"
  /** A prompt-type slash command (a skill or a custom command). It starts a
   *  turn like a prompt, but its text is Claude's markup, not the user's
   *  words. */
  | "command"
  /** Claude's own bookkeeping, which never starts a turn: a local slash
   *  command's record or output (`/clear`, `/model`) and every `isMeta`
   *  injection. */
  | "bookkeeping"
  /** Array content: tool results, which belong to the turn they interrupt. */
  | "tool-result";

/**
 * Leading tags of a local slash command's entries: the `<command-name>`
 * record, the caveat Claude files ahead of it ("not sent to you as a
 * request"), and the output. Matched as a PREFIX because each entry is
 * entirely markup, so a real prompt that merely quotes a tag is unaffected.
 *
 * A `!` shell command's `<bash-input>` / `<bash-stdout>` pair is deliberately
 * NOT here, although it is markup too: Claude Code 2.1.296 answers it with a
 * model turn (observed live, every time), so it starts work like a prompt.
 */
const BOOKKEEPING_PREFIXES = [
  "<command-name>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
];

/**
 * Both kinds of slash command write the same tags, and the LEADING one
 * is what tells them apart. A prompt-type command leads with
 * `<command-message>` (and is followed by an `isMeta` entry carrying the
 * expanded prompt, then the turn). A local command leads with
 * `<command-name>`, sits behind an `isMeta` `<local-command-caveat>`, and
 * runs no turn. Claude Code builds the two shapes in separate functions, and
 * every transcript sampled across 2.1.247-2.1.296 follows the split.
 */
const COMMAND_PREFIX = "<command-message>";

/**
 * Classify one `user` entry. Shape-guarded: a JSON-valid but schema-invalid
 * entry classifies rather than throws.
 */
export function classifyClaudeUserEntry(entry: {
  isMeta?: unknown;
  message?: { content?: unknown };
}): ClaudeUserEntryKind {
  // Checked before the content shape: injected context arrives as text arrays
  // too (a skill's expanded prompt, a plugin's notice), which are not tool
  // results.
  if (entry.isMeta === true) return "bookkeeping";
  const content = entry.message?.content;
  if (typeof content !== "string") return "tool-result";
  const text = content.trimStart();
  if (text.startsWith(COMMAND_PREFIX)) return "command";
  if (BOOKKEEPING_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return "bookkeeping";
  }
  return "prompt";
}
