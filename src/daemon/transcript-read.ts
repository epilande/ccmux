/**
 * Transcript reading primitives: the backwards line walk, the per-agent
 * reader interface, and the JSONL turn fold every line-based agent shares.
 *
 * The registry and the agent readers live in `transcript-readers/`; this
 * module holds only what they build on, so a reader can import it without a
 * cycle.
 *
 * Why a backwards line walk rather than a fixed byte window: a single Claude
 * JSONL line can be hundreds of KB (a 665K-char tool result exists in a real
 * transcript), which defeats every fixed window the codebase already has
 * (`readTranscriptTail` returns "" when its window holds no newline). Walking
 * backwards line by line lets an oversized line be SKIPPED unparsed while the
 * walk continues, and lets the fold stop as soon as it has the turns it was
 * asked for.
 */

/**
 * Lines longer than this are skipped WITHOUT being parsed. In every sampled
 * transcript a line this size is a tool result, and tool inputs/outputs are
 * never part of a transcript response.
 */
export const MAX_LINE_BYTES = 256 * 1024;

/** Per-turn text cap; the tail is kept because a response's conclusion is at
 *  the end (same rule as `tui/utils/transcript.ts`'s MAX_TRANSCRIPT_CHARS). */
export const MAX_TURN_CHARS = 20_000;

/** How many turns a caller may ask for (the endpoint clamps to this). */
export const MAX_TURNS = 20;

/** One entry of a transcript response: a user prompt or an assistant reply. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  /** Absent when the agent's format carries no timestamp (Cursor). */
  timestamp?: string;
}

export interface TranscriptResult {
  /** Oldest first. */
  turns: TranscriptTurn[];
  /** True when any size guard dropped content. */
  truncated: boolean;
}

/**
 * The session facts a reader may need. Deliberately not "a file of lines":
 * the OpenCode reader queries SQLite by native session id and the Gemini
 * reader locates a whole-file JSON by cwd, so both live behind this same
 * interface.
 */
export interface TranscriptSession {
  id: string;
  agentType: string;
  logPath: string | null;
  cwd: string;
  nativeSessionId?: string;
}

/**
 * One agent's transcript reader. `null` means "no transcript to read"
 * (missing path, unreadable file, no completed turn yet) and the endpoint
 * falls back to a pane capture.
 */
export interface TranscriptReader {
  agentType: string;
  read(
    session: TranscriptSession,
    turns: number,
  ): Promise<TranscriptResult | null>;
}

const NEWLINE = 0x0a;
/** `subarray` of a file-backed chunk widens the buffer type, so the walk's
 *  byte handles are typed loosely enough to hold both. */
type Bytes = Uint8Array<ArrayBufferLike>;
const EMPTY: Bytes = new Uint8Array(0);

