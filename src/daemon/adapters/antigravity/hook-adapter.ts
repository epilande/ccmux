import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { PREINVOCATION_HOOK_SCRIPT, STOP_HOOK_SCRIPT } from "./hook-scripts";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import type { SessionState } from "../../../types/session";

const PREINVOCATION_SCRIPT = "ccmux-preinvocation.sh";
const STOP_SCRIPT = "ccmux-stop.sh";
const SENTINEL = "# ccmux-antigravity-hook v1";

interface NamedHook {
  PreInvocation: Array<{ type: "command"; command: string }>;
  Stop: Array<{ type: "command"; command: string }>;
}

type HooksFile = Record<string, unknown>;

export class AntigravityHookAdapter implements HookAdapter {
  readonly agentType = "antigravity";

  constructor(
    private readonly configDir = join(homedir(), ".gemini", "config"),
  ) {}

  private get hooksFile(): string {
    return join(this.configDir, "hooks.json");
  }

  private get scriptsDir(): string {
    return join(this.configDir, "hooks");
  }

  private desiredHook(): NamedHook {
    return {
      // Never add PreToolUse or PostToolUse. In agy v1.1.1, an empty
      // PreToolUse response silently denies the user's tool call.
      PreInvocation: [
        {
          type: "command",
          command: join(this.scriptsDir, PREINVOCATION_SCRIPT),
        },
      ],
      Stop: [{ type: "command", command: join(this.scriptsDir, STOP_SCRIPT) }],
    };
  }

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let hooks: HooksFile = {};
    const existed = existsSync(this.hooksFile);
    if (existed) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(this.hooksFile, "utf-8"),
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("top level must be a JSON object");
        }
        hooks = parsed as HooksFile;
      } catch (error) {
        return {
          changed: false,
          lines: [
            `Refused to modify ${this.hooksFile}: ${errorMessage(error)}`,
          ],
        };
      }
    }

    mkdirSync(this.scriptsDir, { recursive: true });
    let changed = false;
    for (const [name, content] of [
      [PREINVOCATION_SCRIPT, PREINVOCATION_HOOK_SCRIPT],
      [STOP_SCRIPT, STOP_HOOK_SCRIPT],
    ] as const) {
      const path = join(this.scriptsDir, name);
      if (existsSync(path) && readFileSync(path, "utf-8") === content) {
        lines.push(`Hook script already up to date: ${path}`);
      } else {
        const wasPresent = existsSync(path);
        writeFileSync(path, content);
        chmodSync(path, 0o755);
        lines.push(
          `${wasPresent ? "Updated" : "Created"} hook script: ${path}`,
        );
        changed = true;
      }
    }

    const desired = this.desiredHook();
    if (JSON.stringify(hooks.ccmux) === JSON.stringify(desired)) {
      lines.push(`ccmux hook already up to date in ${this.hooksFile}`);
      return { lines, changed };
    }
    if (existed) {
      copyFileSync(this.hooksFile, `${this.hooksFile}.backup`);
      lines.push(`Backed up hooks to ${this.hooksFile}.backup`);
    }
    hooks.ccmux = desired;
    writeFileSync(this.hooksFile, JSON.stringify(hooks, null, 2) + "\n");
    lines.push(`Updated ${this.hooksFile}`);
    return { lines, changed: true };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;
    if (existsSync(this.hooksFile)) {
      try {
        const hooks = JSON.parse(
          readFileSync(this.hooksFile, "utf-8"),
        ) as HooksFile;
        if (Object.hasOwn(hooks, "ccmux")) {
          delete hooks.ccmux;
          writeFileSync(this.hooksFile, JSON.stringify(hooks, null, 2) + "\n");
          lines.push(`Removed ccmux hook from ${this.hooksFile}`);
          changed = true;
        }
      } catch (error) {
        lines.push(
          `Refused to modify ${this.hooksFile}: ${errorMessage(error)}`,
        );
      }
    }
    for (const name of [PREINVOCATION_SCRIPT, STOP_SCRIPT]) {
      const path = join(this.scriptsDir, name);
      if (existsSync(path)) {
        unlinkSync(path);
        lines.push(`Removed ${path}`);
        changed = true;
      }
    }
    return { lines, changed };
  }

  isInstalled(): boolean {
    try {
      const hooks = JSON.parse(
        readFileSync(this.hooksFile, "utf-8"),
      ) as HooksFile;
      const serialized = JSON.stringify(hooks.ccmux ?? {});
      return (
        serialized.includes(PREINVOCATION_SCRIPT) &&
        serialized.includes(STOP_SCRIPT)
      );
    } catch {
      return false;
    }
  }

  describeInstallDetail(): string | null {
    return this.isInstalled() ? "(PreInvocation and Stop hooks)" : null;
  }

  describeInstallAnomalies(): string[] {
    if (!this.isInstalled()) return [];
    for (const name of [PREINVOCATION_SCRIPT, STOP_SCRIPT]) {
      const path = join(this.scriptsDir, name);
      if (
        !existsSync(path) ||
        !readFileSync(path, "utf-8").includes(SENTINEL)
      ) {
        return [
          `antigravity: hook script missing or version-skewed at ${path}`,
        ];
      }
    }
    return [];
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // There is no tailable log in v1. PID liveness owns marker cleanup.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    const panes = await ctx.listPanes();
    const tty =
      marker.tty && marker.tty !== "unknown"
        ? marker.tty.replace(/^\/dev\//, "")
        : null;
    let pane = tty
      ? (panes.find(
          (candidate) => candidate.tty?.replace(/^\/dev\//, "") === tty,
        ) ?? null)
      : null;
    pane ??= await ctx.getPaneHostingPid(marker.pid);
    if (!pane) return;
    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    if (!session) return;
    if (
      ctx.sessionManager.setNativeSessionId(session.id, marker.session_id, {
        reclaim: true,
      }) === "conflict"
    ) {
      return;
    }
    ctx.sessionManager.updateSession(session.id, stateFromMarker(marker));
  }

  async onMarkerRemoved(
    _marker: SessionPidMarker,
    _ctx: HookManagerContext,
  ): Promise<void> {}
}

function stateFromMarker(marker: SessionPidMarker): Partial<SessionState> {
  if (marker.state === "working") {
    return { status: "working", attentionType: null, pendingTool: null };
  }
  if (marker.state === "waiting_permission") {
    return {
      status: "waiting",
      attentionType: "permission",
      pendingTool: marker.pending_tool ?? null,
    };
  }
  return { status: "idle", attentionType: null, pendingTool: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
