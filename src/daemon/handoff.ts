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
 * [ccmux handoff] from: <session-id> (<agent> · <cwd> · branch <branch>) at <YYYY-MM-DD HH:MM>
 * note: <note if provided>
 * ```
 *
 * The session id is a POINTER, not a citation: the payload stays lean (the
 * last turn) because a receiving agent can pull more itself with
 * `ccmux last <id> --turns N`. A handoff sends a business card, not the
 * filing cabinet.
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
  const branch = source.branch?.trim();
  const facts = [source.agentType, source.cwd];
  if (branch) facts.push(`branch ${branch}`);
  const lines = [
    `${HANDOFF_PREFIX} from: ${source.sessionId} (${facts.join(" · ")}) at ${formatHandoffTime(at)}`,
  ];
  // Folded to one line: the header's shape is one fact per line, and a
  // multi-line note would make `note:` unparseable for anyone who learns it.
  const cleaned = note?.replace(/\s+/g, " ").trim();
  if (cleaned) lines.push(`note: ${cleaned}`);
  return lines.join("\n");
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
 */
export function composeHandoff(
  header: string,
  payload: string,
  cap: number,
): ComposedHandoff {
  const separator = "\n\n";
  const budget = cap - header.length - separator.length;
  if (payload.length <= budget) {
    return { text: `${header}${separator}${payload}`, truncated: false };
  }
  // "… " marks the cut the same way the per-turn cap in `transcript-read.ts`
  // does, and is charged against the budget so the result really does fit.
  const marker = "… ";
  const keep = Math.max(0, budget - marker.length);
  // `slice(-0)` is `slice(0)`, i.e. the WHOLE string: a header that eats the
  // entire budget would otherwise emit the untruncated payload behind the
  // marker that claims it was cut.
  const tail = keep === 0 ? "" : payload.slice(-keep);
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
