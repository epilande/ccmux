import { describe, expect, test } from "bun:test";
import { BUILTIN_AGENTS, getAgents, type AgentDef } from "./agents";
import { listSpawnableAgents, spawnBinaryFor } from "./spawnable-agents";

const byName = (name: string): AgentDef =>
  BUILTIN_AGENTS.find((agent) => agent.name === name)!;

/** Resolve nothing: the machine has no agents at all. */
const whichNone = () => null;
/** Resolve everything: the machine has every agent installed. */
const whichAll = (cmd: string) => `/usr/local/bin/${cmd}`;
/** Resolve only the named binaries. */
const whichOnly =
  (...binaries: string[]) =>
  (cmd: string) =>
    binaries.includes(cmd) ? `/usr/local/bin/${cmd}` : null;

describe("spawnBinaryFor", () => {
  test("claude honors the command preference", () => {
    expect(spawnBinaryFor(byName("claude"), "/opt/wrap/claude")).toBe(
      "/opt/wrap/claude",
    );
    expect(spawnBinaryFor(byName("claude"))).toBe("claude");
  });

  test("other agents use their executable override, else their name", () => {
    expect(spawnBinaryFor(byName("cursor"), "/opt/wrap/claude")).toBe(
      "cursor-agent",
    );
    expect(spawnBinaryFor(byName("codex"))).toBe("codex");
  });
});

describe("listSpawnableAgents", () => {
  test("keeps only built-ins found on PATH, in catalogue order", () => {
    const result = listSpawnableAgents(BUILTIN_AGENTS, {
      which: whichOnly("codex", "claude"),
    });
    expect(result.map((a) => a.name)).toEqual(["claude", "codex"]);
  });

  test("resolves cursor through its executable, not its agent name", () => {
    expect(
      listSpawnableAgents(BUILTIN_AGENTS, { which: whichOnly("cursor") }),
    ).toEqual([]);
    expect(
      listSpawnableAgents(BUILTIN_AGENTS, {
        which: whichOnly("cursor-agent"),
      }).map((a) => a.name),
    ).toEqual(["cursor"]);
  });

  test("a claude command preference keeps claude listed off PATH", () => {
    const result = listSpawnableAgents(BUILTIN_AGENTS, {
      claudeCommand: "/opt/wrap/claude",
      which: whichOnly("/opt/wrap/claude"),
    });
    expect(result.map((a) => a.name)).toEqual(["claude"]);
  });

  test("a declared claude command is listed even when which cannot resolve it", () => {
    // `command` is documented as possibly being an alias, a `~` path, or
    // `$HOME/...`. Bun.which resolves none of those, but the command is
    // typed into an interactive shell, where it does resolve.
    for (const command of ["c", "~/.local/bin/claude", "$HOME/bin/claude"]) {
      const result = listSpawnableAgents(BUILTIN_AGENTS, {
        claudeCommand: command,
        which: whichNone,
      });
      expect(result.map((a) => a.name)).toEqual(["claude"]);
    }
  });

  test("claude stays PATH-gated when no command is declared", () => {
    expect(listSpawnableAgents(BUILTIN_AGENTS, { which: whichNone })).toEqual(
      [],
    );
  });

  test("reports display name, short code, and prompt support", () => {
    const result = listSpawnableAgents(BUILTIN_AGENTS, { which: whichAll });
    const claude = result.find((a) => a.name === "claude")!;
    // No `displayName` on the def, so the name is title-cased.
    expect(claude.displayName).toBe("Claude");
    expect(claude.shortCode).toBe(byName("claude").shortCode);
    expect(claude.supportsPrompt).toBe(true);
    // A def that does carry one keeps its own casing.
    expect(result.find((a) => a.name === "opencode")!.displayName).toBe(
      "OpenCode",
    );
  });

  test("an agent without a promptCommand reports supportsPrompt false", () => {
    const noPrompt: AgentDef = { ...byName("codex"), promptCommand: undefined };
    const [entry] = listSpawnableAgents([noPrompt], { which: whichAll });
    expect(entry!.supportsPrompt).toBe(false);
  });

  test("custom agents are listed even when their binary is not resolvable", () => {
    const agents = getAgents({
      agents: {
        mine: { processMatch: "mine", executable: "my-wrapper-function" },
      },
    });
    const result = listSpawnableAgents(agents, { which: whichNone });
    expect(result.map((a) => a.name)).toEqual(["mine"]);
    expect(result[0]!.displayName).toBe("Mine");
  });

  test("a built-in with an overridden executable is listed off PATH", () => {
    // Same argument as a custom agent's, and as claude's `command`: the user
    // declared this binary by hand, and `POST /spawn` types it into a shell
    // where a `~` path, a wrapper, or a shell function resolves. `Bun.which`
    // resolves none of those, so gating on it hides a working agent.
    for (const executable of [
      "~/bin/codex-wrapper",
      "/opt/wrap/codex",
      "codex-nightly",
    ]) {
      const agents = getAgents({ agents: { codex: { executable } } });
      const result = listSpawnableAgents(agents, { which: whichNone });
      // Exactly codex: every other built-in is untouched, so it stays gated
      // and drops out on a machine where nothing resolves.
      expect(result.map((a) => a.name)).toEqual(["codex"]);
    }
  });

  test("an overridden built-in that does resolve is still listed once", () => {
    const agents = getAgents({
      agents: { codex: { executable: "codex-nightly" } },
    });
    expect(
      listSpawnableAgents(agents, { which: whichOnly("codex-nightly") }).map(
        (a) => a.name,
      ),
    ).toEqual(["codex"]);
  });

  test("an executable that matches the built-in default stays PATH-gated", () => {
    // Declaring what was already true declares nothing: this is still the
    // catalogue entry, and a menu entry that fails on Enter is worse than a
    // short menu.
    const agents = getAgents({
      agents: { cursor: { executable: "cursor-agent" } },
    });
    expect(listSpawnableAgents(agents, { which: whichNone })).toEqual([]);
  });

  test("returns an empty list when nothing is installed", () => {
    expect(listSpawnableAgents(BUILTIN_AGENTS, { which: whichNone })).toEqual(
      [],
    );
  });
});
