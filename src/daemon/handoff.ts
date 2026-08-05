/**
 * Handing one session's last response to another session.
 *
 * This module holds the two pure parts of `POST /handoff`: the provenance
 * header a receiving agent learns to recognize, and the queue that holds a
 * handoff addressed at a session that is mid-turn. The guard stack and the
 * actual delivery live in `server.ts`, which owns the tmux side.
 *
 * The whole safety case for the feature rests on ONE rule: a handoff is only
 * ever typed into an IDLE composer. Typing into a mid-turn composer is
 * verified for none of the nine agents, so a busy target is queued (here) and
 * a target with a pending prompt is refused outright. There is deliberately
 * no `--force`.
 */

import { stripControlChars } from "./notify-text";

/** Greppable stable prefix. Receiving agents learn this shape; see the
 *  provenance section of `session-handoff-plan.md`, where it is FROZEN. */
export const HANDOFF_PREFIX = "[ccmux handoff]";

/**
 * Longest sender note accepted. A note is a one-liner ("this is the failing
 * test, take it from here"), and the cap is what keeps the header's own size
 * bounded so the payload budget below can be computed without the header
 * being able to eat it.
 */
export const MAX_HANDOFF_NOTE_CHARS = 500;

/** How long a queued handoff waits for its target to finish its turn. The
 *  sender was already told it was queued, so expiry is logged, not reported
 *  back to anyone. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

/** Sweep cadence for the record store (same idiom as `invocation-manager`'s
 *  finished-record sweep: purge-on-access plus a timer, so growth is bounded
 *  by call rate × TTL rather than by call rate alone). */
export const HANDOFF_SWEEP_MS = 60 * 1000;

/**
 * How many delivery attempts a queued handoff gets before it is dropped for
 * good. Only TRANSIENT failures are retried (see `deliverQueuedHandoff` in
 * `server.ts`), so this bounds a tmux that is briefly unreachable rather than
 * a refusal, which would otherwise retry the same rejection until the TTL.
 */
export const MAX_HANDOFF_ATTEMPTS = 3;

/** The source session, as the header describes it. */
export interface HandoffSource {
  sessionId: string;
  agentType: string;
  cwd: string;
  /** Omitted cleanly when the session carries no branch. Never shelled out
   *  for: this is whatever enrichment already knows. */
  branch?: string | null;
}