function concat(head: Bytes, tail: Bytes): Bytes {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/**
 * Yield a file's lines newest-first. A line whose byte length exceeds
 * {@link MAX_LINE_BYTES} yields `null` instead of its text: the caller counts
 * that as dropped content without ever materializing or parsing it. Empty
 * lines are skipped. Any read error simply ends the walk.
 *
 * Byte-level on purpose: slicing a file at a chunk boundary can split a
 * multi-byte UTF-8 character, so bytes are joined across chunks and decoded
 * only once a whole line is in hand.
 */
export async function* readLinesBackwards(
  path: string,
  chunkSize = 64 * 1024,
): AsyncGenerator<string | null> {
  const decoder = new TextDecoder();
  let file: ReturnType<typeof Bun.file>;
  let pos: number;
  try {
    file = Bun.file(path);
    pos = file.size;
  } catch {
    return;
  }
  // A non-finite size (Bun.file("/dev/zero").size is Infinity) or a
  // non-positive chunk would both leave the walk below unable to reach 0.
  if (!pos || !Number.isFinite(pos) || chunkSize <= 0) return;

  /** Bytes of the leftmost, not-yet-delimited line seen so far. */
  let carry: Bytes = EMPTY;
  /** True once `carry` has outgrown the guard; its bytes are then dropped
   *  rather than accumulated, so one pathological line can't blow memory. */
  let carryOversized = false;

  const startLine = (bytes: Bytes): void => {
    if (bytes.length > MAX_LINE_BYTES) {
      carry = EMPTY;
      carryOversized = true;
      return;
    }
    carry = bytes;
    carryOversized = false;
  };

  const prependToCarry = (bytes: Bytes): void => {
    if (carryOversized) return;
    if (bytes.length + carry.length > MAX_LINE_BYTES) {
      carry = EMPTY;
      carryOversized = true;
      return;
    }
    carry = concat(bytes, carry);
  };

  const finishLine = (): string | null | undefined => {
    if (carryOversized) {
      carry = EMPTY;
      carryOversized = false;
      return null;
    }
    if (carry.length === 0) return undefined;
    const text = decoder.decode(carry);
    carry = EMPTY;
    return text;
  };

  while (pos > 0) {
    const start = Math.max(0, pos - chunkSize);
    let chunk: Bytes;
    try {
      chunk = new Uint8Array(await file.slice(start, pos).arrayBuffer());
    } catch {
      return;
    }
    pos = start;

    // Newline offsets in this chunk, ascending.
    const newlines: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === NEWLINE) newlines.push(i);
    }

    if (newlines.length === 0) {
      prependToCarry(chunk);
      continue;
    }

    // The bytes after the LAST newline complete whatever carry holds.
    prependToCarry(chunk.subarray(newlines[newlines.length - 1] + 1));
    const last = finishLine();
    if (last !== undefined) yield last;

    // Then every fully-contained line, right to left.
    for (let k = newlines.length - 1; k >= 1; k--) {
      startLine(chunk.subarray(newlines[k - 1] + 1, newlines[k]));
      const line = finishLine();
      if (line !== undefined) yield line;
    }

    // Bytes before the FIRST newline start the next (further-left) line.
    startLine(chunk.subarray(0, newlines[0]));
  }

  const first = finishLine();
  if (first !== undefined) yield first;
}

/**
 * What one transcript line means to the fold. `authoritative` marks a
 * fragment that IS the whole turn's assistant text (Codex's
 * `task_complete.last_agent_message`), so the per-message fragments it
 * duplicates are ignored.
 */
export type LineMeaning =
  | {
      kind: "assistant";
      text: string;
      timestamp?: string;
      authoritative?: true;
    }
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "skip" };

const SKIP: LineMeaning = { kind: "skip" };
export { SKIP as SKIP_LINE };

/**
 * Apply the per-turn cap, keeping the tail. Exported so the two direct
 * readers (OpenCode, Gemini) that don't go through {@link foldJsonlTurns}
 * can apply the exact same guard rather than a hand-rolled equivalent.
 */
export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TURN_CHARS) return { text, truncated: false };
  return { text: "… " + text.slice(-MAX_TURN_CHARS), truncated: true };
}

/**
 * Fold a JSONL transcript's tail into the last `turns` assistant responses.
 *
 * Counting: a turn is one user -> assistant exchange, counted backwards, and
 * only COMPLETED turns are returned (a trailing user prompt the agent hasn't
 * answered yet is skipped). The result holds up to `turns` assistant entries
 * and the user prompts BETWEEN them — never a leading prompt, so the shape is
 * the same whether the transcript ran out or the count did. `turns=1` is
 * therefore exactly one assistant entry (the "last response", the same
 * single-entry shape the pane fallback produces) and `turns=2` is
 * `[assistant, user, assistant]`, oldest first.
 *
 * A turn is an EXCHANGE, not a response: consecutive assistant responses with
 * no user entry between them are one turn's fragments and merge into a single
 * entry, so asking for N can legitimately return fewer than N. That is also
 * how a classifier that skips a boundary shape (Claude's slash-command
 * markup, say) folds the responses either side of it together.
 *
 * The same is true of a line the size guard drops: an oversized line
 * (> {@link MAX_LINE_BYTES}) is skipped WITHOUT being parsed, so if it happened
 * to be a user entry its boundary is lost and the responses around it merge.
 * `truncated` going true is the only signal that anything was dropped.
 *
 * Returns null when the file is unreadable or holds no assistant text, which
 * the endpoint reads as "fall back to the pane".
 */
