import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  MARKERS_DIR,
  PI_EXTENSION_DIR,
  PI_EXTENSION_FILE,
} from "../../../lib/config";
import pkg from "../../../../package.json" with { type: "json" };
import { renderPiExtension } from "./extension-script";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import type { SessionState, SessionStatus } from "../../../types/session";

const CCMUX_VERSION: string = pkg.version;

const SENTINEL_PREFIX = "// ccmux-extension v";
const SENTINEL_REGEX = /^\/\/ ccmux-extension v(\S+)/;

function inspectInstalledExtension(path: string): {
  exists: boolean;
  owned: boolean;
  version: string | null;
} {
  if (!existsSync(path)) return { exists: false, owned: false, version: null };
  let firstLine: string;
  try {
    firstLine = readFileSync(path, "utf-8").split("\n", 1)[0];
  } catch {
    return { exists: true, owned: false, version: null };
  }
  const match = firstLine.match(SENTINEL_REGEX);
  if (!match) return { exists: true, owned: false, version: null };
  return { exists: true, owned: true, version: match[1] };
}

/**
 * pi extension-based hook integration.
 *
 * Structurally a blend of the OpenCode and Cursor adapters:
 * - Install, like OpenCode, writes a single auto-discovered file
 *   (`~/.pi/agent/extensions/ccmux.js`) with a sentinel first line
 *   (`// ccmux-extension v<version>`) so we only ever overwrite/delete a
 *   file ccmux wrote. pi discovers both `*.ts` and `*.js`, so the `.js`
 *   form keeps the template out of ccmux's TypeScript build.
 * - Marker handling, like Cursor, is 1:1 (pi runs one session per
 *   process). `onMarkerAdded` correlates `marker.pid` -> pane -> session
 *   via PID ancestry and links `nativeSessionId`; subsequent working<->idle
 *   flips ride the generic cascade (`genericMarkerSource`) on marker change.
 *
 * The extension writes a marker at `session_start` (which pi fires at
 * launch with full identity), flips it working/idle on `agent_start`/
 * `agent_end`, and removes it on `session_shutdown`.
 */