/** Local time, minutes precision, `YYYY-MM-DD HH:MM`. */
export function formatHandoffTime(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * The provenance header. FROZEN — receiving agents will learn this shape, so
 * changing it silently breaks every prompt already trained on it.
 *
 * ```
 * [ccmux handoff] from: <session-id> (<agent> · `<cwd>` · branch <branch>) at <YYYY-MM-DD HH:MM>
 * note: <note if provided>
 * ```
 *
 * The session id is a POINTER, not a citation: the payload stays lean (the
 * last turn) because a receiving agent can pull more itself with
 * `ccmux last <id> --turns N`. A handoff sends a business card, not the
 * filing cabinet.
 *
 * A receiver identifies the header as the FIRST line of the message, and as
 * the only line carrying {@link HANDOFF_PREFIX} at column 0: `composeHandoff`
 * quotes any payload line that would otherwise claim the same shape.
 *
 * The cwd is BACKTICKED, and that is load-bearing rather than decorative.
 * Cursor's `unsafeReplyPattern` is `/(^|\s)\/\S/`, which a bare absolute path
 * after a space matches, so an unquoted cwd made ccmux's own header trip the
 * delivery guard and refuse every handoff into a cursor target. A branch name
 * cannot begin with `/` (git refuses the ref), so it needs no such quoting.
 *
 * Because the header is PREPENDED, the composed message can never lead with
 * `/` or `!`, which is the whole reason the slash/bang defuse is a no-op for
 * handoff (it is still run at delivery, see `server.ts`: a guard that is
 * provably unnecessary today is one refactor away from being necessary).
 */
export function formatHandoffHeader(
  source: HandoffSource,
  at: Date,
  note?: string,
): string {
  // Every interpolated fact is flattened to a single line BEFORE the
  // template, because a newline here forges a header line rather than merely
  // dirtying one. The composed text's own strip (`server.ts`) keeps newlines,
  // since the payload needs them, and so cannot catch this. A cwd may legally
  // contain a newline on POSIX, which is the reachable case.
  const flat = (value: string): string =>
    stripControlChars(value, { keepNewlines: false, keepTabs: false });
  const branch = flat(source.branch?.trim() ?? "");
  const facts = [flat(source.agentType), `\`${flat(source.cwd)}\``];
  if (branch) facts.push(`branch ${branch}`);
  const lines = [
    `${HANDOFF_PREFIX} from: ${flat(source.sessionId)} (${facts.join(" · ")}) at ${formatHandoffTime(at)}`,
  ];
  // Folded to one line: the header's shape is one fact per line, and a
  // multi-line note would make `note:` unparseable for anyone who learns it.
  const cleaned = note?.replace(/\s+/g, " ").trim();
  if (cleaned) lines.push(`note: ${cleaned}`);
  return lines.join("\n");
}

/**
 * The one wording for a payload the target agent's composer cannot safely
 * receive. Shared by the enqueue-time and delivery-time checks, which are the
 * same check run at two moments and must not describe it two ways.
 */
export function unsafeHandoffError(agentType: string): string {
  return `The composed handoff contains text ${agentType}'s composer cannot receive safely`;
}

export interface ComposedHandoff {
  text: string;
  /** True when the payload's head was dropped to fit the cap. */
  truncated: boolean;
}

/**
 * Header + blank line + payload, capped.
 *
 * The cap applies to the FINAL text (header included) because the cap is a
 * transport budget for what gets pasted into a pane, not a budget for the
 * response we read. Truncation is TAIL-preserving: a response's conclusion,
 * which is the part worth handing off, is at its end.
 *
 * A payload can contain its own `[ccmux handoff]` line — a peer quoting one
 * back, or an outright forgery — and tail-preserving truncation would even
 * guarantee a trailing fake header survived. Any payload line that would pass
 * for the real one is therefore QUOTED with `> `, so the genuine header stays
 * the only line in the message carrying the prefix at column 0.
 */
export function composeHandoff(
  header: string,
  payload: string,
  cap: number,
): ComposedHandoff {
  // Quoted BEFORE the cut, so the cut cannot restore a forgery: a tail that
  // starts mid-line has the marker in front of it, and a tail that starts at
  // a line boundary starts at that line's `> `.
  const quoted = payload
    .split("\n")
    .map((line) =>
      line.trimStart().startsWith(HANDOFF_PREFIX) ? `> ${line}` : line,
    )
    .join("\n");
  const separator = "\n\n";
  const budget = cap - header.length - separator.length;
  if (quoted.length <= budget) {
    return { text: `${header}${separator}${quoted}`, truncated: false };
  }
  // "… " marks the cut the same way the per-turn cap in `transcript-read.ts`
  // does, and is charged against the budget so the result really does fit.
  const marker = "… ";
  const keep = Math.max(0, budget - marker.length);
  // `slice(-0)` is `slice(0)`, i.e. the WHOLE string: a header that eats the
  // entire budget would otherwise emit the untruncated payload behind the
  // marker that claims it was cut.
  let tail = keep === 0 ? "" : quoted.slice(-keep);
  // The cut is measured in UTF-16 units, so it can land BETWEEN the halves of
  // a surrogate pair (any emoji, any astral CJK). A leading low surrogate is
  // an unpaired code unit that renders as U+FFFD and encodes as garbage on
  // the way to the pane, so drop the orphan rather than paste it.
  const lead = tail.charCodeAt(0);
  if (lead >= 0xdc00 && lead <= 0xdfff) tail = tail.slice(1);
  return {
    text: `${header}${separator}${marker}${tail}`,
    truncated: true,
  };
}

/** The `spawn` field of a handoff request: "open a new session for this
 *  instead of naming an existing one". Everything is optional because the
 *  source session supplies both defaults (its own agent and directory). */
export interface HandoffSpawnRequest {
  agent?: string;
  cwd?: string;
}

export type HandoffSpawnResult =
  | { ok: true; value: HandoffSpawnRequest | null }
  | { ok: false; error: string };

/**
 * Validate the wire `spawn` field. `true` is the bare "spawn something" form
 * (`ccmux handoff <from> --spawn`), an object carries overrides, and absent
 * means the handoff addresses an existing session.
 */
export function normalizeHandoffSpawn(value: unknown): HandoffSpawnResult {
  if (value === undefined || value === null || value === false) {
    return { ok: true, value: null };
  }
  if (value === true) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "Invalid 'spawn' field: expected true or an object",
    };
  }
  const raw = value as Record<string, unknown>;
  const request: HandoffSpawnRequest = {};
  if (raw.agent !== undefined && raw.agent !== null) {
    if (typeof raw.agent !== "string" || raw.agent.trim() === "") {
      return { ok: false, error: "Invalid 'spawn.agent' field" };
    }
    request.agent = raw.agent.trim();
  }
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") {
      return { ok: false, error: "Invalid 'spawn.cwd' field" };
    }
    request.cwd = raw.cwd;
  }
  return { ok: true, value: request };
}