export async function foldJsonlTurns(
  path: string,
  turns: number,
  classify: (entry: unknown) => LineMeaning,
): Promise<TranscriptResult | null> {
  // Built newest-first, reversed at the end.
  const out: TranscriptTurn[] = [];
  let pending: string[] = [];
  let pendingTimestamp: string | undefined;
  let pendingLocked = false;
  /** Set once `pending` provably holds more than the cap will keep; further
   *  fragments of the same turn are then walked but not stored. */
  let pendingFull = false;
  /** Running length of `joinPending(pending)`, cheap enough to test every
   *  fragment; the exact check below only runs once it is over the cap. */
  let pendingChars = 0;
  let truncated = false;

  const joinPending = (parts: string[]): string => parts.join("\n\n").trim();

  const pushTurn = (
    role: "user" | "assistant",
    text: string,
    timestamp: string | undefined,
  ): void => {
    const capped = capText(text);
    if (capped.truncated) truncated = true;
    out.push(
      timestamp
        ? { role, text: capped.text, timestamp }
        : { role, text: capped.text },
    );
  };

  /**
   * The prompt of the turn one step newer than the one being assembled. Held
   * rather than emitted so it can be DROPPED when the walk ends without
   * another response: that is what keeps a leading prompt out of the result
   * no matter which limit (the count or the head of the file) stopped us.
   */
  let heldUser: { text: string; timestamp?: string } | null = null;

  /** Emit the accumulated assistant fragments as one turn. */
  const flushAssistant = (): boolean => {
    const text = joinPending(pending);
    pending = [];
    pendingLocked = false;
    pendingFull = false;
    pendingChars = 0;
    const timestamp = pendingTimestamp;
    pendingTimestamp = undefined;
    if (!text) return false;
    // Newest-first order: the held prompt sits between this response and the
    // newer one already pushed.
    if (heldUser) {
      pushTurn("user", heldUser.text, heldUser.timestamp);
      heldUser = null;
    }
    pushTurn("assistant", text, timestamp);
    return true;
  };

  let assistantCount = 0;
  let sawLine = false;

  for await (const line of readLinesBackwards(path)) {
    sawLine = true;
    if (line === null) {
      // An oversized line was skipped unparsed.
      truncated = true;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const meaning = classify(entry);
    if (meaning.kind === "skip") continue;

    if (meaning.kind === "assistant") {
      if (pendingLocked) continue;
      if (meaning.authoritative) {
        pending = [meaning.text];
        pendingChars = meaning.text.length;
        pendingLocked = true;
        pendingTimestamp = meaning.timestamp ?? pendingTimestamp;
      } else {
        if (!pendingFull) {
          pending.unshift(meaning.text);
          pendingChars += pendingChars
            ? meaning.text.length + 2
            : meaning.text.length;
          // Once the turn provably holds more than the cap will keep, stop
          // STORING further fragments (the walk goes on, for boundaries).
          // Output-identical rather than merely close: the walk collects
          // newest-first and `capText` keeps the tail, so every fragment
          // past this point lands in the head it would cut anyway. The
          // running count is only a trigger for the exact test, because a
          // fragment run that trims back under the cap must keep growing.
          if (
            pendingChars > MAX_TURN_CHARS &&
            joinPending(pending).length > MAX_TURN_CHARS
          ) {
            pendingFull = true;
          }
        }
        // The first timestamp seen walking backwards is the newest fragment's,
        // i.e. when the response finished.
        pendingTimestamp ??= meaning.timestamp;
      }
      continue;
    }

    // A user prompt closes the turn its answer belongs to.
    if (!flushAssistant()) continue; // unanswered prompt: not a completed turn
    assistantCount++;
    if (assistantCount >= turns) break;
    heldUser = { text: meaning.text, timestamp: meaning.timestamp };
  }

  // A response at the head of the file (no prompt left to close it) still
  // counts; a held prompt with no response behind it is dropped.
  if (assistantCount < turns) flushAssistant();

  if (!sawLine || out.length === 0) return null;
  out.reverse();
  return { turns: out, truncated };
}
