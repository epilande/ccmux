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
  OMP_EXTENSION_DIR,
  OMP_EXTENSION_FILE,
} from "../../../lib/config";
import pkg from "../../../../package.json" with { type: "json" };
import { renderOmpExtension } from "./extension-script";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import { markerStatusState } from "../../cascade-evaluator";
import type { SessionPidMarker } from "../../session-markers";
import type { SessionState } from "../../../types/session";

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
 * oh-my-pi (omp) extension-based hook integration.
 *
 * omp is a hard fork of Pi that kept Pi's extension API, so this adapter is
 * structurally the Pi adapter with one addition: omp has a tool-approval
 * pause, so its marker can carry `waiting_permission` and this adapter
 * projects a real permission wait.
 *
 * - Install writes a single auto-discovered file
 *   (`~/.omp/agent/extensions/ccmux.js`) with a sentinel first line so we
 *   only ever overwrite/delete a file ccmux wrote.
 * - Marker handling is 1:1 (omp runs one session per process).
 *   `onMarkerAdded` correlates `marker.pid` -> pane -> session via PID
 *   ancestry and links `nativeSessionId`; subsequent state flips ride the
 *   generic cascade (`genericMarkerSource`) on marker change.
 */
export class OmpHookAdapter implements HookAdapter {
  readonly agentType = "omp";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];

    const inspection = inspectInstalledExtension(OMP_EXTENSION_FILE);
    if (inspection.exists && !inspection.owned) {
      // Advisory, keep-going posture (matches OpenCode/Codex/pi) so a
      // combined `ccmux setup` can still install the other agents' hooks.
      lines.push(
        `Skipped ${OMP_EXTENSION_FILE}: first line does not start with "${SENTINEL_PREFIX}".`,
      );
      lines.push(
        "Move the existing file aside and re-run `ccmux setup --agent omp` to install.",
      );
      return { lines, changed: false };
    }

    mkdirSync(OMP_EXTENSION_DIR, { recursive: true });
    mkdirSync(MARKERS_DIR, { recursive: true });

    const source = renderOmpExtension({
      markersDir: MARKERS_DIR,
      version: CCMUX_VERSION,
    });
    const tmp = `${OMP_EXTENSION_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, source);
    renameSync(tmp, OMP_EXTENSION_FILE);

    lines.push(
      inspection.exists
        ? `Updated extension: ${OMP_EXTENSION_FILE} (was v${inspection.version ?? "unknown"}, now v${CCMUX_VERSION})`
        : `Created extension: ${OMP_EXTENSION_FILE}`,
    );
    lines.push("omp will auto-discover the extension on next launch.");
    lines.push("Restart any running omp sessions to pick up the extension.");
    return { lines, changed: true };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    const inspection = inspectInstalledExtension(OMP_EXTENSION_FILE);
    if (!inspection.exists) {
      lines.push(`No ccmux extension at ${OMP_EXTENSION_FILE}.`);
      return { lines, changed: false };
    }
    if (!inspection.owned) {
      lines.push(
        `Skipped ${OMP_EXTENSION_FILE}: first line does not start with "${SENTINEL_PREFIX}". ` +
          "Refusing to delete a file ccmux did not write.",
      );
      return { lines, changed: false };
    }
    unlinkSync(OMP_EXTENSION_FILE);
    lines.push(`Removed ${OMP_EXTENSION_FILE}`);
    lines.push(
      "Marker files under ~/.config/ccmux/session-pids/ will be swept on the next daemon cycle.",
    );
    return { lines, changed: true };
  }

  isInstalled(): boolean {
    return inspectInstalledExtension(OMP_EXTENSION_FILE).owned;
  }

  describeInstallDetail(): string | null {
    const inspection = inspectInstalledExtension(OMP_EXTENSION_FILE);
    if (!inspection.owned || !inspection.version) return null;
    return inspection.version === CCMUX_VERSION
      ? `(extension v${inspection.version}, matches running ccmux)`
      : `(extension v${inspection.version})`;
  }

  describeInstallAnomalies(): string[] {
    const inspection = inspectInstalledExtension(OMP_EXTENSION_FILE);
    if (!inspection.owned) return [];
    if (inspection.version && inspection.version !== CCMUX_VERSION) {
      return [
        `omp: extension at ${OMP_EXTENSION_FILE} is v${inspection.version} but ccmux is v${CCMUX_VERSION}. ` +
          "Run `ccmux setup --agent omp` to update.",
      ];
    }
    return [];
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // omp has no per-session log we tail. The generic PID-liveness sweep in
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
    ctx.sessionManager.updateSession(session.id, stateFromOmpMarker(marker));
  }

  async onMarkerRemoved(
    _marker: SessionPidMarker,
    _ctx: HookManagerContext,
  ): Promise<void> {
    // No teardown needed: when omp exits, session_shutdown removes the
    // marker, the process scan clears the pane-tracked session, and
    // cleanupStaleMarkers reaps any leftover by PID liveness. Session
    // switches are handled by the extension, which removes the old marker
    // and writes a new one, whose onMarkerAdded re-links nativeSessionId.
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
 * Map an omp marker into the SessionState fields the adapter owns. Unlike
 * pi's projection, `waiting_permission` is reachable. The status/attention
 * tuple comes from the cascade's own `markerStatusState`, so this add-time
 * write and every later reconcile agree by construction; only
 * `lastPrompt`/`lastActivityAt` are the adapter's to add.
 */
function stateFromOmpMarker(marker: SessionPidMarker): Partial<SessionState> {
  return {
    ...markerStatusState(marker),
    lastPrompt: marker.last_prompt,
    lastActivityAt: marker.state_timestamp
      ? new Date(marker.state_timestamp * 1000).toISOString()
      : undefined,
  };
}