/** A handoff waiting for its target to finish the turn it was in. */
export interface PendingHandoffRecord {
  fromSessionId: string;
  toSessionId: string;
  /** The COMPOSED message, header included. Held verbatim so the delivery
   *  re-runs the guards over exactly what gets pasted, not over a
   *  reconstruction of it. */
  text: string;
  /** Epoch ms. */
  queuedAt: number;
  /** Epoch ms. */
  expiresAt: number;
  truncated: boolean;
  /** Delivery attempts already spent, absent on a record that has not been
   *  tried yet. Bumped only by {@link HandoffQueue.requeue}. */
  attempts?: number;
}

export interface HandoffQueueOptions {
  /** Fired when the TTL sweep drops a record, so the daemon can log it and
   *  re-broadcast the target session without its `pendingHandoff`. */
  onExpire?: (record: PendingHandoffRecord) => void;
  now?: () => number;
  /** Injected so a test can drive the sweep without a real timer. */
  setSweep?: (fn: () => void, ms: number) => void;
}

/**
 * At most ONE pending handoff per target, in memory, TTL-swept.
 *
 * One-per-target is a policy, not a limitation: a queue of prompts would
 * arrive as a burst of pastes the moment the target went idle, which is
 * exactly the "several messages land at once" behavior the idle-only rule
 * exists to avoid. A second enqueue REPLACES the first and says so, so the
 * sender learns their predecessor was dropped rather than silently losing it.
 *
 * Modeled on `invocation-manager.ts`'s record store: a plain `Map`, purge on
 * access, plus an `.unref()`'d sweep timer so the store can never keep the
 * daemon process alive on its own.
 */
export class HandoffQueue {
  private pending = new Map<string, PendingHandoffRecord>();
  private now: () => number;
  private onExpire?: (record: PendingHandoffRecord) => void;

  constructor(options: HandoffQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onExpire = options.onExpire;
    const setSweep =
      options.setSweep ??
      ((fn, ms) => {
        setInterval(fn, ms).unref();
      });
    setSweep(() => this.sweep(), HANDOFF_SWEEP_MS);
  }

  /** Queue a handoff, replacing (and returning) any the target already had. */
  enqueue(record: Omit<PendingHandoffRecord, "queuedAt" | "expiresAt">): {
    record: PendingHandoffRecord;
    replaced: PendingHandoffRecord | null;
  } {
    const replaced = this.peek(record.toSessionId);
    const queuedAt = this.now();
    const stored: PendingHandoffRecord = {
      ...record,
      queuedAt,
      expiresAt: queuedAt + HANDOFF_TTL_MS,
    };
    this.pending.set(record.toSessionId, stored);
    return { record: stored, replaced };
  }

  /** The target's pending handoff, or null. Expired entries are purged on
   *  access rather than returned. */
  peek(toSessionId: string): PendingHandoffRecord | null {
    const record = this.pending.get(toSessionId);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.pending.delete(toSessionId);
      this.onExpire?.(record);
      return null;
    }
    return record;
  }

  /**
   * Remove and return the target's pending handoff. Synchronous removal is
   * what makes concurrent `working -> idle` observations safe: two overlapping
   * deliveries cannot both get the record, so a handoff is never pasted twice.
   */
  take(toSessionId: string): PendingHandoffRecord | null {
    const record = this.peek(toSessionId);
    if (record) this.pending.delete(toSessionId);
    return record;
  }

  /**
   * Put a taken record BACK after a TRANSIENT delivery failure, with its
   * `attempts` already bumped by the caller.
   *
   * The record keeps its original `queuedAt`/`expiresAt`: the TTL bounds a
   * handoff's whole lifetime, so a retry must not be able to extend it. It
   * also refuses to overwrite a record that arrived while this one was out
   * being delivered — that newer handoff was announced to its sender as
   * queued, and a silent replacement is exactly what the replace-and-report
   * policy exists to prevent. Returns whether the record went back in.
   */
  requeue(record: PendingHandoffRecord): boolean {
    if (record.expiresAt <= this.now()) {
      this.onExpire?.(record);
      return false;
    }
    if (this.peek(record.toSessionId)) return false;
    this.pending.set(record.toSessionId, record);
    return true;
  }

  /** Drop a target's pending handoff without delivering it (the session went
   *  away). Silent: nothing is owed to a session that no longer exists. */
  drop(toSessionId: string): void {
    this.pending.delete(toSessionId);
  }

  sweep(): void {
    const now = this.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) {
        this.pending.delete(id);
        this.onExpire?.(record);
      }
    }
  }

  size(): number {
    return this.pending.size;
  }
}
