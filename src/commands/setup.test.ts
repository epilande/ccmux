import { describe, it, expect } from "bun:test";
import { findMissingAgents } from "./setup";
import { getAgentExecutable } from "../lib/agents";
import type { HookAdapter } from "../daemon/hook-adapter";

function fakeAdapters(...agentTypes: string[]): HookAdapter[] {
  return agentTypes.map((agentType) => ({ agentType }) as HookAdapter);
}

describe("getAgentExecutable", () => {
  it("returns cursor-agent for cursor (interactive binary differs from agent name)", () => {
    expect(getAgentExecutable("cursor")).toBe("cursor-agent");
  });

  it("returns the agent name itself when no executable override is set", () => {
    expect(getAgentExecutable("claude")).toBe("claude");
  });

  it("falls back to the agentType itself when no matching AgentDef exists", () => {
    expect(getAgentExecutable("not-a-real-agent")).toBe("not-a-real-agent");
  });
});

describe("findMissingAgents", () => {
  it("returns exactly the agentTypes whose executable resolves to null", () => {
    const adapters = fakeAdapters("claude", "codex", "cursor");
    const present = new Set(["claude", "cursor-agent"]);
    const which = (cmd: string): string | null =>
      present.has(cmd) ? `/usr/local/bin/${cmd}` : null;

    expect(findMissingAgents(adapters, which)).toEqual(new Set(["codex"]));
  });

  it("returns an empty set when all agent executables are present", () => {
    const which = (cmd: string): string | null => `/usr/local/bin/${cmd}`;

    expect(findMissingAgents(fakeAdapters("claude", "cursor"), which)).toEqual(
      new Set(),
    );
  });

  it("returns every agentType when no executables are present", () => {
    const which = (_cmd: string): string | null => null;

    expect(findMissingAgents(fakeAdapters("claude", "cursor"), which)).toEqual(
      new Set(["claude", "cursor"]),
    );
  });
});
