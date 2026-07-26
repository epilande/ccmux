import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Temp dir created at module scope so mock.module has a fixed MARKERS_DIR path. */
const tempRoot = join(
  tmpdir(),
  `ccmux-markers-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const testMarkersDir = join(tempRoot, "session-pids");

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  MARKERS_DIR: testMarkersDir,
}));

import {
  getAllSessionPidMarkers,
  refreshMarkerCache,
  getSessionPidMarker,
  cleanupStaleMarkers,
  parseMarkerFile,
} from "./session-markers";
import type { SessionPidMarker } from "./session-markers";
import { ClaudeHookAdapter } from "./adapters/claude/hook-adapter";

function makeMarker(
  overrides: Partial<SessionPidMarker> = {},
): SessionPidMarker {
  return {
    agent_type: "claude",
    pid: 12345,
    tty: "/dev/ttys001",
    session_id: "sess-abc",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

const claudeAdapter = new ClaudeHookAdapter();
const claudeLivenessCheck = (marker: SessionPidMarker): boolean =>
  claudeAdapter.isSessionStillLive(marker);

function writeMarker(filename: string, marker: SessionPidMarker) {
  writeFileSync(
    join(testMarkersDir, `${filename}.json`),
    JSON.stringify(marker),
  );
}

function writeRawFile(filename: string, content: string) {
  writeFileSync(join(testMarkersDir, filename), content);
}

describe("session-markers", () => {
  beforeEach(() => {
    mkdirSync(testMarkersDir, { recursive: true });
    refreshMarkerCache();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("getAllSessionPidMarkers", () => {
    it("returns empty array when MARKERS_DIR does not exist", () => {
      rmSync(testMarkersDir, { recursive: true, force: true });
      expect(getAllSessionPidMarkers()).toEqual([]);
    });

    it("returns empty array when MARKERS_DIR is empty", () => {
      expect(getAllSessionPidMarkers()).toEqual([]);
    });

    it("returns parsed markers from all .json files", () => {
      const m1 = makeMarker({ pid: 100, session_id: "s1" });
      const m2 = makeMarker({ pid: 200, session_id: "s2" });
      writeMarker("s1", m1);
      writeMarker("s2", m2);

      const result = getAllSessionPidMarkers();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(m1);
      expect(result).toContainEqual(m2);
    });

    it("skips non-.json files", () => {
      writeMarker("valid", makeMarker({ session_id: "valid" }));
      writeRawFile("readme.txt", "not a marker");

      const result = getAllSessionPidMarkers();
      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe("valid");
    });

    it("skips malformed JSON files", () => {
      writeMarker("good", makeMarker({ session_id: "good" }));
      writeRawFile("bad.json", "not valid json {{{");

      const result = getAllSessionPidMarkers();
      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe("good");
    });
  });

  describe("refreshMarkerCache / getSessionPidMarker", () => {
    it("populates cache from disk markers", () => {
      writeMarker("s1", makeMarker({ session_id: "s1", pid: 111 }));
      writeMarker("s2", makeMarker({ session_id: "s2", pid: 222 }));
      refreshMarkerCache();

      expect(getSessionPidMarker("s1")?.pid).toBe(111);
      expect(getSessionPidMarker("s2")?.pid).toBe(222);
    });

    it("returns null for unknown sessionId", () => {
      refreshMarkerCache();
      expect(getSessionPidMarker("nonexistent")).toBeNull();
    });

    it("clears previous cache on refresh", () => {
      writeMarker("s1", makeMarker({ session_id: "s1" }));
      refreshMarkerCache();
      expect(getSessionPidMarker("s1")).not.toBeNull();

      rmSync(join(testMarkersDir, "s1.json"));
      refreshMarkerCache();
      expect(getSessionPidMarker("s1")).toBeNull();
    });
  });

  describe("cleanupStaleMarkers", () => {
    /**
     * The daemon-owned PID-reap hysteresis state, fresh per test and carried
     * across the calls within one test so a scan sequence can be replayed.
     */
    let pidReapPending: Set<string>;

    beforeEach(() => {
      pidReapPending = new Set();
    });

    /** One scan. */
    const cleanup = (
      activePids: Set<number>,
      activeTtys: Map<number, string> | undefined,
      isSessionStillLive: (marker: SessionPidMarker) => boolean,
    ): number =>
      cleanupStaleMarkers(
        activePids,
        activeTtys,
        isSessionStillLive,
        pidReapPending,
      );

    it("returns 0 when MARKERS_DIR does not exist", () => {
      rmSync(testMarkersDir, { recursive: true, force: true });
      expect(cleanup(new Set(), undefined, claudeLivenessCheck)).toBe(0);
    });

    it("deletes markers for dead PIDs after two consecutive scans", () => {
      writeMarker("s1", makeMarker({ pid: 999, session_id: "s1" }));
      const activePids = new Set([100]);

      // First scan only proposes the reap.
      expect(cleanup(activePids, undefined, claudeLivenessCheck)).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);

      expect(cleanup(activePids, undefined, claudeLivenessCheck)).toBe(1);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(false);
    });

    it("keeps a marker whose PID reappears on the next scan", () => {
      // A single scan's process discovery can omit a live process (on macOS
      // the pid set is gated on one lsof call resolving each tty). Deleting
      // the authoritative marker on that tick would strand a running session.
      writeMarker("s1", makeMarker({ pid: 100, session_id: "s1" }));

      expect(cleanup(new Set(), undefined, () => true)).toBe(0);
      expect(cleanup(new Set([100]), undefined, () => true)).toBe(0);
      // The proposal was dropped, so a later single miss starts over.
      expect(cleanup(new Set(), undefined, () => true)).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);
    });

    it("counts a re-exec under a new PID as its own first scan", () => {
      // Same session, new pid: the previous pid's pending reap must not carry
      // over and delete the fresh marker on its first missing scan.
      writeMarker("s1", makeMarker({ pid: 900, session_id: "s1" }));
      expect(cleanup(new Set(), undefined, () => true)).toBe(0);

      writeMarker("s1", makeMarker({ pid: 901, session_id: "s1" }));
      expect(cleanup(new Set(), undefined, () => true)).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);

      expect(cleanup(new Set(), undefined, () => true)).toBe(1);
    });

    it("still reaps a dead PID's marker without waiting on the other checks", () => {
      // Hysteresis is scoped to PID liveness: a marker that fails the
      // agent-specific liveness check goes on the first scan, as before.
      writeMarker(
        "s1",
        makeMarker({ pid: 100, session_id: "s1", tty: "/dev/ttys001" }),
      );

      expect(cleanup(new Set([100]), undefined, () => false)).toBe(1);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(false);
    });

    it("removes same-PID markers whose per-agent liveness check fails", () => {
      const now = Math.floor(Date.now() / 1000);
      writeMarker(
        "old",
        makeMarker({ pid: 100, session_id: "old", timestamp: now - 60 }),
      );
      writeMarker(
        "new",
        makeMarker({ pid: 100, session_id: "new", timestamp: now }),
      );

      const cleaned = cleanup(
        new Set([100]),
        undefined,
        (m) => m.session_id === "new",
      );
      expect(cleaned).toBe(1);
      expect(existsSync(join(testMarkersDir, "old.json"))).toBe(false);
      expect(existsSync(join(testMarkersDir, "new.json"))).toBe(true);
    });

    it("keeps same-PID markers with different session_ids when each session is live", () => {
      writeMarker(
        "alpha",
        makeMarker({
          pid: 500,
          session_id: "alpha",
          agent_type: "opencode",
          tty: undefined,
        }),
      );
      writeMarker(
        "beta",
        makeMarker({
          pid: 500,
          session_id: "beta",
          agent_type: "opencode",
          tty: undefined,
        }),
      );

      const cleaned = cleanup(new Set([500]), undefined, () => true);
      expect(cleaned).toBe(0);
      expect(existsSync(join(testMarkersDir, "alpha.json"))).toBe(true);
      expect(existsSync(join(testMarkersDir, "beta.json"))).toBe(true);
    });

    it("collapses same (agent_type, session_id) duplicates to the newest", () => {
      const now = Math.floor(Date.now() / 1000);
      writeMarker(
        "dup-old",
        makeMarker({
          pid: 100,
          session_id: "same-sid",
          timestamp: now - 10,
        }),
      );
      writeMarker(
        "dup-new",
        makeMarker({
          pid: 100,
          session_id: "same-sid",
          timestamp: now,
        }),
      );

      const cleaned = cleanup(new Set([100]), undefined, claudeLivenessCheck);
      expect(cleaned).toBe(1);
      expect(existsSync(join(testMarkersDir, "dup-old.json"))).toBe(false);
      expect(existsSync(join(testMarkersDir, "dup-new.json"))).toBe(true);
    });

    it("deletes markers with TTY mismatch when activeTtys provided", () => {
      writeMarker(
        "s1",
        makeMarker({
          pid: 100,
          session_id: "s1",
          tty: "/dev/ttys001",
        }),
      );

      const activeTtys = new Map([[100, "/dev/ttys999"]]);
      const cleaned = cleanup(new Set([100]), activeTtys, claudeLivenessCheck);
      expect(cleaned).toBe(1);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(false);
    });

    it("keeps markers when TTY matches", () => {
      writeMarker(
        "s1",
        makeMarker({
          pid: 100,
          session_id: "s1",
          tty: "/dev/ttys001",
        }),
      );

      const activeTtys = new Map([[100, "/dev/ttys001"]]);
      const cleaned = cleanup(new Set([100]), activeTtys, claudeLivenessCheck);
      expect(cleaned).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);
    });

    it("keeps a live marker when TTYs match only after normalization", () => {
      // Marker recorded the `/dev/`-prefixed form; the process snapshot is
      // normalized (`ttysNNN`). These name the SAME tty, so the authoritative
      // marker must survive — comparing raw strings would wrongly delete it.
      writeMarker(
        "s1",
        makeMarker({
          pid: 100,
          session_id: "s1",
          tty: "/dev/ttys042",
        }),
      );

      const activeTtys = new Map([[100, "ttys042"]]);
      const cleaned = cleanup(new Set([100]), activeTtys, claudeLivenessCheck);
      expect(cleaned).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);
    });

    it("skips TTY check when activeTtys not provided", () => {
      writeMarker(
        "s1",
        makeMarker({
          pid: 100,
          session_id: "s1",
          tty: "/dev/ttys001",
        }),
      );

      const cleaned = cleanup(new Set([100]), undefined, claudeLivenessCheck);
      expect(cleaned).toBe(0);
    });

    it("skips TTY check when marker tty is unknown", () => {
      writeMarker(
        "s1",
        makeMarker({
          pid: 100,
          session_id: "s1",
          tty: "unknown",
        }),
      );

      const activeTtys = new Map([[100, "/dev/ttys999"]]);
      const cleaned = cleanup(new Set([100]), activeTtys, claudeLivenessCheck);
      expect(cleaned).toBe(0);
    });

    it("keeps markers for fresh Claude sessions before the first JSONL is written", () => {
      writeMarker("s1", makeMarker({ pid: 100, session_id: "s1" }));

      const cleaned = cleanup(new Set([100]), undefined, claudeLivenessCheck);
      expect(cleaned).toBe(0);
      expect(existsSync(join(testMarkersDir, "s1.json"))).toBe(true);
    });

    it("deletes malformed marker files", () => {
      writeRawFile("bad.json", "not json");

      const cleaned = cleanup(new Set(), undefined, claudeLivenessCheck);
      expect(cleaned).toBe(1);
      expect(existsSync(join(testMarkersDir, "bad.json"))).toBe(false);
    });

    it("returns total count of deleted files", () => {
      writeMarker("s1", makeMarker({ pid: 901, session_id: "s1" }));
      writeMarker("s2", makeMarker({ pid: 902, session_id: "s2" }));
      writeRawFile("bad.json", "{{{{");

      // The malformed file goes immediately; the two dead PIDs need the
      // second scan, so the count splits 1 + 2 rather than landing as 3.
      expect(cleanup(new Set([100]), undefined, claudeLivenessCheck)).toBe(1);
      expect(cleanup(new Set([100]), undefined, claudeLivenessCheck)).toBe(2);
    });

    it("calls isSessionStillLive with the full marker for each distinct session", () => {
      writeMarker(
        "claude-s1",
        makeMarker({ pid: 100, session_id: "s1", agent_type: "claude" }),
      );
      writeMarker(
        "codex-s2",
        makeMarker({ pid: 200, session_id: "s2", agent_type: "codex" }),
      );

      const seen: SessionPidMarker[] = [];
      cleanup(new Set([100, 200]), undefined, (marker) => {
        seen.push(marker);
        return true;
      });

      const agentTypes = seen.map((m) => m.agent_type).sort();
      expect(agentTypes).toEqual(["claude", "codex"]);
    });

    describe("orphaned tmp sweep", () => {
      function writeAgedTmp(filename: string, ageMs: number) {
        const path = join(testMarkersDir, filename);
        writeFileSync(path, "{}");
        const mtime = new Date(Date.now() - ageMs);
        utimesSync(path, mtime, mtime);
        return path;
      }

      it("deletes tmp files older than one hour (bare and suffixed forms)", () => {
        const bare = writeAgedTmp(
          "codex-019e7b95-f1d3.json.tmp",
          2 * 60 * 60 * 1000,
        );
        const suffixed = writeAgedTmp(
          "opencode-ses_22ef22a.json.tmp.36456.5f9a",
          30 * 24 * 60 * 60 * 1000,
        );

        const cleaned = cleanup(new Set(), undefined, claudeLivenessCheck);

        expect(cleaned).toBe(2);
        expect(existsSync(bare)).toBe(false);
        expect(existsSync(suffixed)).toBe(false);
      });

      it("keeps young tmp files (possible in-flight tmp+rename write)", () => {
        const young = writeAgedTmp("claude-fresh.json.tmp", 5 * 60 * 1000);

        cleanup(new Set(), undefined, claudeLivenessCheck);

        expect(existsSync(young)).toBe(true);
      });

      it("does not touch aged non-tmp foreign files", () => {
        const path = join(testMarkersDir, "readme.txt");
        writeFileSync(path, "not a marker");
        const mtime = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(path, mtime, mtime);

        cleanup(new Set(), undefined, claudeLivenessCheck);

        expect(existsSync(path)).toBe(true);
      });

      it("never sweeps live .json markers regardless of age", () => {
        // A marker whose FILE is old but whose pid is alive must survive —
        // the tmp sweep is name-scoped, not a general age-based reaper.
        const marker = makeMarker({ pid: 100, session_id: "aged" });
        writeMarker("claude-aged", marker);
        const path = join(testMarkersDir, "claude-aged.json");
        const mtime = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(path, mtime, mtime);

        cleanup(new Set([100]), undefined, () => true);

        expect(existsSync(path)).toBe(true);
      });
    });
  });

  describe("parseMarkerFile", () => {
    it("preserves an explicit agent_type from the body", () => {
      const marker = parseMarkerFile(
        JSON.stringify(makeMarker({ agent_type: "codex", session_id: "abc" })),
      );
      expect(marker?.agent_type).toBe("codex");
    });

    it("returns null when the body lacks agent_type", () => {
      const body = JSON.stringify({
        pid: 1,
        tty: "/dev/ttys0",
        session_id: "abc",
        timestamp: 1,
      });
      expect(parseMarkerFile(body)).toBeNull();
    });

    it("returns null when agent_type is not a string", () => {
      const body = JSON.stringify({
        pid: 1,
        tty: "/dev/ttys0",
        session_id: "abc",
        timestamp: 1,
        agent_type: 42,
      });
      expect(parseMarkerFile(body)).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      expect(parseMarkerFile("{{not json")).toBeNull();
    });
  });

  describe("getAllSessionPidMarkers", () => {
    it("reads prefixed files with agent_type from the body", () => {
      writeMarker(
        "claude-s1",
        makeMarker({ session_id: "s1", agent_type: "claude" }),
      );
      writeMarker(
        "codex-s2",
        makeMarker({ session_id: "s2", agent_type: "codex" }),
      );
      const markers = getAllSessionPidMarkers().sort((a, b) =>
        a.session_id.localeCompare(b.session_id),
      );
      expect(markers.map((m) => m.agent_type)).toEqual(["claude", "codex"]);
    });

    it("skips files whose body lacks agent_type", () => {
      writeRawFile(
        "legacy.json",
        JSON.stringify({
          pid: 1,
          tty: "/dev/ttys0",
          session_id: "legacy",
          timestamp: 1,
        }),
      );
      expect(getAllSessionPidMarkers()).toHaveLength(0);
    });
  });
});
