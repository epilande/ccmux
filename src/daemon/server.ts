import { statSync } from "node:fs";
import { basename, relative, isAbsolute, resolve } from "node:path";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  HEARTBEAT_INTERVAL_MS,
  MAX_SEND_TEXT_CHARS,
  isCcmuxPane,
  resolvedHomeDir,
} from "../lib/config";
import { getPreferences } from "../lib/preferences";
import { listTmuxClientTtys } from "../lib/tmux-client";
import {
  capturePane,
  resolvePaneLocation,
  sendLiteralToPane,
  sendPromptToPane,
} from "./pane-io";
import {
  buildAgentForkCommand,
  buildAgentSpawnCommand,
  buildTmuxSpawnArgv,
  forkResumesByIdAlone,
  normalizeBoolean,
  normalizeClientTty,
  normalizePrompt,
  resolveSpawnFocusArgv,
  normalizeSplit,
  normalizeTarget,
  normalizeWorktreeRequest,
  spawnCommandTooLarge,
  substitutePlaceholders,
  NATIVE_SESSION_ID_PATTERN,
  type BuildResult,
  type SpawnPlacement,
  type SpawnSplit,
} from "./spawn-command";
import {
  createWorktree,
  ensureWorktreesExcluded,
  existingWorktreeFor,
  type WorktreeCreation,
} from "./worktree-create";
import { getAgents, type AgentDef } from "../lib/agents";
import { listSpawnableAgents, spawnBinaryFor } from "../lib/spawnable-agents";
import {
  getMarkerKey,
  isBackgroundSession,
  type SessionManager,
  type SessionEvent,
} from "./sessions";
import type {
  SSEEvent,
  FinishedInvocationStatus,
  DaemonHealth,
} from "../types";
import type { Session, TmuxPane, EnrichedSession } from "../types/session";
import type { AttentionTracker } from "./attention-tracker";
import type { InvocationManager, InvocationEvent } from "./invocation-manager";
import { readInvocationResult } from "./invocation-results";
import { INVOCATION_ID_PATTERN } from "../lib/invoke-helpers";
import { noInvokeModeMessage } from "./invokers/helpers";
import { capabilitiesFor } from "./invokers/invoker";
import type { InvokeInput, InvokeResult } from "./invokers/types";
import type { HookAdapter } from "./hook-adapter";
import { PRResolver } from "./pr-resolver";
import {
  deriveProject,
  deriveProjectInfo,
  worktreeFacts,
} from "./project-derivation";
import {
  searchTranscript,
  MIN_QUERY_LEN,
  SEARCH_CONCURRENCY,
  type SessionMatches,
} from "./transcript-search";
import {
  runPrune,
  scanRepos,
  type PruneCandidate,
  type PruneScan,
  type WorktreeSession,
} from "./worktree-prune";
import { fetchPrune, normalizePath } from "./worktree-git";
import {
  moveChangesToWorktree,
  readUncommitted,
  type CreateWorktree,
  type UntrackedMode,
} from "./worktree-move-changes";
import type {
  NotificationActionInput,
  NotificationActionResult,
} from "./notification-action";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What a `withChanges` spawn relocated, echoed back on success.
 *
 * `moved` counts tracked files; `untracked` says which mode ran and which
 * paths it covered. `leftoverStash` is the one thing a SUCCESSFUL move can
 * still leave behind (the entry was applied but could not be dropped), and it
 * is reported so it can be cleaned up rather than found later as a mystery.
 * `flattenedIndex` says the staged/unstaged split could not be preserved.
 *
 * `source` names the checkout the work came out of. The caller cannot derive
 * it: on a `--fork` spawn the source is the forked session's directory, which
 * is resolved here and nowhere else.
 */
interface SpawnMoveReport {
  moved: number;
  source: string;
  untracked: { mode: UntrackedMode; files: string[] };
  leftoverStash?: string;
  flattenedIndex?: boolean;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * SSE client connection
 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController<string>;
}

/** Function to get the current pane cache from the daemon */
type PaneCacheGetter = () => Map<string, TmuxPane>;
type AgentLookup = (agentType: string) => AgentDef | undefined;
interface PaneSendDeps {
  sendLiteralToPane: typeof sendLiteralToPane;
  sendPromptToPane: typeof sendPromptToPane;
}

/** Runs one actionable-notification callback (constructed in `index.ts` with
 *  its effect deps, so the server stays dumb transport). See
 *  `notification-action.ts`. */
type NotificationActionRunner = (
  input: NotificationActionInput,
) => Promise<NotificationActionResult>;

/** Retracts a session's delivered notification (constructed in `index.ts`,
 *  sharing the delivery closure's backend/dbus state). Fired when the user
 *  focuses a pane whose session had pending attention. Fail-open. */
type NotificationRetractFn = (sessionId: string) => Promise<void>;

/** The session a `POST /spawn` fork continues from. The native id is carried
 *  alongside the session because it is what the fork command interpolates,
 *  and `resolveForkSource` has already established that it is present. */
interface ForkSource {
  session: Readonly<Session>;
  nativeSessionId: string;
}

/** A cwd's git facts, all derived from one `git rev-parse` call. */
interface GitInfo {
  branch: string | null;
  isWorktree: boolean;
  /** Root of the main checkout this cwd's repo hangs off, or null when
   *  unknown (not a repo, or a bare repo with no checkout). */
  mainRepoRoot: string | null;
  /** Root of the checkout the cwd sits in (`--show-toplevel`): the
   *  worktree's own directory, or the main checkout when it isn't one. */
  worktreeRoot: string | null;
}

interface GitInfoCacheEntry {
  info: GitInfo;
  expiresAt: number;
}

/** A cwd git can't answer for: not a repo, unborn HEAD, deleted dir. */
const UNKNOWN_GIT_INFO: GitInfo = {
  branch: null,
  isWorktree: false,
  mainRepoRoot: null,
  worktreeRoot: null,
};

/**
 * `git rev-parse` echoes an option it doesn't understand back as a literal
 * output line AND exits 0, so an older git (or a shim that drops unknown
 * flags) would otherwise hand us `--git-common-dir` as if it were a path —
 * which compares unequal to the git dir and marks EVERY session a worktree.
 * Any answer starting with `--` is therefore unanswerable, not a path.
 */
function isEchoedFlag(line: string): boolean {
  return line.startsWith("--");
}

const GIT_INFO_CACHE_TTL_MS = 30_000;
/** How often to sweep visible sessions' (cwd, branch) keys through the
 *  PR resolver. Sweeps are cheap (cache reads that never spawn git; only
 *  expired PR keys spawn gh), and worst-case PR staleness = resolver TTL +
 *  this interval. */
const PR_SWEEP_INTERVAL_MS = 2 * 60_000;

/**
 * How long a repo's `git fetch --prune` counts as fresh for worktree
 * classification. The fetch is the one network call in a prune scan; opening
 * the prune surface, backing out and opening it again is common enough that
 * paying for it every time is worth avoiding, while a branch deleted on the
 * remote in the last minute is not a case the list needs to catch instantly.
 */
const WORKTREE_FETCH_TTL_MS = 60_000;

/** Upper bound on worktrees one prune request may name. Far above any real
 *  repo's worktree count; exists so a malformed body can't ask the daemon to
 *  normalize an unbounded list. */
const MAX_PRUNE_PATHS = 500;

const MAX_INVOKE_TIMEOUT_MS = 30 * 60 * 1000;

/** Prefix `ClaudeInvoker` uses for its detached tmux session name. */
const INVOKE_SESSION_PREFIX = "ccmux-invoke-";

/**
 * Pull the `inv_...` invocation id out of a tmux session name when the
 * pane lives inside a `ccmux-invoke-<id>` detached session (the Claude
 * invoke path). Returns null for every normal user session name, and for
 * a malformed remainder that fails `INVOCATION_ID_PATTERN` (defense
 * against a user who happens to name a session `ccmux-invoke-foo`).
 */
function originInvocationIdFromSessionName(
  sessionName: string | null | undefined,
): string | null {
  if (!sessionName || !sessionName.startsWith(INVOKE_SESSION_PREFIX)) {
    return null;
  }
  const id = sessionName.slice(INVOKE_SESSION_PREFIX.length);
  return INVOCATION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Map an `InvocationManager` lifecycle event to its flat SSE event. The
 * record's epoch-ms `startedAt` becomes an ISO string (consistent with
 * every other timestamp on the wire); the board derives the live age from
 * it. `started` carries no session/pane (unknowable at admission).
 */
export function invocationEventToSSE(event: InvocationEvent): SSEEvent {
  const { record } = event;
  const timestamp = new Date().toISOString();
  if (event.type === "started") {
    // Resolved here rather than on the board: a subprocess invoke never
    // becomes a daemon session, so this event is the only chance to give its
    // row the same git-aware project the repo's real sessions group under.
    // Synchronous (a memoized `.git` walk, no spawn) to keep the invocation
    // stream in strict order with `init` and `session_created`, which the
    // board's reconcile and Claude-invoke de-dup both depend on.
    const info = deriveProjectInfo(record.cwd, record.agent);
    return {
      type: "invocation_started",
      timestamp,
      invocationId: record.invocationId,
      agent: record.agent,
      cwd: record.cwd,
      startedAt: new Date(record.startedAt).toISOString(),
      project: info.project,
      isWorktree: info.isWorktree,
      mainRepoRoot: info.mainRepoRoot,
      worktreeRoot: info.worktreeRoot,
    };
  }
  // `finish()` always sets a terminal status before emitting `finished`,
  // so `running` is unreachable here; narrow to it defensively as `failed`.
  const status: FinishedInvocationStatus =
    record.status === "running" ? "failed" : record.status;
  return {
    type: "invocation_finished",
    timestamp,
    invocationId: record.invocationId,
    agent: record.agent,
    status,
    ...(record.durationMs !== undefined
      ? { durationMs: record.durationMs }
      : {}),
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
  };
}
/**
 * Upper bound on `prompt` body bytes. Accommodates realistic piped
 * inputs (git diffs, test logs) while preventing a misbehaving caller
 * from streaming gigabytes of stdin into daemon memory. Symmetric with
 * the much-smaller send-to-session cap (10K) above, but invoke prompts
 * are expected to include diffs and file contents, so the budget is
 * wider.
 */
const MAX_INVOKE_PROMPT_BYTES = 256 * 1024;
const STATE_CHANGING_METHODS = new Set(["POST", "DELETE", "PUT", "PATCH"]);

/** Hostnames that legitimately address the loopback-bound daemon socket. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Reject any non-loopback `Host` to defeat DNS rebinding: a browser lured to a
 * hostname rebound to 127.0.0.1 still sends that hostname in `Host`, and the
 * Origin guard doesn't cover GET (which can read pane contents). Missing Host is
 * allowed (browsers always send it, so it can't carry the attack).
 */
