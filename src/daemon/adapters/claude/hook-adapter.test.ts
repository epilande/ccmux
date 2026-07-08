import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-claude-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const claudeDir = join(tempRoot, ".claude");
const hooksDir = join(claudeDir, "hooks");
const projectsDir = join(claudeDir, "projects");
const settingsFile = join(claudeDir, "settings.json");
const markersDir = join(tempRoot, "markers");

// A second configured Claude config dir (e.g. ~/.claude-personal), used by the
// fan-out tests. `mockedConfigDirs` is what the adapter sees; tests mutate it
// and beforeEach resets it to just the primary dir.
const claudeDir2 = join(tempRoot, ".claude-personal");
const settingsFile2 = join(claudeDir2, "settings.json");
let mockedConfigDirs = [claudeDir];

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  CLAUDE_DIR: claudeDir,
  CLAUDE_HOOKS_DIR: hooksDir,
  PROJECTS_DIR: projectsDir,
  SETTINGS_FILE: settingsFile,
  MARKERS_DIR: markersDir,
  // The adapter resolves its target dirs through these helpers, whose real
  // implementations close over the real CLAUDE_DIR (unaffected by the
  // constant overrides above). Pin them to temp dirs so install/uninstall
  // never touch the real ~/.claude (or configured extra dirs).
  resolveClaudeConfigDirs: () => mockedConfigDirs,
  resolveClaudeProjectDirs: () =>
    mockedConfigDirs.map((d) => join(d, "projects")),
}));

import { ClaudeHookAdapter } from "./hook-adapter";

function writeSettings(content: object) {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(content, null, 2) + "\n");
}

describe("ClaudeHookAdapter", () => {
  let adapter: ClaudeHookAdapter;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    mockedConfigDirs = [claudeDir];
    adapter = new ClaudeHookAdapter();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("uninstall markers cleanup", () => {
    it("removes only claude-* markers and preserves markers owned by other agents", async () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear",
              hooks: [
                {
                  type: "command",
                  command: join(hooksDir, "ccmux-session-start.sh"),
                },
              ],
            },
          ],
        },
      });

      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "claude-session-a.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "claude-session-b.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "codex-session-c.json"),
        '{"agent_type":"codex"}',
      );
      writeFileSync(
        join(markersDir, "opencode-session-d.json"),
        '{"agent_type":"opencode"}',
      );

      await adapter.uninstall();

      expect(existsSync(markersDir)).toBe(true);
      const remaining = readdirSync(markersDir).sort();
      expect(remaining).toEqual([
        "codex-session-c.json",
        "opencode-session-d.json",
      ]);
    });

    it("reports how many claude markers it removed", async () => {
      writeSettings({ hooks: {} });
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "claude-x.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(
        join(markersDir, "claude-y.json"),
        '{"agent_type":"claude"}',
      );
      writeFileSync(join(markersDir, "codex-z.json"), '{"agent_type":"codex"}');

      const { lines } = await adapter.uninstall();
      const reportLine = lines.find((l) => l.includes("claude marker"));
      expect(reportLine).toBeTruthy();
      expect(reportLine).toContain("2");
    });

    it("leaves the markers dir alone when no claude markers are present", async () => {
      writeSettings({ hooks: {} });
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(
        join(markersDir, "codex-only.json"),
        '{"agent_type":"codex"}',
      );

      const { lines } = await adapter.uninstall();
      expect(lines.some((l) => l.includes("claude marker"))).toBe(false);
      expect(
        readFileSync(join(markersDir, "codex-only.json"), "utf-8"),
      ).toContain("codex");
    });
  });

  describe("changed flag accuracy", () => {
    it("uninstall reports changed=false when settings.json has no ccmux-owned hooks", async () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "/usr/local/bin/my-own-hook.sh" },
              ],
            },
          ],
        },
      });

      const { changed, lines } = await adapter.uninstall();

      expect(changed).toBe(false);
      expect(lines.some((l) => l.includes("Removed hooks from"))).toBe(false);
      const after = JSON.parse(readFileSync(settingsFile, "utf-8"));
      expect(after.hooks.SessionStart).toHaveLength(1);
    });

    it("install reports changed=false on idempotent re-run", async () => {
      const first = await adapter.install();
      expect(first.changed).toBe(true);

      const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionEnd).toBeDefined();
      expect(settings.hooks.Notification).toBeDefined();

      const second = await adapter.install();
      expect(second.changed).toBe(false);
      expect(second.lines.some((l) => l.includes("already up to date"))).toBe(
        true,
      );
      expect(second.lines.some((l) => l.includes("already installed in"))).toBe(
        true,
      );
    });
  });

  describe("isInstalled", () => {
    it("returns false when settings.json is absent", () => {
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns false when settings.json has only user-owned hooks", () => {
      writeSettings({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: "/Users/me/my-own-session-start.sh",
                },
              ],
            },
          ],
        },
      });
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns true after install()", async () => {
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
    });

    it("returns false on malformed settings.json", () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsFile, "{ not valid json");
      expect(adapter.isInstalled()).toBe(false);
    });
  });

  describe("multiple config dirs", () => {
    function ccmuxInstalledIn(file: string): boolean {
      if (!existsSync(file)) return false;
      const settings = JSON.parse(readFileSync(file, "utf-8"));
      const start = settings?.hooks?.SessionStart ?? [];
      return start.some((g: { hooks?: { command?: string }[] }) =>
        g.hooks?.some((h) => h.command?.includes("ccmux-session-start.sh")),
      );
    }

    it("install fans out hooks to every configured config dir", async () => {
      mockedConfigDirs = [claudeDir, claudeDir2];
      await adapter.install();
      expect(ccmuxInstalledIn(settingsFile)).toBe(true);
      expect(ccmuxInstalledIn(settingsFile2)).toBe(true);
      expect(
        existsSync(join(claudeDir2, "hooks", "ccmux-session-start.sh")),
      ).toBe(true);
    });

    it("uninstall removes hooks from every configured config dir", async () => {
      mockedConfigDirs = [claudeDir, claudeDir2];
      await adapter.install();
      await adapter.uninstall();
      expect(ccmuxInstalledIn(settingsFile)).toBe(false);
      expect(ccmuxInstalledIn(settingsFile2)).toBe(false);
    });

    it("isInstalled tracks only the primary dir; extras surface as anomalies", async () => {
      // Only the primary dir has hooks installed.
      mockedConfigDirs = [claudeDir];
      await adapter.install();
      // Now a second dir is configured but not yet set up.
      mockedConfigDirs = [claudeDir, claudeDir2];
      expect(adapter.isInstalled()).toBe(true);
      const anomalies = adapter.describeInstallAnomalies?.() ?? [];
      expect(anomalies.length).toBe(1);
      expect(anomalies[0]).toContain(claudeDir2);
    });
  });

  describe("uninstall preserves user-owned hooks", () => {
    it("removes ccmux entries but leaves user-authored entries in the same slot", async () => {
      await adapter.install();
      const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      settings.hooks.SessionStart.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "/Users/me/my-own-session-start.sh",
          },
        ],
      });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

      await adapter.uninstall();

      const after = JSON.parse(readFileSync(settingsFile, "utf-8"));
      const commands = (
        (after.hooks?.SessionStart ?? []) as Array<{
          hooks?: Array<{ command?: string }>;
        }>
      ).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));
      expect(commands).toContain("/Users/me/my-own-session-start.sh");
      expect(commands.some((c) => c.includes("ccmux-session-start.sh"))).toBe(
        false,
      );
    });
  });
});