export class PiHookAdapter implements HookAdapter {
  readonly agentType = "pi";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];

    const inspection = inspectInstalledExtension(PI_EXTENSION_FILE);
    if (inspection.exists && !inspection.owned) {
      // Advisory, keep-going posture (matches OpenCode/Codex) so a combined
      // `ccmux setup` can still install the other agents' hooks.
      lines.push(
        `Skipped ${PI_EXTENSION_FILE}: first line does not start with "${SENTINEL_PREFIX}".`,
      );
      lines.push(
        "Move the existing file aside and re-run `ccmux setup --agent pi` to install.",
      );
      return { lines, changed: false };
    }

    mkdirSync(PI_EXTENSION_DIR, { recursive: true });
    mkdirSync(MARKERS_DIR, { recursive: true });

    const source = renderPiExtension({
      markersDir: MARKERS_DIR,
      version: CCMUX_VERSION,
    });
    const tmp = `${PI_EXTENSION_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, source);
    renameSync(tmp, PI_EXTENSION_FILE);

    lines.push(
      inspection.exists
        ? `Updated extension: ${PI_EXTENSION_FILE} (was v${inspection.version ?? "unknown"}, now v${CCMUX_VERSION})`
        : `Created extension: ${PI_EXTENSION_FILE}`,
    );
    lines.push("pi will auto-discover the extension on next launch.");
    lines.push("Restart any running pi sessions to pick up the extension.");
    return { lines, changed: true };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    const inspection = inspectInstalledExtension(PI_EXTENSION_FILE);
    if (!inspection.exists) {
      lines.push(`No ccmux extension at ${PI_EXTENSION_FILE}.`);
      return { lines, changed: false };
    }
    if (!inspection.owned) {
      lines.push(
        `Skipped ${PI_EXTENSION_FILE}: first line does not start with "${SENTINEL_PREFIX}". ` +
          "Refusing to delete a file ccmux did not write.",
      );
      return { lines, changed: false };
    }
    unlinkSync(PI_EXTENSION_FILE);
    lines.push(`Removed ${PI_EXTENSION_FILE}`);
    lines.push(
      "Marker files under ~/.config/ccmux/session-pids/ will be swept on the next daemon cycle.",
    );
    return { lines, changed: true };
  }

  isInstalled(): boolean {
    return inspectInstalledExtension(PI_EXTENSION_FILE).owned;
  }

  describeInstallDetail(): string | null {
    const inspection = inspectInstalledExtension(PI_EXTENSION_FILE);
    if (!inspection.owned || !inspection.version) return null;
    return inspection.version === CCMUX_VERSION
      ? `(extension v${inspection.version}, matches running ccmux)`
      : `(extension v${inspection.version})`;
  }

  describeInstallAnomalies(): string[] {
    const inspection = inspectInstalledExtension(PI_EXTENSION_FILE);
    if (!inspection.owned) return [];
    if (inspection.version && inspection.version !== CCMUX_VERSION) {
      return [
        `pi: extension at ${PI_EXTENSION_FILE} is v${inspection.version} but ccmux is v${CCMUX_VERSION}. ` +
          "Run `ccmux setup --agent pi` to update.",
      ];
    }
    return [];
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // pi has no per-session log we tail. The generic PID-liveness sweep in
    // `cleanupStaleMarkers` is the whole story for us.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    const session = await findTargetSession(marker.pid, ctx, this.agentType);
    if (!session) return;

    // Marker-backed, so reclaim: a heuristic holder of this id
    // is stripped and the id re-routes here. A remaining conflict means a
    // native row owns the id; skip the marker-derived state update or we
    // would apply a foreign session's state to this row (a "noop" re-fire
    // still proceeds).
    if (
      ctx.sessionManager.setNativeSessionId(session.id, marker.session_id, {
        reclaim: true,
      }) === "conflict"
    ) {
      return;
    }
    ctx.sessionManager.updateSession(session.id, stateFromPiMarker(marker));
    // pi has no registered LogAdapter, so this only makes the transcript
    // path visible to consumers that check for one themselves (fork's
    // {path} template, ccmux show); it does not add a cascade log source
    // (that's keyed on a registered adapter, not mere logPath presence).
    // Existence-checked because the marker's value is unparsed input.
    if (marker.transcript_path && existsSync(marker.transcript_path)) {
      ctx.sessionManager.setLogPath(session.id, marker.transcript_path);
    }
  }

  async onMarkerRemoved(
    _marker: SessionPidMarker,
    _ctx: HookManagerContext,
  ): Promise<void> {
    // No teardown needed: when pi exits, session_shutdown removes the
    // marker, the process scan clears the pane-tracked session, and
    // cleanupStaleMarkers reaps any leftover by PID liveness. A session
    // switch (/new, /resume) removes the old marker and writes a new one,
    // whose onMarkerAdded re-links nativeSessionId.
  }
}

async function findTargetSession(
  pid: number,
  ctx: HookManagerContext,
  agentType: string,
): Promise<{ id: string } | null> {
  const pane = await ctx.getPaneHostingPid(pid);
  if (!pane) return null;
  const session = findPaneTrackedSession(ctx, agentType, pane.paneId);
  return session ? { id: session.id } : null;
}

/**
 * Map a pi marker into the SessionState fields the adapter owns. pi never
 * emits `waiting_permission` (it runs tools without an approval pause), so
 * this is a plain working/idle projection plus the captured prompt.
 */
function stateFromPiMarker(marker: SessionPidMarker): Partial<SessionState> {
  const status: SessionStatus = marker.state === "working" ? "working" : "idle";
  return {
    status,
    attentionType: null,
    pendingTool: null,
    lastPrompt: marker.last_prompt,
    lastActivityAt: marker.state_timestamp
      ? new Date(marker.state_timestamp * 1000).toISOString()
      : undefined,
  };
}