export function rejectNonLoopbackHost(req: Request): Response | null {
  const host = req.headers.get("Host");
  if (!host) return null;

  let hostname = host;
  if (hostname.startsWith("[")) {
    const close = hostname.indexOf("]");
    if (close !== -1) hostname = hostname.slice(1, close);
  } else {
    // A lone colon is a `:port` suffix; multiple colons is a bare IPv6
    // literal (`::1`) with no port, which we keep intact.
    const colon = hostname.indexOf(":");
    if (colon !== -1 && colon === hostname.lastIndexOf(":")) {
      hostname = hostname.slice(0, colon);
    }
  }

  if (LOOPBACK_HOSTS.has(hostname)) return null;

  return new Response("Invalid Host header", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Browsers always send `Origin` on cross-origin fetches with side effects;
 * ccmux's first-party CLIs and the in-process TUI never do. Treat any
 * state-changing request that carries an `Origin` header as a hostile
 * CSRF attempt and reject with 403 + no CORS allowance, so the browser's
 * own CORS layer also blocks the response from being read.
 */
export function rejectCrossOriginBrowser(req: Request): Response | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;

  let method = req.method;
  if (method === "OPTIONS") {
    const requested = req.headers.get("Access-Control-Request-Method");
    if (requested) method = requested.toUpperCase();
  }
  if (!STATE_CHANGING_METHODS.has(method)) return null;

  return new Response("Cross-origin requests are not allowed", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * HTTP/SSE Server for the daemon
 */
export class DaemonServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sessionManager: SessionManager;
  private sseClients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: Timer | null = null;
  private prSweepInterval: Timer | null = null;
  private getPaneCache: PaneCacheGetter;
  private getAgentByType: AgentLookup;
  private visibleSessions = new Set<string>();
  /** Rotating start index for `sweepBranchPRs`, see its docstring. */
  private sweepOffset = 0;
  private gitInfoCache = new Map<string, GitInfoCacheEntry>();
  /** Whether the "git echoed our flags back" warning has already been said.
   *  Instance-scoped, which is per daemon process in production and keeps
   *  each test's server isolated. */
  private warnedAboutGitFlags = false;
  /** Coalesces concurrent lookups for one cwd onto a single git spawn. */
  private gitInfoInflight = new Map<string, Promise<GitInfo>>();
  private prResolver: PRResolver;
  private lastActivePaneId: string | null = null;
  /**
   * The tmux socket this daemon scans (`#{socket_path}`), resolved lazily and
   * cached. Exposed via `GET /server-info` so consumers can refuse a cross-server
   * `%N` (see the single-server invariant in pane-discovery.ts).
   */
  private serverSocketPath: string | null = null;
  private lastSidebarState: {
    selectedSessionId: string | null;
    selectedHeaderKey: string | null;
  } = { selectedSessionId: null, selectedHeaderKey: null };
  private attentionTracker: AttentionTracker;
  private invocationManager: InvocationManager;
  private getHookAdapter: (agentName: string) => HookAdapter | null;
  private paneSendDeps: PaneSendDeps;
  private runNotificationAction: NotificationActionRunner | null;
  private retractNotification: NotificationRetractFn | null;
  /** Reads the daemon's live scan-health snapshot. Follows the getPaneCache /
   *  getAgentByType accessor pattern so the server never imports daemon state. */
  private getScanHealth: () => DaemonHealth;
  /** When each repo last had `git fetch --prune` run for a prune scan. */
  private worktreeFetchedAt = new Map<string, number>();
  /**
   * Home directory, for the `project` $HOME-boundary guard (S4). A plain
   * field rather than a constructor param, so a test can stub it directly
   * the same way it reaches other private state through `ServerInternals` -
   * matches `DeriveProjectOptions.homeDir` in project-derivation.ts, which
   * exists for the identical reason: Bun's `os.homedir()` doesn't track a
   * test-time `process.env.HOME` override.
   *
   * Realpath'd once here, because what it is compared against (`mainRepoRoot`,
   * read from `git rev-parse --path-format=absolute`) already is: with a
   * symlinked home the equality and the descendant test below both miss and
   * the guard silently no-ops. @see resolvedHomeDir
   */
  private homeDir: string = resolvedHomeDir();

  constructor(
    sessionManager: SessionManager,
    getPaneCache: PaneCacheGetter,
    getAgentByType: AgentLookup,
    attentionTracker: AttentionTracker,
    invocationManager: InvocationManager,
    getHookAdapter: (agentName: string) => HookAdapter | null,
    paneSendDeps: PaneSendDeps = { sendLiteralToPane, sendPromptToPane },
    runNotificationAction: NotificationActionRunner | null = null,
    retractNotification: NotificationRetractFn | null = null,
    getScanHealth: () => DaemonHealth = () => ({ degraded: false }),
  ) {
    this.sessionManager = sessionManager;
    this.getPaneCache = getPaneCache;
    this.getAgentByType = getAgentByType;
    this.attentionTracker = attentionTracker;
    this.invocationManager = invocationManager;
    this.getHookAdapter = getHookAdapter;
    this.paneSendDeps = paneSendDeps;
    this.runNotificationAction = runNotificationAction;
    this.retractNotification = retractNotification;
    this.getScanHealth = getScanHealth;

    // Listen for session changes
    this.sessionManager.on("change", async (event: SessionEvent) => {
      const sseEvent = await this.sessionEventToSSE(event);
      if (sseEvent) this.broadcastEvent(sseEvent);
    });

    // Subscribe to invocation lifecycle, mirroring the sessionManager
    // subscription above. Broadcasts a flat `invocation_started` /
    // `invocation_finished` SSE event for every invoke (Claude included).
    // The server stays dumb transport here: the board's de-dup policy
    // (skip-and-wait for Claude, which renders as its real detached
    // session via `session_created`) lives in the TUI, not here.
    this.invocationManager.on("change", (event: InvocationEvent) => {
      this.broadcastEvent(invocationEventToSSE(event));
    });

    // PR lookups resolve in the background; when one lands a changed
    // value, re-broadcast the affected sessions so idle rows pick it up
    // without waiting for their next organic event.
    this.prResolver = new PRResolver({
      onChange: (cwd, branch) => {
        void this.onBranchPRsChanged(cwd, branch);
      },
    });
  }

  /**
   * Touch every visible session's (cwd, branch) key so the PR resolver
   * refreshes expired entries even when no organic event re-enriches the
   * session. Results are discarded: the point is the `get()` side effect, and
   * any landed change broadcasts via onBranchPRsChanged.
   *
   * Deliberately not routed through `enrichSession`: the sweep needs a PR key,
   * not a fresh git read. It takes the branch straight from the git cache
   * (expired entries included, since a stale key still names the right branch
   * far more often than not) and falls back to the log-derived branch, so a
   * sweep never spawns git. Going through the enrich path instead meant every
   * sweep re-derived git for every distinct visible cwd, forever, on an
   * otherwise idle machine: the git TTL is far below this interval, so it was
   * always expired by sweep time.
   *
   * Iteration starts at a rotating offset into the visible-session list
   * instead of always position 0. `PRResolver.get()` bails out of starting a
   * refresh once its concurrency cap is saturated (`inflight.size >=
   * MAX_CONCURRENT_REFRESHES`), and that check races in list order: a fixed
   * start order means the same handful of leading sessions always win the
   * cap's slots and every key past them is starved forever. Advancing the
   * offset by exactly one session per sweep (not by the cap size) needs no
   * knowledge of the resolver's internal cap and stays correct even if that
   * cap changes: whichever key sits at the new offset is always first in
   * line, so it is guaranteed a refresh attempt that sweep if it is stale
   * (the cap is >= 1). Since the offset visits every list position once per
   * `len` sweeps, every visible key gets at least one refresh attempt within
   * `len` sweeps in the worst case, even though in practice a cap of 4
   * clears a cold cache much faster than that.
   */
  private sweepBranchPRs(): void {
    const paneCache = this.getPaneCache();
    const sessions = this.sessionManager
      .getSessions()
      .filter((s) => this.visibleSessions.has(s.id));
    const len = sessions.length;
    if (len === 0) return;
    for (let i = 0; i < len; i++) {
      const session = sessions[(this.sweepOffset + i) % len];
      const cwd = this.effectiveCwd(session, paneCache);
      const branch =
        this.gitInfoCache.get(cwd)?.info.branch ?? session.gitBranch;
      this.prResolver.get(cwd, branch);
    }
    this.sweepOffset = (this.sweepOffset + 1) % len;
  }

  /** Where a session really lives: the pane's cwd (real shell state) when it
   *  has a live pane, else the log-derived cwd. */
  private effectiveCwd(
    session: Session,
    paneCache: Map<string, TmuxPane>,
  ): string {
    const paneInfo = session.tmuxPane ? paneCache.get(session.tmuxPane) : null;
    return paneInfo?.currentPath ?? session.cwd;
  }

  private async onBranchPRsChanged(cwd: string, branch: string) {
    const timestamp = new Date().toISOString();
    const paneCache = this.getPaneCache();
    for (const session of this.sessionManager.getSessions()) {
      if (!this.visibleSessions.has(session.id)) continue;
      // Cheap synchronous pre-filter on cwd before paying for the enrich:
      // on a cold cache this handler fires once per changed key, so
      // enriching every visible session here is sessions × keys calls.
      if (this.effectiveCwd(session, paneCache) !== cwd) continue;
      const enriched = await this.enrichSession(session);
      if (enriched.gitBranch !== branch) continue;
      this.broadcastEvent({
        type: "session_updated",
        timestamp,
        session: enriched,
      });
    }
  }

  /**
   * Branch + worktree for a cwd, cached and coalesced. Enrichment fans out
   * over every visible session at once (`enrichSessions`), and sessions
   * cluster on a handful of repos, so without the in-flight map an SSE `init`
   * fires one git spawn per session instead of one per distinct cwd.
   */
  private async getGitInfo(cwd: string): Promise<GitInfo> {
    const cached = this.gitInfoCache.get(cwd);
    if (cached && cached.expiresAt > Date.now()) return cached.info;

    const inflight = this.gitInfoInflight.get(cwd);
    if (inflight) return inflight;

    const pending = this.resolveGitInfo(cwd);
    this.gitInfoInflight.set(cwd, pending);
    return pending;
  }

  /**
   * Resolve and cache one cwd's git info. Never rejects, so a poisoned promise
   * can't be shared by every coalesced caller.
   *
   * A thrown spawn (git missing, fork failure) is deliberately not cached: it
   * says nothing about this cwd, so the next call retries. A non-zero exit
   * (not a repo, deleted dir, unborn HEAD) is a real answer and is cached.
   */
  private async resolveGitInfo(cwd: string): Promise<GitInfo> {
    try {
      const info = await this.readGitInfo(cwd);
      // Stamped after the spawn, so a slow git can't hand back an entry that
      // is already most of the way through its TTL.
      this.gitInfoCache.set(cwd, {
        info,
        expiresAt: Date.now() + GIT_INFO_CACHE_TTL_MS,
      });
      return info;
    } catch {
      return UNKNOWN_GIT_INFO;
    } finally {
      this.gitInfoInflight.delete(cwd);
    }
  }

  /**
   * Read a cwd's branch, checkout root, worktree flag and main checkout root
   * with a single spawn: `rev-parse` prints one line per argument, in
   * argument order.
   *
   * `--path-format=absolute` (git >= 2.31) is what makes the two dir answers
   * comparable. Without it git prints a repo root's git dir as a bare `.git`
   * and the common dir relative to the cwd, and it resolves those against
   * its own realpath'd getcwd() while ccmux would resolve them against the
   * cwd STRING — so a plain checkout reached through a symlinked path could
   * compare unequal and read as a worktree. An older git doesn't fail on the
   * flag, it echoes it as an EXTRA stdout line (still answering the rest),
   * so the affected band emits 5 lines, not 4; the `isEchoedFlag` check
   * below runs BEFORE the line-count gate for exactly that reason and turns
   * it into "no git facts" rather than "everything is a worktree" (or, if
   * it ran after, an unreachable warning masked by the length gate).
   *
   * Past the echoed-flag check, gated on exit 0 AND exactly four lines. The
   * exit-code check is what actually guards against a phantom `HEAD`
   * branch: a bare repo with an unborn HEAD still prints one stdout line
   * per argument ("HEAD" and the literal flags) while exiting 128, so a
   * line-count-only gate would parse that as a real answer and misreport
   * the branch. The line-count gate stays as defense-in-depth on top of the
   * exit-code check, not as a substitute for it. A detached HEAD in a real
   * repo still reports the literal `HEAD` (exit 0), which is pre-existing
   * behavior and unchanged.
   */
  private async readGitInfo(cwd: string): Promise<GitInfo> {
    const proc = Bun.spawn(
      [
        "git",
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--abbrev-ref",
        "HEAD",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      // stderr is never read, so don't pay for a pipe on this path.
      { stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const lines = stdout
      .trim()
      .split("\n")
      .map((l) => l.trim());
    // Checked before, and independent of, the line-count gate below: real
    // old git doesn't just fail to answer `--path-format` — it echoes the
    // unrecognized flag back as an EXTRA stdout line and still answers the
    // rest, so the affected band emits 5 lines, not 4. Gating on exit 0 and
    // exactly 4 lines first meant that shape hit the length check and
    // returned before this code ever ran, so the warning below could never
    // fire for the real-world case it exists to explain.
    if (exitCode === 0 && lines.some(isEchoedFlag)) {
      // Refusing the reply is right, but silently: every row loses its branch
      // and worktree marker with nothing on screen explaining why. Say it
      // once — the cause is the git binary, so it is the same answer for
      // every cwd on this machine and repeating it per lookup would be noise.
      if (!this.warnedAboutGitFlags) {
        this.warnedAboutGitFlags = true;
        console.warn(
          "ccmux: `git rev-parse` echoed an option back instead of answering it, " +
            "so branch and worktree info are unavailable. This usually means git is " +
            "older than 2.31 (no `--path-format`), or a wrapper on PATH is dropping " +
            "unknown flags. `git --version` should be 2.31 or newer.",
        );
      }
      return UNKNOWN_GIT_INFO;
    }
    if (exitCode !== 0 || lines.length !== 4) return UNKNOWN_GIT_INFO;
    const [branch, topLevel, gitDir, commonDir] = lines;
    return {
      branch: branch || null,
      worktreeRoot: topLevel || null,
      ...worktreeFacts(cwd, gitDir, commonDir, topLevel),
    };
  }

  /**
   * The project name git's answer would give, or null to fall through to
   * `deriveProject`'s $HOME-bounded walk (S4).
   *
   * `git rev-parse` has no notion of `$HOME` as a ceiling, so a literal
   * `~/.git` (someone ran `git init` directly in their home directory for
   * dotfiles) resolves `mainRepoRoot` to `$HOME` for every directory
   * beneath it. Trusting that here would collapse every non-repo directory
   * under home into one group named after the home directory - exactly the
   * regression `deriveProject`'s own stop-at-`$HOME` guard
   * (project-derivation.ts) was written to prevent, just reached through
   * the git-info path instead of the filesystem walk.
   *
   * Only a strict descendant of `$HOME` triggers the bypass: a session
   * whose effective cwd IS `$HOME` still gets git's answer (matching
   * `deriveProject`'s own cwd === homeDir carve-out), and the common
   * bare-repo dotfiles pattern (`~/.cfg --bare` with a worktree at `$HOME`)
   * has `mainRepoRoot` at the bare repo's own path, never literally
   * `$HOME`, so it is unaffected.
   */
  private gitProjectName(
    mainRepoRoot: string | null,
    cwd: string,
  ): string | null {
    if (!mainRepoRoot) return null;
    if (mainRepoRoot === this.homeDir && this.isStrictDescendantOfHome(cwd)) {
      return null;
    }
    return basename(mainRepoRoot);
  }

  private isStrictDescendantOfHome(cwd: string): boolean {
    const rel = relative(this.homeDir, cwd);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private async enrichSession(session: Session): Promise<EnrichedSession> {
    const paneCache = this.getPaneCache();
    const paneInfo = session.tmuxPane ? paneCache.get(session.tmuxPane) : null;
    const tmuxTarget = paneInfo?.target ?? null;
    const paneCwd = paneInfo?.currentPath ?? null;
    const effectiveCwd = this.effectiveCwd(session, paneCache);
    const gitInfo = await this.getGitInfo(effectiveCwd);
    const gitBranch = gitInfo.branch ?? session.gitBranch;
    // Synchronous cache read; the resolver refreshes in the background and
    // onBranchPRsChanged re-broadcasts when a lookup lands a new value.
    const branchPRs = this.prResolver.get(effectiveCwd, gitBranch);
    // Derived exactly like tmuxTarget, off the same paneInfo: a Claude
    // invoke runs inside a `ccmux-invoke-<id>` detached session, so the
    // pane's sessionName carries the invocation id. No cold-cache
    // listTmuxPanes fallback: enrichSession re-runs on every
    // session_updated and an active invoke ticks continuously, so a cold
    // cache resolves on the next tick.
    const originInvocationId = originInvocationIdFromSessionName(
      paneInfo?.sessionName,
    );

    return {
      ...session,
      tmuxTarget,
      paneCwd,
      // One read, one answer: when git resolved this cwd, the repo name is
      // the main checkout's basename from that SAME read, so `project` and
      // the worktree facts below cannot contradict each other.
      //
      // Deriving them separately did contradict, and permanently: git info
      // expires after 30s while `deriveProject`'s cache never evicts, so a
      // cwd that becomes a worktree after its first enrich (git allows
      // `worktree add` into an existing empty directory) kept grouping under
      // the stale name for the daemon's whole life while its label named the
      // new repo. `deriveProject` remains the fallback for the cwds git
      // can't answer for (not a repo, bare repo, deleted directory) AND for
      // the cwds `gitProjectName` refuses to bless (a literal `~/.git`
      // repo, S4); its walk may be cold here, since the daemon only ever
      // primed it with `session.cwd` and this is the pane-preferred cwd.
      project:
        this.gitProjectName(gitInfo.mainRepoRoot, effectiveCwd) ??
        deriveProject(effectiveCwd, session.project, {
          homeDir: this.homeDir,
        }),
      gitBranch,
      isWorktree: gitInfo.isWorktree,
      mainRepoRoot: gitInfo.mainRepoRoot,
      worktreeRoot: gitInfo.worktreeRoot,
      branchPRs,
      originInvocationId,
    };
  }

  private async enrichSessions(
    sessions: Session[],
  ): Promise<EnrichedSession[]> {
    return Promise.all(sessions.map((s) => this.enrichSession(s)));
  }

  private resolveSession(id: string): Session | undefined {
    const session = this.sessionManager.getSession(id);
    if (session) return session;

    // Fall back to pane ID lookup
    return this.sessionManager.getSessions().find((s) => s.tmuxPane === id);
  }

  /**
   * Start the HTTP server
   */
  start(): void {
    this.server = Bun.serve({
      port: DAEMON_PORT,
      hostname: DAEMON_HOST,
      idleTimeout: 30, // Must exceed HEARTBEAT_INTERVAL_MS (15s) for SSE connections
      fetch: (req) => this.handleRequest(req),
    });

    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent({
        type: "heartbeat",
        timestamp: new Date().toISOString(),
      });
    }, HEARTBEAT_INTERVAL_MS);

    // PR refreshes are demand-driven (a read of a stale key schedules
    // one), so a fully idle session would serve a stale PR indefinitely —
    // e.g. a merged PR lingering as open. Sweeping the visible sessions
    // touches every (cwd, branch) key, capping staleness at the resolver
    // TTL plus this interval; landed changes broadcast through
    // onBranchPRsChanged like any other refresh.
    this.prSweepInterval = setInterval(() => {
      // sweepBranchPRs is synchronous; a throw here would otherwise escape
      // uncaught from a setInterval callback and crash the daemon.
      try {
        this.sweepBranchPRs();
      } catch (err) {
        console.error("PR sweep failed:", err);
      }
    }, PR_SWEEP_INTERVAL_MS);

    console.log(`Daemon server listening on ${DAEMON_HOST}:${DAEMON_PORT}`);

    this.installPaneFocusHook();
  }

  stop(): void {
    this.removePaneFocusHook();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.prSweepInterval) {
      clearInterval(this.prSweepInterval);
      this.prSweepInterval = null;
    }

    for (const client of this.sseClients.values()) {
      try {
        client.controller.close();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private static readonly ACTIVE_PANE_HOOKS = [
    "after-select-pane[50]",
    "after-select-window[50]",
  ] as const;

  /**
   * Install tmux hooks to notify daemon of pane focus changes.
   * Uses after-select-pane and after-select-window (compatible with tmux 3.x).
   */
  private installPaneFocusHook(): void {
    // Trailing `|| true` keeps the shell exit status 0 when the daemon isn't
    // listening (curl exit 7). Without it, tmux surfaces the non-zero exit
    // from `run-shell -b` as a status-line message on every pane switch
    // whenever a stale hook outlives the daemon.
    const hookCmd = `run-shell -b 'curl -s -X POST http://${DAEMON_HOST}:${DAEMON_PORT}/active-pane -H "Content-Type:application/json" -d "{\\"paneId\\":\\"#{pane_id}\\"}" > /dev/null 2>&1 || true'`;
    for (const hook of DaemonServer.ACTIVE_PANE_HOOKS) {
      Bun.spawn(["tmux", "set-hook", "-g", hook, hookCmd], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }

  /**
   * Remove pane focus hooks on shutdown
   */
  private removePaneFocusHook(): void {
    for (const hook of DaemonServer.ACTIVE_PANE_HOOKS) {
      Bun.spawn(["tmux", "set-hook", "-gu", hook], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const badHost = rejectNonLoopbackHost(req);
    if (badHost) return badHost;

    const cross = rejectCrossOriginBrowser(req);
    if (cross) return cross;

    const url = new URL(req.url);
    const path = url.pathname;

    // No Access-Control-Allow-Origin: ccmux has no browser clients, and an
    // omitted Allow-Origin makes the browser refuse to expose response bodies
    // for any read that does sneak through. Methods/Headers are kept for
    // tooling that might preflight a same-origin request.
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route requests
    if (path === "/health" && req.method === "GET") {
      return this.handleHealth(corsHeaders);
    }

    if (path === "/server-info" && req.method === "GET") {
      return Response.json(
        {
          socketPath: await this.getServerSocketPath(),
          health: this.getScanHealth(),
        },
        { headers: corsHeaders },
      );
    }

    if (path === "/agents" && req.method === "GET") {
      return await this.handleGetSpawnableAgents(corsHeaders);
    }

    if (path === "/sessions" && req.method === "GET") {
      return await this.handleGetSessions(url, corsHeaders);
    }

    if (path === "/search" && req.method === "GET") {
      return await this.handleSearch(url, corsHeaders);
    }

    if (path === "/worktrees/prune-candidates" && req.method === "GET") {
      return await this.handlePruneCandidates(url, corsHeaders);
    }

    if (path === "/worktrees/prune" && req.method === "POST") {
      return await this.handlePruneWorktrees(req, corsHeaders);
    }

    // Suffixed GET routes must come before the generic GET /sessions/{id} catch-all
    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/screen") &&
      req.method === "GET"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/screen".length);
      return await this.handleScreenSession(sessionId, url, corsHeaders);
    }

    // BEFORE the catch-all GET below, which slices everything after
    // `/sessions/` as the id and would read this path's id as
    // `<id>/dirty`. Any future `GET /sessions/:id/<verb>` needs the same
    // placement.
    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/dirty") &&
      req.method === "GET"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/dirty".length);
      return await this.handleSessionDirty(sessionId, url, corsHeaders);
    }

    if (path.startsWith("/sessions/") && req.method === "GET") {
      const sessionId = path.slice("/sessions/".length);
      return await this.handleGetSession(sessionId, corsHeaders);
    }

    if (path === "/sessions/kill-all" && req.method === "POST") {
      return this.handleKillAllSessions(corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/send") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/send".length);
      return await this.handleSendToSession(sessionId, req, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/restart") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/restart".length);
      return await this.handleRestartSession(sessionId, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/kill") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/kill".length);
      return await this.handleKillSession(sessionId, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/seen") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/seen".length);
      return this.handleMarkSeen(sessionId, corsHeaders);
    }

    if (path.startsWith("/sessions/") && req.method === "DELETE") {
      const sessionId = path.slice("/sessions/".length);
      return this.handleDeleteSession(sessionId, corsHeaders);
    }

    if (path === "/active-pane" && req.method === "POST") {
      return await this.handleActivePaneNotification(req, corsHeaders);
    }

    if (path === "/sidebar-state" && req.method === "POST") {
      return await this.handleSidebarStateUpdate(req, corsHeaders);
    }

    if (path === "/sidebar-state" && req.method === "GET") {
      return Response.json(this.lastSidebarState, { headers: corsHeaders });
    }

    if (path === "/spawn" && req.method === "POST") {
      return await this.handleSpawn(req, corsHeaders);
    }

    if (path === "/invoke" && req.method === "POST") {
      return await this.handleInvoke(req, corsHeaders);
    }

    if (path === "/notification-action" && req.method === "POST") {
      return await this.handleNotificationActionRequest(req, corsHeaders);
    }

    if (
      path.startsWith("/invoke/") &&
      path.endsWith("/cancel") &&
      req.method === "POST"
    ) {
      const id = path.slice("/invoke/".length, -"/cancel".length);
      return await this.handleInvokeCancel(id, corsHeaders);
    }

    if (path === "/invocations" && req.method === "GET") {
      return Response.json(
        { invocations: this.invocationManager.listInvocations() },
        { headers: corsHeaders },
      );
    }

    if (
      path.startsWith("/invocations/") &&
      path.endsWith("/result") &&
      req.method === "GET"
    ) {
      const id = path.slice("/invocations/".length, -"/result".length);
      return await this.handleInvocationResult(id, corsHeaders);
    }

    if (path === "/events" && req.method === "GET") {
      return this.handleSSE();
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  /**
   * Whether a session should be surfaced to clients. Pane-tracked/native
   * sessions are visible once they have a tmux pane; background
   * (background-agent) sessions are paneless by nature and visible from
   * creation (their `created` event IS their visible moment).
   */
  private isVisibleSession(s: Readonly<Session>): boolean {
    return (
      s.tmuxPane !== null ||
      s.trackingMode === "background" ||
      // Transcript-backed native sessions are visible even without a pane:
      // when the binder refuses to guess (ambiguous
      // evidence) the row must be VISIBLY unbound, not hidden — an unbound
      // row self-corrects (marker arrival, rebind attempt) or is reaped by
      // the zombie cleanup, and hiding it would just re-disguise the
      // refusal as a missing session. Pane-tracked sessions keep the
      // pane-gated promotion: their existence IS their pane.
      (s.trackingMode === "native" && s.logPath !== null)
    );
  }

  /**
   * Resolve this daemon's tmux socket path. Works without an attached client
   * (the daemon runs detached): `display-message -p` reads the server from the
   * inherited env — the same one `list-panes -a` scans. Caches the first success;
   * a null (no server up yet) is not cached, so the guard engages once tmux is up.
   */
  private async getServerSocketPath(): Promise<string | null> {
    if (this.serverSocketPath) return this.serverSocketPath;
    try {
      const proc = Bun.spawn(
        ["tmux", "display-message", "-p", "#{socket_path}"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const [out, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (code === 0) {
        this.serverSocketPath = out.trim() || null;
      }
    } catch {
      // No server / spawn failure: leave unresolved, retry on next request.
    }
    return this.serverSocketPath;
  }

  private handleHealth(headers: Record<string, string>): Response {
    const allSessions = this.sessionManager.getSessions();
    const data = {
      status: "ok",
      sessions: allSessions.filter((s) => this.isVisibleSession(s)).length,
      trackedSessions: allSessions.length,
      clients: this.sseClients.size,
      uptime: process.uptime(),
      health: this.getScanHealth(),
    };

    return Response.json(data, { headers });
  }

  private async handleGetSessions(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const showAll = url.searchParams.get("all") === "true";
    let sessions = this.sessionManager.getSessions();
    if (!showAll) sessions = sessions.filter((s) => this.isVisibleSession(s));
    return Response.json(
      { sessions: await this.enrichSessions(sessions) },
      { headers },
    );
  }

  /**
   * Repos to scan for prunable worktrees: every main checkout the live
   * sessions point at.
   *
   * Sessions are the only repo inventory the daemon has, and it is the right
   * one — a repo ccmux has never seen an agent in is not a repo whose
   * worktrees ccmux should be offering to delete. One session anywhere in a
   * repo (including its main checkout) brings that repo's whole worktree list
   * into scope, so an abandoned worktree with no session of its own is still
   * found.
   */
  private pruneRepoRoots(
    sessions: EnrichedSession[],
    filter: string | null,
  ): string[] {
    const roots = new Set<string>();
    for (const session of sessions) {
      if (session.mainRepoRoot) roots.add(session.mainRepoRoot);
    }
    if (!filter) return [...roots];
    const wanted = normalizePath(filter);
    return [...roots].filter((root) => normalizePath(root) === wanted);
  }

  /**
   * Classify prunable worktrees across the sessions' repos.
   *
   * The per-repo `git fetch --prune` (what turns a branch deleted on GitHub
   * into a locally visible `[gone]`) is run here rather than inside the scan
   * so it can be rate-limited: opening the prune surface twice in a row
   * should not pay for the network twice.
   */
  private async scanPruneCandidates(filter: string | null): Promise<PruneScan> {
    // Enriched ONCE and shared. Enrichment spawns git per distinct cwd, so
    // doing it separately for the repo list and the session map paid for the
    // whole thing twice on every scan.
    const sessions = await this.enrichSessions(
      this.sessionManager.getSessions(),
    );
    const repoRoots = this.pruneRepoRoots(sessions, filter);

    const byWorktree = new Map<string, WorktreeSession[]>();
    for (const session of sessions) {
      const root = session.worktreeRoot;
      if (!root) continue;
      const key = normalizePath(root);
      const list = byWorktree.get(key) ?? [];
      list.push({
        id: session.id,
        agentType: session.agentType,
        status: session.status,
        tmuxPane: session.tmuxPane,
        tmuxTarget: session.tmuxTarget,
        pid: session.pid ?? null,
        // Carried, not filtered out: a background agent still has to GATE the
        // removal when it is working. What it must never get is the SIGTERM —
        // its pid belongs to Claude's supervisor, not to ccmux, exactly as
        // `handleKillSession` says.
        background: isBackgroundSession(session),
      });
      byWorktree.set(key, list);
    }

    // Fetches run together: they are independent network calls against
    // different repos, and serializing them made the scan's fixed cost the
    // SUM of every repo's round-trip.
    const now = Date.now();
    const toFetch = repoRoots.filter((root) => {
      const last = this.worktreeFetchedAt.get(root) ?? 0;
      if (now - last < WORKTREE_FETCH_TTL_MS) return false;
      this.worktreeFetchedAt.set(root, now);
      return true;
    });
    await Promise.all(toFetch.map((root) => fetchPrune(root)));

    return scanRepos(repoRoots, {
      skipFetch: true,
      sessionsFor: (path) => byWorktree.get(path) ?? [],
      hasOpenPR: (cwd, branch) =>
        (this.prResolver.get(cwd, branch)?.length ?? 0) > 0,
    });
  }

  private async handlePruneCandidates(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      const scan = await this.scanPruneCandidates(url.searchParams.get("repo"));
      return Response.json(scan, { headers });
    } catch (err) {
      return Response.json(
        { error: `Failed to scan worktrees: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }
  }

  /**
   * Execute a prune run.
   *
   * The request names paths, never candidates: everything that decides what
   * removal does (the reason, whether the branch may be deleted, whether the
   * tree is dirty) is re-derived from a fresh scan in this process. A path the
   * scan does not currently classify as removable is rejected rather than
   * removed, so a stale client list, a repeated request, or a hand-written
   * POST cannot delete a directory that has since become active.
   */
  private async handlePruneWorktrees(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: {
      paths?: unknown;
      allowDirty?: unknown;
      dryRun?: unknown;
      cleanState?: unknown;
      repo?: unknown;
      source?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }

    // De-duplicated after normalization. Two spellings of one worktree
    // (`/tmp` and `/private/tmp`, or a trailing slash) otherwise produce
    // several outcomes for the same directory, and since branch deletion
    // resolves an outcome by path it always found the FIRST one — so the
    // later "already gone" failures overwrote a successful run's result and
    // rendered it as a wall of errors.
    const asPaths = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      const seen = new Set<string>();
      for (const v of value) {
        if (typeof v !== "string") continue;
        seen.add(normalizePath(v));
      }
      return [...seen];
    };
    // O7: reject an over-cap list outright rather than silently truncating.
    // Checked on the RAW array length, before `asPaths` dedupes or
    // normalizes anything — for both fields, since a silently dropped
    // `allowDirty` opt-in fails closed (a real refusal) but is exactly as
    // silent as a dropped path. Checking the raw length, rather than
    // `asPaths(value).length`, also keeps `MAX_PRUNE_PATHS`'s original point
    // intact: a malformed body with an absurd array cannot make the daemon
    // run `normalizePath` (a `realpath` syscall per entry) over all of it
    // just to find out it should have been rejected.
    const overCap = (value: unknown, field: string): Response | null => {
      if (!Array.isArray(value)) return null;
      if (value.length <= MAX_PRUNE_PATHS) return null;
      return Response.json(
        {
          error: `Too many ${field} (${value.length}); the limit is ${MAX_PRUNE_PATHS} per request`,
        },
        { status: 400, headers },
      );
    };
    const pathsCapError = overCap(body.paths, "paths");
    if (pathsCapError) return pathsCapError;
    const allowDirtyCapError = overCap(body.allowDirty, "allowDirty entries");
    if (allowDirtyCapError) return allowDirtyCapError;

    const paths = asPaths(body.paths);
    const allowDirty = asPaths(body.allowDirty);
    const cleanState = body.cleanState === true;

    if (paths.length === 0 && !cleanState) {
      return Response.json(
        { error: "No worktrees selected" },
        { status: 400, headers },
      );
    }

    try {
      const scan = await this.scanPruneCandidates(
        typeof body.repo === "string" ? body.repo : null,
      );
      const byPath = new Map<string, PruneCandidate>();
      for (const candidate of scan.candidates) {
        byPath.set(normalizePath(candidate.path), candidate);
      }

      const selected: PruneCandidate[] = [];
      const unknown: string[] = [];
      for (const path of paths) {
        const candidate = byPath.get(normalizePath(path));
        if (candidate) selected.push(candidate);
        else unknown.push(path);
      }
      if (unknown.length > 0) {
        return Response.json(
          {
            error:
              "Not currently removable (re-open the prune list): " +
              unknown.join(", "),
          },
          { status: 409, headers },
        );
      }

      const result = await runPrune(selected, {
        dryRun: body.dryRun === true,
        cleanOrphanState: cleanState,
        // Normalized on both sides: a candidate's path comes from git already
        // resolved through symlinks, so an opt-in echoed back through a client
        // still matches the candidate it was granted for.
        allowDirtyPaths: allowDirty.map(normalizePath),
        source: typeof body.source === "string" ? body.source : "api",
      });
      // A removed worktree invalidates the cwd-keyed git cache for every path
      // under it; leaving it would keep answering for a directory that is gone.
      for (const outcome of result.outcomes) {
        if (!outcome.removed) continue;
        for (const cwd of this.gitInfoCache.keys()) {
          if (cwd === outcome.path || cwd.startsWith(`${outcome.path}/`)) {
            this.gitInfoCache.delete(cwd);
          }
        }
      }
      return Response.json(result, { headers });
    } catch (err) {
      return Response.json(
        { error: `Prune failed: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }
  }

  /**
   * On-demand transcript search across the visible Claude/Codex sessions.
   * Reads each session's live transcript (tail-bounded) and returns per-session
   * snippets so the TUI can match text the in-memory prompt index doesn't cover
   * (full history, plus assistant turns). Runs in bounded concurrent batches.
   */
  private async handleSearch(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length < MIN_QUERY_LEN) {
      return Response.json(
        { error: "query too short" },
        { status: 400, headers },
      );
    }

    const query = q.toLowerCase();
    const sessions = this.sessionManager
      .getSessions()
      .filter((s) => this.isVisibleSession(s));

    const results: SessionMatches[] = [];
    for (let i = 0; i < sessions.length; i += SEARCH_CONCURRENCY) {
      const batch = sessions.slice(i, i + SEARCH_CONCURRENCY);
      const settled = await Promise.all(
        batch.map((s) =>
          searchTranscript(
            { id: s.id, agentType: s.agentType, logPath: s.logPath },
            query,
          ),
        ),
      );
      for (const match of settled) {
        // Drop nulls (unsupported agent / no log / read failure) and sessions
        // with no textual hit, so the response carries only genuine matches.
        if (match && match.matches.length > 0) results.push(match);
      }
    }

    return Response.json({ query: q, results }, { headers });
  }

  private async handleGetSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    return Response.json(
      { session: await this.enrichSession(session) },
      { headers },
    );
  }

  private handleMarkSeen(
    sessionId: string,
    headers: Record<string, string>,
  ): Response {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }
    this.attentionTracker.markSeen(sessionId);
    this.sessionManager.markSeen(sessionId);
    return Response.json({ success: true }, { headers });
  }

  /**
   * Uncommitted work in a session's checkout, for the picker's "Move changes
   * to worktree" gate.
   *
   * Lazy and per-session on purpose. This is one `git status` on an explicit
   * user action (opening a context menu), so it costs nothing until someone
   * asks and can never be stale. The alternative, a dirty flag enriched onto
   * every row, would mean a git spawn per session per scan — exactly the cost
   * the PR resolver's cache and sweep exist to avoid.
   *
   * It deliberately reuses `readUncommitted`, the same reader the move itself
   * uses, rather than `readDirtyState`. The two disagree in ways that matter
   * here: `readDirtyState` reports an unreadable checkout as DIRTY (the safe
   * direction for prune, which is destructive) and counts ignored files
   * separately. A gate that said "dirty" where the move would answer
   * "nothing to move" would offer an action that then refuses.
   *
   * Which DIRECTORY it answers about matters for the same reason. A pane that
   * has `cd`ed somewhere else moves out of where it is now, not out of where
   * the session started, so the default is the session's effective cwd — the
   * pane's current path when there is one — exactly like every other
   * cwd-derived fact on a row. A caller that has already decided which
   * directory it will move from can name it with `?cwd=`, which is only
   * checked for shape: this endpoint runs one `git status` and reads nothing
   * out of it but counts, and a stricter rule (must equal the session's own
   * paths) would 400 on a pane cache one tick behind the caller's.
   */
  private async handleSessionDirty(
    sessionId: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    const requested = url.searchParams.get("cwd");
    if (requested !== null && !isAbsolute(requested)) {
      return Response.json(
        { error: `'cwd' must be an absolute path, got '${requested}'` },
        { status: 400, headers },
      );
    }

    const checkout =
      requested ?? this.effectiveCwd(session, this.getPaneCache());
    if (!checkout) {
      return Response.json(
        { error: "Session has no working directory" },
        { status: 400, headers },
      );
    }

    const state = await readUncommitted(checkout);
    // Null means the cwd is not a readable git checkout. Reported as
    // `repo: false` rather than as an error: "this row has nothing to move"
    // is a perfectly ordinary answer to the question the menu is asking.
    if (!state) {
      return Response.json(
        { repo: false, dirty: false, modified: 0, untracked: 0 },
        { headers },
      );
    }

    return Response.json(
      {
        repo: true,
        dirty: state.modified + state.untrackedPaths.length > 0,
        modified: state.modified,
        untracked: state.untrackedPaths.length,
      },
      { headers },
    );
  }

  private handleDeleteSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Response {
    const removed = this.sessionManager.removeSession(sessionId);

    if (!removed) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  private async handleActivePaneNotification(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }

    const paneId = body.paneId;
    if (!paneId || typeof paneId !== "string") {
      return Response.json(
        { error: "Missing paneId" },
        { status: 400, headers },
      );
    }

    // Skip broadcasting if the focused pane belongs to ccmux (sidebar, picker, etc.)
    const paneInfo = this.getPaneCache().get(paneId);
    if (isCcmuxPane(paneInfo?.paneTitle ?? null)) {
      return Response.json({ success: true, sessionId: null }, { headers });
    }

    // Dedup identical consecutive focus events (caller discards the response)
    if (paneId === this.lastActivePaneId) {
      return Response.json({ success: true }, { headers });
    }
    this.lastActivePaneId = paneId;

    const session = this.resolveSession(paneId);
    const sessionId = session?.id ?? null;

    // Mark session as seen when user switches to its pane
    if (session?.attentionState) {
      this.attentionTracker.markSeen(session.id, false);
      this.sessionManager.setAttentionState(session.id, "read");
      this.attentionTracker.save();
      // Retract any delivered notification for this session — the user is
      // looking at the pane now, so the alert is stale. Fail-open (the closure
      // swallows its own errors); fire-and-forget so focus handling isn't
      // blocked on a notifier spawn / dbus round-trip.
      void this.retractNotification?.(session.id);
    }

    this.broadcastEvent({
      type: "active_pane",
      timestamp: new Date().toISOString(),
      sessionId,
      paneId,
    });

    return Response.json({ success: true, sessionId }, { headers });
  }

  /**
   * Handle an actionable-notification callback (from the ccmux-notifier app):
   * parse the body, delegate to the shared handler (all safety gating lives
   * there), and map its structured result to an HTTP status. The handler is
   * wired in `index.ts`; when unconfigured (e.g. server tests) this reports
   * 503 so a stray call fails safe rather than 200-ing a no-op.
   */
  private async handleNotificationActionRequest(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!this.runNotificationAction) {
      return Response.json(
        { ok: false, error: "Notification actions not available" },
        { status: 503, headers },
      );
    }

    let body: {
      sessionId?: unknown;
      action?: unknown;
      statusChangedAt?: unknown;
      attentionGeneration?: unknown;
      userText?: unknown;
      payload?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400, headers },
      );
    }

    // The ccmux-notifier helper passes the daemon's own opaque `--payload`
    // string back verbatim (see notifier/Sources/main.swift `postCallbackAsync`),
    // so sessionId/statusChangedAt live INSIDE it — the daemon stamped that
    // format in `buildCcmuxNotifierArgv`, so it owns parsing it here. Top-level
    // fields remain accepted for hand-testing, but a present `payload` wins.
    let payloadSessionId: string | undefined;
    let payloadStatusChangedAt: string | undefined;
    let payloadAttentionGeneration: number | undefined;
    if (typeof body.payload === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.payload);
      } catch {
        return Response.json(
          { ok: false, error: "Invalid payload JSON" },
          { status: 400, headers },
        );
      }
      if (parsed && typeof parsed === "object") {
        const p = parsed as {
          sessionId?: unknown;
          statusChangedAt?: unknown;
          attentionGeneration?: unknown;
        };
        if (typeof p.sessionId === "string") payloadSessionId = p.sessionId;
        if (typeof p.statusChangedAt === "string") {
          payloadStatusChangedAt = p.statusChangedAt;
        }
        if (typeof p.attentionGeneration === "number") {
          payloadAttentionGeneration = p.attentionGeneration;
        }
      }
    }

    const sessionId =
      payloadSessionId ??
      (typeof body.sessionId === "string" ? body.sessionId : undefined);
    const statusChangedAt =
      payloadStatusChangedAt ??
      (typeof body.statusChangedAt === "string"
        ? body.statusChangedAt
        : undefined);
    const attentionGeneration =
      payloadAttentionGeneration ??
      (typeof body.attentionGeneration === "number"
        ? body.attentionGeneration
        : undefined);

    if (sessionId === undefined || typeof body.action !== "string") {
      return Response.json(
        { ok: false, error: "Missing sessionId or action" },
        { status: 400, headers },
      );
    }

    const input: NotificationActionInput = {
      sessionId,
      action: body.action,
      statusChangedAt,
      attentionGeneration,
      userText: typeof body.userText === "string" ? body.userText : undefined,
    };

    const result = await this.runNotificationAction(input);
    return Response.json(
      result.ok
        ? { ok: true, action: result.action }
        : { ok: false, error: result.error },
      { status: result.code, headers },
    );
  }

  /**
   * Handle sidebar state update - relay selection to all sidebars
   */
  private async handleSidebarStateUpdate(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }

    const selectedSessionId =
      typeof body.selectedSessionId === "string"
        ? body.selectedSessionId
        : null;
    const selectedHeaderKey =
      typeof body.selectedHeaderKey === "string"
        ? body.selectedHeaderKey
        : null;
    const version = typeof body.version === "number" ? body.version : undefined;

    this.lastSidebarState = {
      selectedSessionId,
      selectedHeaderKey,
    };

    this.broadcastEvent({
      type: "sidebar_state",
      timestamp: new Date().toISOString(),
      selectedSessionId,
      selectedHeaderKey,
      version,
    });

    return Response.json({ success: true }, { headers });
  }

  /**
   * Kill a session's agent process
   */
  private async handleKillSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    // Background rows' worker pid is owned by Claude's supervisor, never by
    // ccmux, so a direct SIGTERM is unsafe. If the agent defines a stop
    // command, shell out to it and let the supervisor tear the worker down;
    // otherwise the row stays read-only (400). Either way the row itself is
    // NOT removed here: removal is event-driven, via the Background Source's
    // roster watcher noticing the short drop out of `roster.json`.
    if (isBackgroundSession(session)) {
      const agent = this.getAgentByType(session.agentType);
      if (!agent?.backgroundStopCommand) {
        return Response.json(
          {
            error:
              "background session is read-only; this agent has no stop command",
          },
          { status: 400, headers },
        );
      }

      const argv = agent.backgroundStopCommand(session.id);
      try {
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = (await new Response(proc.stderr).text()).trim();
          // A stop the supervisor has already applied is a success, not a
          // failure: removal lags the stop, so a second `x` inside that window
          // would otherwise report an error for a row that is on its way out.
          if (!agent.backgroundStopAlreadyGone?.test(stderr)) {
            return Response.json(
              { error: `Failed to stop background session: ${stderr}` },
              { status: 500, headers },
            );
          }
        }
      } catch (err: unknown) {
        return Response.json(
          { error: `Failed to stop background session: ${errorMessage(err)}` },
          { status: 500, headers },
        );
      }

      return Response.json({ success: true }, { headers });
    }

    if (!session.pid) {
      return Response.json(
        { error: "Session has no associated process" },
        { status: 400, headers },
      );
    }

    try {
      process.kill(session.pid, "SIGTERM");
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ESRCH") {
        // Process already dead — not an error
      } else {
        return Response.json(
          { error: `Failed to kill process: ${errorMessage(err)}` },
          { status: 500, headers },
        );
      }
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Restart a session: kill process (if alive), then resume in the same tmux pane
   */
  private async handleRestartSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    // Kill the process if it's still alive
    if (session.pid) {
      try {
        process.kill(session.pid, "SIGTERM");
      } catch (err: unknown) {
        if (!isErrnoException(err) || err.code !== "ESRCH") {
          return Response.json(
            { error: `Failed to kill process: ${errorMessage(err)}` },
            { status: 500, headers },
          );
        }
      }

      // Poll until process exits (up to 5s)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(session.pid, 0);
        } catch {
          break; // Process is gone
        }
        await Bun.sleep(100);
      }
    }

    // Resume in the same pane via the stable `%N` id, not the cached
    // `session:window.pane` coordinate (which goes stale when a lower-indexed
    // window closes mid-scan). `%N` is immutable for the pane's life.
    //
    // Re-read `session.tmuxPane`: the earlier guard held before the kill-wait,
    // but the binder nulls it if the pane closed during the wait. Bail instead
    // of running `send-keys -t null`.
    const target = session.tmuxPane;
    if (!target) {
      return Response.json(
        { error: "Session's tmux pane closed during restart" },
        { status: 409, headers },
      );
    }
    const agent = this.getAgentByType(session.agentType);

    let restartCommand: string;
    if (agent?.resumeCommand) {
      if (session.agentType === "codex" && !session.nativeSessionId) {
        return Response.json(
          { error: "Session has no native Codex session ID for resume" },
          { status: 400, headers },
        );
      }
      const resumeId = getMarkerKey(session);
      restartCommand = substitutePlaceholders(agent.resumeCommand, {
        id: resumeId,
      });
    } else {
      const { command = "claude" } = await getPreferences();
      restartCommand = session.nativeSessionId
        ? `${command} --resume ${session.nativeSessionId}`
        : command;
    }

    try {
      const proc = Bun.spawn(
        ["tmux", "send-keys", "-t", target, restartCommand, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          { error: `tmux send-keys failed: ${stderr.trim()}` },
          { status: 500, headers },
        );
      }
    } catch (err: unknown) {
      return Response.json(
        { error: `Failed to restart session: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Kill all sessions with active processes, and reap every in-flight
   * invoke worker.
   *
   * Invoke teardown is owned here, not by the client: a subprocess invoke
   * has no session for the SIGTERM loop to reach, and a Claude invoke runs
   * `claude` in a detached `ccmux-invoke-<id>` session that SIGTERM alone
   * does not unwind (the invoker keeps polling for the turn end until its
   * per-invocation timeout). The daemon's `listInvocations()` is the
   * authoritative set of what is in flight; cancelling each one aborts the
   * invoker so it tears down its own resources and emits
   * `invocation_finished`. The client's in-flight set is a lossy mirror
   * (it never hydrates invokes it did not see start), so relying on it
   * would strand any invoke a mid-run-opened TUI never observed.
   */
  private handleKillAllSessions(headers: Record<string, string>): Response {
    // `cancel()` only fires the async abort; the synchronous SIGTERM loop below
    // may still reach a Claude invoke's live pid first, but the `cancelled`
    // outcome holds (the turn-end poll exits on the abort, not the SIGTERM).
    let cancelledInvocations = 0;
    for (const record of this.invocationManager.listInvocations()) {
      if (record.status !== "running") continue;
      this.invocationManager.cancel(record.invocationId);
      cancelledInvocations++;
    }

    // Exclude background rows from this bulk sweep: ccmux never owns their
    // worker pid (Claude's supervisor does), so stopping one means shelling out
    // to the agent's `backgroundStopCommand` per row. Deliberate asymmetry:
    // single-row `x` (handleKillSession) and kill-group DO stop them.
    const sessions = this.sessionManager
      .getSessions()
      .filter((s) => s.pid !== null && !isBackgroundSession(s));

    let killed = 0;
    let failed = 0;

    for (const session of sessions) {
      try {
        process.kill(session.pid!, "SIGTERM");
        killed++;
      } catch (err: unknown) {
        if (isErrnoException(err) && err.code === "ESRCH") {
          killed++; // Already dead counts as success
        } else {
          failed++;
        }
      }
    }

    return Response.json(
      { success: true, killed, failed, cancelledInvocations },
      { headers },
    );
  }

  /**
   * Send text to a session's tmux pane
   */
  private async handleSendToSession(
    sessionId: string,
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.resolveSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    let body: { text?: string; enter?: boolean };
    try {
      body = (await req.json()) as { text?: string; enter?: boolean };
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400, headers },
      );
    }

    const { text, enter = true } = body;
    if (!text || typeof text !== "string") {
      return Response.json(
        { error: "Missing or invalid 'text' field" },
        { status: 400, headers },
      );
    }

    if (text.length > MAX_SEND_TEXT_CHARS) {
      return Response.json(
        {
          error: `Text exceeds maximum length of ${MAX_SEND_TEXT_CHARS.toLocaleString("en-US")} characters`,
        },
        { status: 400, headers },
      );
    }

    // Target the stable `%N` pane id (guaranteed non-null by the guard above),
    // NOT the cached `session:window.pane` coordinate, which goes stale on a
    // window renumber within the scan interval and would inject text into the
    // wrong pane. `%N` is immutable for the pane's life.
    const target = session.tmuxPane;

    const sent = text.includes("\n")
      ? await this.paneSendDeps.sendPromptToPane(target, text, enter)
      : await this.paneSendDeps.sendLiteralToPane(target, text, enter);
    if (!sent) {
      return Response.json(
        { error: "Failed to send to session" },
        { status: 500, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Capture pane content for a session
   */
  private async handleScreenSession(
    sessionId: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.resolveSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    const lines = parseInt(url.searchParams.get("lines") ?? "50", 10);
    const lineCount = isNaN(lines) || lines < 1 ? 50 : lines;

    const content = await capturePane(session.tmuxPane, lineCount);

    return Response.json(
      {
        content,
        sessionId: session.id,
        paneId: session.tmuxPane,
        lines: lineCount,
      },
      { headers },
    );
  }

  /**
   * Handle SSE connection
   */
  private handleSSE(): Response {
    const clientId = crypto.randomUUID();

    const stream = new ReadableStream<string>({
      start: async (controller) => {
        // Store the client
        this.sseClients.set(clientId, { id: clientId, controller });

        // Send init event with pane-matched + background (paneless) sessions
        const matched = this.sessionManager
          .getSessions()
          .filter((s) => this.isVisibleSession(s));
        for (const s of matched) this.visibleSessions.add(s.id);
        const initEvent: SSEEvent = {
          type: "init",
          timestamp: new Date().toISOString(),
          sessions: await this.enrichSessions(matched),
          activePaneId: this.lastActivePaneId,
          // Snapshot of active + recently-finished invocations so a client
          // (re)connecting after a missed `invocation_finished` can reconcile
          // its synthetic rows and in-flight count against daemon truth.
          invocations: this.invocationManager
            .listInvocations()
            .map((r) => ({ invocationId: r.invocationId, status: r.status })),
          // Carried on init so a client joining mid-degradation banners it
          // immediately, without waiting for the next transition broadcast.
          health: this.getScanHealth(),
        };
        this.sendToClient(controller, initEvent);
      },
      cancel: () => {
        this.sseClients.delete(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Convert session event to SSE event, filtering paneless sessions.
   * Tracks visibility state so the TUI only sees pane-matched sessions.
   */
  private async sessionEventToSSE(
    event: SessionEvent,
  ): Promise<SSEEvent | null> {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case "created": {
        const session = event.session!;
        // Background rows (paneless by nature) and transcript-backed native
        // rows (visible even before — or without — a pane) emit their
        // session_created at creation. Pane-tracked sessions start
        // tmuxPane=null and are suppressed until a pane is assigned
        // (promoted in the "updated" branch).
        if (this.isVisibleSession(session)) {
          this.visibleSessions.add(session.id);
          return {
            type: "session_created",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        return null;
      }

      case "updated": {
        const session = event.session!;
        const isVisibleNow = this.isVisibleSession(session);
        const wasVisible = this.visibleSessions.has(session.id);

        if (isVisibleNow && !wasVisible) {
          // Pane just assigned — promote to visible as "created"
          this.visibleSessions.add(session.id);
          return {
            type: "session_created",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        if (isVisibleNow && wasVisible) {
          return {
            type: "session_updated",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        if (!isVisibleNow && wasVisible) {
          // Pane lost — demote from visible
          this.visibleSessions.delete(session.id);
          return {
            type: "session_removed",
            timestamp,
            sessionId: session.id,
          };
        }
        // No pane, never visible — suppress
        return null;
      }

      case "removed": {
        const sessionId = event.sessionId!;
        if (this.visibleSessions.has(sessionId)) {
          this.visibleSessions.delete(sessionId);
          return {
            type: "session_removed",
            timestamp,
            sessionId,
          };
        }
        return null;
      }
    }
  }

  /**
   * Enrich a session and, when it belongs to a Claude invoke, back-fill the
   * invocation record with where it landed so `ccmux invoke list` shows the
   * session/pane and the board can cancel it via POST /invoke/:id/cancel.
   * Runs on every visible create/update (idempotent field write) because a
   * native invoke session is now visible BEFORE its pane binds, so the
   * pane can arrive on any later update, not only at promotion.
   */
  private async backfillInvocationLink(
    session: Readonly<Session>,
  ): Promise<EnrichedSession> {
    const enriched = await this.enrichSession(session);
    if (enriched.originInvocationId) {
      this.invocationManager.linkSession(
        enriched.originInvocationId,
        session.id,
        session.tmuxPane,
      );
    }
    return enriched;
  }

  private sendToClient(
    controller: ReadableStreamDefaultController<string>,
    event: SSEEvent,
  ): void {
    this.sendFrame(controller, `data: ${JSON.stringify(event)}\n\n`);
  }

  /**
   * Enqueue an already-encoded SSE frame on one client. `broadcastEvent`
   * calls this per client with a frame stringified once (issue #55 item 3),
   * instead of each client re-running `JSON.stringify` on the same event.
   */
  private sendFrame(
    controller: ReadableStreamDefaultController<string>,
    frame: string,
  ): void {
    try {
      controller.enqueue(frame);
    } catch {
      // Client disconnected - clean up dead client
      for (const [id, client] of this.sseClients.entries()) {
        if (client.controller === controller) {
          this.sseClients.delete(id);
          break;
        }
      }
    }
  }

  /**
   * Resolve `POST /spawn`'s `fork` field to the session whose conversation
   * the new pane should continue, or `undefined` when this is an ordinary
   * spawn.
   *
   * The id may be either the tracked ccmux id (what the picker holds) or the
   * agent's own native id (what a human reads off `ccmux show` or the
   * agent's UI); for a native-tracked session the two are the same string.
   */
  private resolveForkSource(body: {
    fork?: unknown;
    resume?: string;
    prompt?: unknown;
  }): BuildResult<ForkSource | undefined> {
    const { fork } = body;
    if (fork === undefined || fork === null)
      return { ok: true, value: undefined };

    // A LOOKUP KEY, not a value that reaches a shell: it is compared against
    // ids ccmux itself minted and never interpolated into a command (what
    // gets interpolated is the resolved `nativeSessionId`, which the builder
    // pattern-checks itself). So this is a sanity bound, not the injection
    // guard. The strict pattern used to live here and locked out legitimate
    // pane-tracked ids: a custom agent named `my.agent` yields
    // `my.agent_pane3`, which it rejected, making those rows unforkable.
    if (
      typeof fork !== "string" ||
      fork.length === 0 ||
      fork.length > 256 ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(fork)
    ) {
      return { ok: false, error: "Invalid 'fork' field" };
    }
    // Fork is a way to START a session, not a modifier on one: each of these
    // builds its own command, so accepting the combination would mean
    // silently honoring one and dropping the other.
    // `!= null`, matching `normalizePrompt`'s treatment of null as absent. A
    // client that serializes omitted fields as null could otherwise never
    // fork at all.
    if (body.resume != null || body.prompt != null) {
      return {
        ok: false,
        error: "Cannot combine 'fork' with 'resume' or 'prompt'",
      };
    }

    const session =
      this.sessionManager.getSession(fork) ??
      this.sessionManager.getSessionByNativeSessionId(fork);
    if (!session) {
      return { ok: false, error: `Unknown session to fork: ${fork}` };
    }
    // Pane-tracked-only rows: ccmux knows a pane runs an agent but not which
    // conversation it holds, and there is nothing to continue from.
    if (!session.nativeSessionId) {
      return {
        ok: false,
        error:
          `Session ${fork} has no native session id to fork from. ` +
          `Install hooks with 'ccmux setup' so ccmux can track which conversation a pane holds.`,
      };
    }
    // Paneless background rows carry BOTH an agent type and a native session
    // id, so they reach here looking forkable. The picker hides the action
    // for them, but that is a display gate: this is where it has to be true.
    // "Fork into a pane beside the original" is meaningless without a pane,
    // and `claude --bg` is precisely the two-live-processes-on-one-session
    // case docs/agent-adapters.md says must be verified before an agent earns
    // a fork, which nobody has done for background workers.
    if (isBackgroundSession(session)) {
      return {
        ok: false,
        error:
          `Session ${fork} is a background agent, which has no pane to fork beside. ` +
          `Forking a background worker is not supported.`,
      };
    }
    // The destination check is NOT here, because it depends on the agent's
    // fork template and this runs before the agent is resolved. A `{path}`
    // fork accepts any destination the ordinary spawn path does (resuming by
    // transcript path skips directory resolution altogether), while an
    // id-form one is repo-scoped: see `forkDestinationProblem`, which the
    // route calls before its first side effect.
    return {
      ok: true,
      value: { session, nativeSessionId: session.nativeSessionId },
    };
  }

  /**
   * Why `cwd` cannot host a fork of `session`, or null when it can.
   *
   * Only asked of an id-form template (see `forkResumesByIdAlone`), which
   * resolves the conversation against the SOURCE's repository. Same repo, not
   * same directory: every checkout git reports is a directory the id resolves
   * from, so a sibling worktree is a legal destination and the plain equality
   * test this replaces refused ones that work. A destination git cannot place
   * (neither side is a repo) is held to equality, since a project directory
   * derived from a cwd is all the agent has left to look in.
   */
  private async forkDestinationProblem(
    session: Session,
    cwd: string,
  ): Promise<string | null> {
    if (resolve(cwd) === resolve(session.cwd)) return null;
    const [destination, source] = await Promise.all([
      this.getGitInfo(cwd),
      this.getGitInfo(session.cwd),
    ]);
    if (
      destination.mainRepoRoot !== null &&
      destination.mainRepoRoot === source.mainRepoRoot
    ) {
      return null;
    }
    return (
      `Cannot fork ${session.agentType} into ${cwd}: ` +
      `'agents.${session.agentType}.forkCommand' resumes by session id, which the agent ` +
      `resolves against the source session's repository (${session.cwd}), so the fork would ` +
      `come up in a pane with no conversation. Fork into a directory in that repository, or ` +
      `set that template to the transcript-path form ("{bin} --resume '{path}' --fork-session"), ` +
      `which resumes from anywhere.`
    );
  }

  /**
   * The agents this machine can start, for the picker's new-session dialog.
   *
   * Names are enumerated from the config, but every one is then resolved
   * through the daemon's OWN lookup — the same one `POST /spawn` uses — and
   * dropped if it isn't there. The daemon builds its agent list once at
   * boot, so reading the config directly would list an agent added since
   * then and have Enter answer "Unknown agent". Listing only what /spawn
   * will accept keeps the menu honest; a newly configured agent appears
   * after `ccmux daemon restart`, which its hooks need anyway.
   *
   * Resolved per request rather than cached: this is asked for only when
   * that dialog opens, and a cache would hide an agent installed on PATH
   * since boot (which needs no restart).
   */
  private async handleGetSpawnableAgents(
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      const preferences = await getPreferences();
      const known = getAgents(preferences)
        .map((agent) => this.getAgentByType(agent.name))
        .filter((agent): agent is AgentDef => agent !== undefined);
      return Response.json(
        {
          agents: listSpawnableAgents(known, {
            claudeCommand: preferences.command,
          }),
        },
        { headers },
      );
    } catch (err: unknown) {
      // `getAgents` throws on a malformed custom-agent block, and the
      // message names the offending key — worth surfacing rather than
      // leaving the dialog with an empty list and no explanation.
      return Response.json(
        { error: `Failed to resolve agents: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }
  }

  /**
   * Spawn a new agent session in a tmux pane
   */
  private async handleSpawn(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: {
      agent?: string;
      cwd?: string;
      resume?: string;
      fork?: unknown;
      prompt?: unknown;
      split?: SpawnSplit;
      target?: string;
      callerPane?: string;
      callerTty?: unknown;
      detach?: unknown;
      worktree?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400, headers },
      );
    }

    const { resume } = body;

    // Forking is resolved first because the SOURCE session supplies both the
    // agent and the default cwd, so the usual "is cwd present" check below
    // can only run once we know whether a source will fill it in.
    const forkResult = this.resolveForkSource(body);
    if (!forkResult.ok) {
      return Response.json(
        { error: forkResult.error },
        { status: 400, headers },
      );
    }
    const forkSource = forkResult.value;

    // The picker sends no cwd when forking: a fork belongs in the source's
    // directory by default. Forking somewhere else is still expressible (an
    // explicit cwd wins), which is the seam the worktree destination uses.
    const cwd = body.cwd ?? forkSource?.session.cwd;
    const agentName = forkSource?.session.agentType ?? body.agent ?? "claude";

    if (!cwd || typeof cwd !== "string") {
      return Response.json(
        { error: "Missing or invalid 'cwd' field" },
        { status: 400, headers },
      );
    }

    const splitResult = normalizeSplit(body.split);
    if (!splitResult.ok) {
      return Response.json(
        { error: splitResult.error },
        { status: 400, headers },
      );
    }
    const split = splitResult.value;

    // `target` is an explicit placement request; `callerPane` is merely
    // where the request came from. They differ for a new window: an
    // explicit target inserts next to it (renumbering later windows),
    // while the caller's pane only pins the SESSION, appending at the end.
    const targetResult = normalizeTarget(body.target);
    if (!targetResult.ok) {
      return Response.json(
        { error: targetResult.error },
        { status: 400, headers },
      );
    }
    const target = targetResult.value;

    const callerPaneResult = normalizeTarget(body.callerPane, "callerPane");
    if (!callerPaneResult.ok) {
      return Response.json(
        { error: callerPaneResult.error },
        { status: 400, headers },
      );
    }
    const callerPane = callerPaneResult.value;

    // The tty of the tmux client the caller is attached with. Only the CLI
    // knows it (the daemon has no client of its own), and it is only ever
    // used to move that client to a pane in another session — see
    // `buildSpawnFocusArgv`.
    const callerTtyResult = normalizeClientTty(body.callerTty);
    if (!callerTtyResult.ok) {
      return Response.json(
        { error: callerTtyResult.error },
        { status: 400, headers },
      );
    }
    const callerTty = callerTtyResult.value;

    const promptResult = normalizePrompt(body.prompt);
    if (!promptResult.ok) {
      return Response.json(
        { error: promptResult.error },
        { status: 400, headers },
      );
    }
    const prompt = promptResult.value;

    // Every other spawn field goes through a normalizer; `detach` used to be
    // an unchecked cast, so `{"detach":"false"}` (a truthy string) reached
    // tmux as `true`, passing `-d` and suppressing `select-window` — the
    // opposite of what the caller wrote.
    const detachResult = normalizeBoolean(body.detach, "detach");
    if (!detachResult.ok) {
      return Response.json(
        { error: detachResult.error },
        { status: 400, headers },
      );
    }
    const detach = detachResult.value ?? false;

    // `resume` is interpolated into a shell command typed into the pane, so an
    // unconstrained value is command injection. Constrain it like `/invoke`.
    // `!= null` so an explicitly-null field means absent, as it does for
    // `prompt` (see `normalizePrompt`); a client that serializes omitted
    // fields as null was otherwise rejected outright.
    if (resume != null) {
      if (
        typeof resume !== "string" ||
        !NATIVE_SESSION_ID_PATTERN.test(resume)
      ) {
        return Response.json(
          { error: "Invalid 'resume' field" },
          { status: 400, headers },
        );
      }
    }

    // Validate cwd exists and is a directory
    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) {
        return Response.json(
          { error: `Not a directory: ${cwd}` },
          { status: 400, headers },
        );
      }
    } catch {
      return Response.json(
        { error: `Directory does not exist: ${cwd}` },
        { status: 400, headers },
      );
    }

    // A worktree destination replaces the cwd for everything downstream, so it
    // is resolved here: past this point the handler is the ordinary spawn
    // path, and placement, split direction and per-agent prompt handling apply
    // to the new checkout without knowing it is one.
    const worktreeRequest = normalizeWorktreeRequest(body.worktree);
    if (!worktreeRequest.ok) {
      return Response.json(
        { error: worktreeRequest.error },
        { status: 400, headers },
      );
    }
    // Fork-into-a-new-worktree is a destination CREATION, not just a
    // different cwd, and nobody has run the combination against a live agent
    // yet. Resuming by transcript path removed the resume-scoping wall this
    // refusal used to cite, so what is left is an unshipped feature rather
    // than a technical impossibility: it is tracked separately, with its own
    // surface and its own live check. Refused BEFORE the worktree is created,
    // so a rejected request leaves no directory and no branch behind.
    if (forkSource && worktreeRequest.value) {
      return Response.json(
        {
          error:
            `Cannot fork ${forkSource.session.agentType} into a new worktree yet: ` +
            `that combination has not been verified against a live agent. ` +
            `Spawn a fresh session into the worktree, or fork into an existing ` +
            `directory with 'cwd'.`,
        },
        { status: 400, headers },
      );
    }

    // Resolve agent definition (custom agents from config are also valid)
    const agent = this.getAgentByType(agentName);
    if (!agent) {
      return Response.json(
        { error: `Unknown agent: ${agentName}` },
        { status: 400, headers },
      );
    }

    // A fork by session id only resolves inside the source's repository, so
    // its destination is checked here: before the worktree and the pane, and
    // after the agent whose template decides whether the question applies at
    // all. A `{path}` fork is destination-independent and skips this.
    if (forkSource && forkResumesByIdAlone(agent)) {
      const problem = await this.forkDestinationProblem(
        forkSource.session,
        cwd,
      );
      if (problem) {
        return Response.json({ error: problem }, { status: 400, headers });
      }
    }

    // Build agent command
    const preferences = await getPreferences();
    const cmd = spawnBinaryFor(agent, preferences.command);

    // The two builders are deliberately separate functions: forking is a
    // different command shape, and keeping its construction out of the
    // placement logic below is what lets a worktree destination reuse it.
    const commandResult = forkSource
      ? buildAgentForkCommand({
          agent,
          binary: cmd,
          sessionId: forkSource.nativeSessionId,
          // The builder decides whether it needs this and refuses when a
          // `{path}` template cannot get a readable transcript out of it.
          // Everything here runs before the first side effect, so that
          // refusal is a 400 with no pane and no worktree behind it.
          logPath: forkSource.session.logPath,
        })
      : buildAgentSpawnCommand({
          agent,
          binary: cmd,
          resume,
          prompt,
        });
    if (!commandResult.ok) {
      return Response.json(
        { error: commandResult.error },
        { status: 400, headers },
      );
    }
    const command = commandResult.value;

    // Measured on the BUILT command, because that is the argv element tmux
    // gets: the raw-prompt cap cannot promise it fits (the template adds bytes
    // and escaping a quote-heavy prompt multiplies them), and an oversized
    // single argument makes `Bun.spawn` THROW on Linux rather than exit
    // non-zero. Still ahead of the worktree and the pane, so this stays a 400
    // with nothing created.
    const oversizedCommand = spawnCommandTooLarge(command);
    if (oversizedCommand) {
      return Response.json(
        { error: oversizedCommand },
        { status: 400, headers },
      );
    }

    // Resolve placement. The pane is probed even on the split path, where
    // tmux would report its own failure, so that a stale pane is one
    // consistent 400 rather than a 400 on one branch and a raw-stderr 500
    // on the other.
    const placementPane = target ?? callerPane;
    let placement: SpawnPlacement | undefined;
    // The session the new pane will land in, and the one the caller is
    // looking at. Equal for every spawn that places by `callerPane`; they
    // diverge only when an explicit `target` names a pane in another session,
    // which is the case `buildSpawnFocusArgv` has to switch the client for.
    let placementSessionId: string | undefined;
    let callerSessionId: string | undefined;
    if (placementPane) {
      const location = await resolvePaneLocation(placementPane);
      if (!location) {
        return Response.json(
          { error: `Unknown target pane: ${placementPane}` },
          { status: 400, headers },
        );
      }
      placementSessionId = location.sessionId;
      if (placementPane === callerPane) callerSessionId = location.sessionId;
      if (split) {
        placement = { kind: "pane", id: placementPane };
      } else if (target) {
        // Explicitly named: put the window right after that one, even
        // though tmux renumbers the windows after it.
        placement = { kind: "window", id: location.windowId };
      } else {
        // Implicit: the caller only means "my session", so append at the
        // end. Inserting here would shift every later window's index and
        // break `select-window -t N` muscle memory and bindings.
        placement = { kind: "session", id: location.sessionId };
      }
    }

    // A second pane probe, deliberately narrow: it runs only when an explicit
    // target decided the placement AND the caller sent a client to move, so
    // an ordinary spawn costs exactly the tmux round-trips it always did.
    // Best-effort — a caller pane that vanished between the request and here
    // leaves the session unknown, which `buildSpawnFocusArgv` reads as "not
    // provably cross-session" and answers with today's `select-window`.
    if (
      !detach &&
      callerTty &&
      callerPane &&
      placementSessionId !== undefined &&
      callerSessionId === undefined
    ) {
      callerSessionId = (await resolvePaneLocation(callerPane))?.sessionId;
    }

    // Creating the worktree is the handler's first side effect, so it comes
    // last among the things that can still refuse the request. Everything
    // above resolves the agent, the command and the placement from the
    // request alone and never reads the destination directory, so a bad
    // agent name or a stale target pane now 400s without leaving a checkout
    // and a branch behind for the user to clean up.
    let spawnCwd = cwd;
    let worktreeInfo: WorktreeCreation | undefined;
    let moveInfo: SpawnMoveReport | undefined;
    if (worktreeRequest.value) {
      const gitInfo = await this.getGitInfo(cwd);
      if (!gitInfo.mainRepoRoot) {
        return Response.json(
          { error: `Not inside a git repository: ${cwd}` },
          { status: 400, headers },
        );
      }
      const mainRepoRoot = gitInfo.mainRepoRoot;
      const { withChanges, untracked, ...creation } = worktreeRequest.value;

      // Here rather than only inside the creation engine, because ORDER
      // matters: a move reads the source's status BEFORE it creates anything,
      // so an exclude written during creation lands too late to keep this
      // run's sibling worktrees out of the copy list and the counts. The
      // engine calls it too, and it is idempotent, so this is a cheap
      // `check-ignore` on the path that needs it earliest.
      await ensureWorktreesExcluded(mainRepoRoot);

      /**
       * The creation engine, adapted to the move module's seam.
       *
       * Two conversions: the repo root and the name-deriving prompt are
       * curried away (the move module knows neither), and a refusal becomes a
       * throw, which is how that module classifies a `create-failed` — the
       * arm that puts the stashed work back before returning.
       *
       * The full creation result is captured on the way past, because the
       * response still owes the caller the branch it landed on and whether
       * the worktree was made or merely opened. The seam carries the path and
       * `created`, the latter because the move's rollback deletes what it
       * made and must be able to tell a fresh worktree from an opened one.
       */
      const createForMove: CreateWorktree = async (opts) => {
        const created = await createWorktree(mainRepoRoot, {
          ...opts,
          prompt: prompt ?? undefined,
        });
        if (!created.ok) throw new Error(created.error);
        worktreeInfo = created.result;
        return {
          path: created.result.path,
          created: created.result.created,
          // Carried for the move's rollback messages: removing a worktree
          // leaves its branch, and the user is the one who has to clean it up.
          branch: created.result.branch,
        };
      };

      if (withChanges) {
        // Refused here rather than inside the move, because here nothing has
        // happened yet: no stash, no worktree, no half-finished anything.
        // The move itself refuses an opened worktree too (it has to — this
        // check can lose a race with a concurrent spawn), but by then the
        // user's changes have been through a stash and back.
        if (creation.name !== undefined) {
          const occupied = await existingWorktreeFor(
            mainRepoRoot,
            creation.name,
          );
          if (occupied) {
            return Response.json(
              {
                error:
                  `Worktree '${creation.name}' already exists at ${occupied}; moving changes needs a fresh worktree ` +
                  `(pick another name, or leave the name empty to derive one from the prompt).`,
                reason: "create-failed",
              },
              { status: 400, headers },
            );
          }
        }
        // Routed THROUGH the move, never beside it: the module owns the
        // ordering that keeps the work recoverable (stash, create, apply,
        // drop) and the rollback for every failure in it, so creating the
        // worktree here as well would both duplicate the checkout and step
        // outside those guarantees.
        const moved = await moveChangesToWorktree({
          source: cwd,
          name: creation.name,
          base: creation.base,
          untracked,
          createWorktree: createForMove,
        });
        if (!moved.ok) {
          // Every move failure is a 400, including the ones that fail
          // mid-git: the request was refused in full, nothing was spawned,
          // and the module has already put the source back. `reason` and
          // `stashSha` ride along because a stranded stash entry is the one
          // thing the user may still have to clean up by hand, and a 5xx is
          // the status callers report without the body.
          return Response.json(
            {
              error: moved.error,
              reason: moved.reason,
              ...(moved.stashSha ? { stashSha: moved.stashSha } : {}),
              ...(moved.sourceRestored !== undefined
                ? { sourceRestored: moved.sourceRestored }
                : {}),
              // Deliberately no `worktree`: the module takes back whatever it
              // created on every failure after creation, so echoing one here
              // would name a directory that is no longer there.
            },
            { status: 400, headers },
          );
        }
        spawnCwd = moved.worktreePath;
        moveInfo = {
          moved: moved.moved,
          // The module's own answer, not the request's `cwd`: a stash empties
          // the whole checkout, and the request routinely names a
          // subdirectory of it (a pane's cwd, the CLI's pwd).
          source: moved.source,
          untracked: moved.untracked,
          ...(moved.leftoverStash
            ? { leftoverStash: moved.leftoverStash }
            : {}),
          ...(moved.flattenedIndex ? { flattenedIndex: true } : {}),
        };
      } else {
        const created = await createWorktree(mainRepoRoot, {
          ...creation,
          prompt: prompt ?? undefined,
        });
        if (!created.ok) {
          return Response.json(
            { error: created.error },
            { status: 400, headers },
          );
        }
        worktreeInfo = created.result;
        spawnCwd = created.result.path;
      }
    }

    /**
     * Decorate a failure that happens AFTER the setup steps landed.
     *
     * Neither the worktree nor the move is rolled back here. The worktree is
     * left because create-or-open makes a retry correct and unwinding would
     * risk deleting one that already existed; the move is left because the
     * only thing that could undo it is putting the changes back, and by this
     * point they are a real working tree in the new checkout, not a stash
     * entry anybody can replay. Both are safe ONLY if the user is told, so
     * every note below exists to name state they now own.
     *
     * The move note comes first, and does not care whether the worktree was
     * created or opened: "the spawn failed" reads as "nothing happened", and
     * the one thing that definitely happened is that their uncommitted work
     * is no longer where they left it.
     *
     * The retry advice splits three ways. After a move there is nothing left
     * to move, so re-running the same command would refuse; the useful action
     * is starting an agent in the worktree. Otherwise only an explicit name
     * is stable, since a derived name that is already taken gets a numeric
     * suffix and a re-run would build a sibling.
     */
    const withSetupNotes = (error: string): string => {
      const notes: string[] = [];
      if (moveInfo) {
        notes.push(
          `your uncommitted changes were already moved out of ${moveInfo.source} to ${spawnCwd}`,
        );
      }
      if (worktreeInfo?.created) {
        const retry = moveInfo
          ? `re-running has nothing left to move, so start an agent there with --cwd '${worktreeInfo.path}' instead`
          : worktreeRequest.value?.name === undefined
            ? `re-running will create a numbered sibling, pass --worktree '${worktreeInfo.name}' to reuse this one`
            : "re-running the same command will reuse it";
        notes.push(
          `the worktree '${worktreeInfo.name}' was created at ${worktreeInfo.path} and left in place; ${retry}`,
        );
      }
      return notes.length > 0 ? `${error} (${notes.join("; ")})` : error;
    };

    /**
     * The body for one of those failures. `move` rides along for the same
     * reason it does on success: the counts are only knowable here, and a
     * caller that has to explain a half-done spawn needs them most.
     */
    const setupFailure = (error: string): Record<string, unknown> => ({
      error: withSetupNotes(error),
      ...(moveInfo ? { move: moveInfo } : {}),
    });

    // Create tmux pane
    const tmuxArgv = buildTmuxSpawnArgv({
      split,
      cwd: spawnCwd,
      placement,
      detach,
    });
    const tmuxCmd = tmuxArgv[0];
    // Hoisted so the outer catch (below) can kill a pane that was created
    // before a later step throws, not just before one that exits non-zero.
    // `Bun.spawn` throws rather than exiting non-zero for an oversized argv
    // (E2BIG on macOS, a single over-128KiB argument on Linux), and that
    // throw happens on the send-keys spawn, well after the pane exists.
    let paneId: string | undefined;
    // Past this point a throw can happen with a pane already created, so
    // every failure has to take it back down. Leaving it would strand an
    // empty shell the caller never asked for, and a caller retrying a
    // failing spawn would pile them up. No-ops if the pane was never
    // created (paneId still unset).
    const killPane = async (): Promise<void> => {
      if (!paneId) return;
      try {
        await Bun.spawn(["tmux", "kill-pane", "-t", paneId], {
          stdout: "pipe",
          stderr: "pipe",
        }).exited;
      } catch {
        // Best effort: the original failure is what we report.
      }
    };
    try {
      const proc = Bun.spawn(["tmux", ...tmuxArgv], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          setupFailure(`tmux ${tmuxCmd} failed: ${stderr.trim()}`),
          { status: 500, headers },
        );
      }

      paneId = (await new Response(proc.stdout).text()).trim();

      // Send the agent command into the new pane.
      //
      // No `-l --`, unlike `sendLiteralToPane`'s policy for user-typed
      // content: this string is a COMMAND for the shell, and it always
      // begins with the agent binary, so it can't start with a `-` that
      // send-keys would read as a flag. Prompt text only ever appears
      // inside it as a single-quoted argument, so no part of it can be
      // interpreted as a tmux key name.
      const sendProc = Bun.spawn(
        ["tmux", "send-keys", "-t", paneId, command, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const sendExit = await sendProc.exited;
      if (sendExit !== 0) {
        const stderr = await new Response(sendProc.stderr).text();
        await killPane();
        return Response.json(
          setupFailure(`Failed to send command to pane: ${stderr.trim()}`),
          { status: 500, headers },
        );
      }

      // Switch to the new pane unless detached. The session is already
      // running by this point (send-keys succeeded), so a failure here is
      // only a lost focus switch, not a failed spawn: it must not kill the
      // pane or turn the response into an error, or a working session the
      // caller can already see in `tmux list-panes` would be reported as
      // failed and torn down out from under them. Best effort, log and
      // continue.
      const focusArgv = await resolveSpawnFocusArgv(
        {
          paneId,
          detach,
          callerTty,
          placementSessionId,
          callerSessionId,
        },
        listTmuxClientTtys,
      );
      if (focusArgv) {
        try {
          const focusProc = Bun.spawn(["tmux", ...focusArgv], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const focusExit = await focusProc.exited;
          // Reported rather than swallowed: the response still says
          // `success: true` (it is), so a silently skipped switch would leave
          // the user with a pane they were told about, a view that never
          // moved, and nothing anywhere to explain it. `can't find client` is
          // the live failure mode now that a tty arrives from off-process.
          if (focusExit !== 0) {
            const stderr = (await new Response(focusProc.stderr).text()).trim();
            console.error(
              `tmux ${focusArgv[0]} for pane ${paneId} exited ${focusExit}` +
                (stderr ? `: ${stderr}` : ""),
            );
          }
        } catch (err: unknown) {
          console.error(`Failed to focus pane ${paneId}: ${errorMessage(err)}`);
        }
      }

      // `worktree` is echoed back because the caller asked for a destination
      // it did not name: the path, branch and base ref are decided here, and
      // `created` / `branchCreated` say which of the two the request made
      // rather than found, so a caller can report it without overclaiming.
      //
      // `move` reports what a `withChanges` spawn actually relocated, for the
      // same reason: the counts are only knowable here, and `leftoverStash`
      // is the one thing a SUCCESSFUL move can still leave behind.
      return Response.json(
        {
          success: true,
          paneId,
          command,
          worktree: worktreeInfo,
          move: moveInfo,
        },
        { headers },
      );
    } catch (err: unknown) {
      // Covers a throwing spawn anywhere in the block above (e.g. an
      // oversized send-keys argv), not just a non-zero exit: `paneId` may
      // already be set, and `killPane` no-ops otherwise.
      await killPane();
      return Response.json(
        setupFailure(`Failed to spawn session: ${errorMessage(err)}`),
        { status: 500, headers },
      );
    }
  }

  private async handleInvoke(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    // The `invocationId` is echoed back on every failure response so the
    // CLI can correlate against the id it generated locally. Captured by
    // the inner helper once we've validated it; before that, it's
    // intentionally omitted from the response body.
    let invocationId: string | undefined;
    const badRequest = (message: string): Response =>
      Response.json(
        {
          success: false,
          ...(invocationId !== undefined ? { invocationId } : {}),
          kind: "unknown",
          message,
        },
        { status: 400, headers },
      );

    let body: {
      invocationId?: string;
      agent?: string;
      prompt?: string;
      cwd?: string;
      sessionId?: string;
      timeoutMs?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("Invalid JSON body");
    }

    const {
      invocationId: rawInvocationId,
      agent: agentName,
      prompt,
      cwd,
      sessionId,
      timeoutMs,
    } = body;

    if (
      !rawInvocationId ||
      typeof rawInvocationId !== "string" ||
      !INVOCATION_ID_PATTERN.test(rawInvocationId)
    ) {
      return badRequest("Missing or invalid 'invocationId'");
    }
    invocationId = rawInvocationId;

    if (!agentName || typeof agentName !== "string") {
      return badRequest("Missing or invalid 'agent'");
    }
    if (!prompt || typeof prompt !== "string") {
      return badRequest("Missing or invalid 'prompt'");
    }
    if (Buffer.byteLength(prompt, "utf8") > MAX_INVOKE_PROMPT_BYTES) {
      return badRequest(
        `Prompt exceeds maximum size of ${MAX_INVOKE_PROMPT_BYTES} bytes`,
      );
    }
    if (!cwd || typeof cwd !== "string") {
      return badRequest("Missing or invalid 'cwd'");
    }
    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) return badRequest(`Not a directory: ${cwd}`);
    } catch {
      return badRequest(`Directory does not exist: ${cwd}`);
    }

    if (sessionId !== undefined) {
      if (
        typeof sessionId !== "string" ||
        !NATIVE_SESSION_ID_PATTERN.test(sessionId)
      ) {
        return badRequest("Invalid 'sessionId'");
      }
    }

    if (timeoutMs !== undefined) {
      if (
        typeof timeoutMs !== "number" ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_INVOKE_TIMEOUT_MS
      ) {
        return badRequest(
          `Invalid 'timeoutMs' (must be 1..${MAX_INVOKE_TIMEOUT_MS})`,
        );
      }
    }

    const agent = this.getAgentByType(agentName);
    if (!agent) return badRequest(`Unknown agent: ${agentName}`);

    // Resolve the invoker so `capabilitiesFor` can derive invoke-time
    // gates from `AgentDef`. Undefined here means a custom ccmux.json
    // agent that isn't `claude` and lacks `invokeMode`; reject up front
    // with the same `agent_error` shape `InvocationManager.invoke` would
    // have produced as defense-in-depth, so existing CLI matchers keying
    // on the word `invokeMode` keep working. `noInvokeModeMessage` is the
    // shared template.
    const invoker = this.invocationManager.getInvokerFor(agent);
    if (!invoker) {
      // 200 (not 400): same rationale as `hooks_missing` below. The CLI
      // routes on `data.kind`, not status.
      return Response.json(
        {
          success: false,
          invocationId,
          kind: "agent_error",
          message: noInvokeModeMessage(agent),
        },
        { status: 200, headers },
      );
    }

    // Hooks precheck applies only to invokers that need them for session
    // correlation (today: the Claude tmux path). Subprocess invocations
    // shell out to a non-interactive subcommand and don't need hooks for
    // invoke itself. Skipped when no adapter is registered (custom
    // ccmux.json agents have no built-in hook integration).
    if (capabilitiesFor(agent, invoker).requiresHooks) {
      const adapter = this.getHookAdapter(agent.name);
      if (adapter && !adapter.isInstalled()) {
        // 200 (not 400): the request is well-formed; the agent's hooks
        // not being installed is a logical runtime gate, mirroring how
        // rate_limit / timeout / agent_error are returned. The CLI keys
        // off `data.kind` either way and maps to exit code 3.
        return Response.json(
          {
            success: false,
            invocationId,
            kind: "hooks_missing",
            message: `Run \`ccmux setup --agent ${agent.name}\``,
          },
          { status: 200, headers },
        );
      }
    }

    // Claude's binary is user-overridable so wrappers/forks still work.
    // The subprocess path reads its binary from `invokeMode.args[0]`.
    const preferences = await getPreferences();
    const claudeBinary =
      agent.name === "claude" ? (preferences.command ?? "claude") : undefined;

    const input: InvokeInput = {
      invocationId,
      agent,
      claudeBinary,
      prompt,
      cwd,
      sessionId,
      timeoutMs: timeoutMs ?? 300_000,
    };
    let result: InvokeResult;
    try {
      result = await this.invocationManager.invoke(input);
    } catch (err) {
      result = {
        success: false,
        invocationId,
        kind: "unknown",
        message: errorMessage(err),
      };
    }
    // Logical agent failures (rate_limit, timeout, hooks_missing, cancelled,
    // agent_error, unknown) ride on 200 so the CLI's `data.kind` is the
    // single source of truth for outcome. Protocol-level rejections
    // (missing/invalid fields) still return 400 above.
    return Response.json(result, { status: 200, headers });
  }

  private async handleInvokeCancel(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      return Response.json(
        { success: false, message: "Invalid 'invocationId'" },
        { status: 400, headers },
      );
    }
    // Classify BEFORE cancelling so the CLI can ack truthfully instead of
    // always printing "Cancelled": a `running` record is genuinely being
    // cancelled; a terminal record already finished; no record means the
    // id is unknown (a typo, or a cancel racing ahead of invoke(), which
    // the manager stashes for the pending start). `cancel()` itself stays
    // best-effort and returns true either way.
    const record = this.invocationManager.getInvocation(invocationId);
    const state: "cancelling" | "already_finished" | "not_found" =
      record === undefined
        ? "not_found"
        : record.status === "running"
          ? "cancelling"
          : "already_finished";
    const ok = this.invocationManager.cancel(invocationId);
    return Response.json({ success: ok, state }, { status: 200, headers });
  }

  /**
   * Return an invocation's full captured output from the ephemeral
   * `/tmp` result store. Reap-tolerant: a gone file (reaped, never
   * written, or written by a since-restarted daemon) is a clean
   * `{ available: false }` on 200, never an error, so `ccmux invoke
   * result <id>` can print a clean "result no longer available" miss.
   * Only the subprocess invoke path writes results; Claude invokes drive
   * a tmux session with no stdout buffer, so their result is always a
   * miss in v1.
   */
  private async handleInvocationResult(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      return Response.json(
        { available: false, message: "Invalid 'invocationId'" },
        { status: 400, headers },
      );
    }
    const output = await readInvocationResult(invocationId);
    if (output === null) {
      return Response.json({ available: false }, { status: 200, headers });
    }
    return Response.json({ available: true, output }, { status: 200, headers });
  }

  private broadcastEvent(event: SSEEvent): void {
    // Stringify once for every client instead of once per client (issue #55
    // item 3): matters most during event bursts with several attached
    // picker/sidebar clients.
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients.values()) {
      this.sendFrame(client.controller, frame);
    }
  }

  /**
   * Push the daemon's current scan-health to every connected client. Called by
   * the daemon on each degraded/recovered transition; reads the snapshot
   * through the same accessor as the init frame so the wire value is always
   * consistent with what a fresh connect would see.
   */
  broadcastDaemonHealth(): void {
    this.broadcastEvent({
      type: "daemon_health",
      timestamp: new Date().toISOString(),
      health: this.getScanHealth(),
    });
  }
}
