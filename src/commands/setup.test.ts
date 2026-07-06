import { describe, it, expect } from "bun:test";
import { agentExecutable, findMissingAgents } from "./setup";
import { createBuiltinHookAdapters } from "../daemon/adapters";
import type { HookAdapter } from "../daemon/hook-adapter";

describe("agentExecutable", () => {
  it("returns cursor-agent for cursor (interactive binary differs from agent name)", () => {
    expect(agentExecutable("cursor")).toBe("cursor-agent");
  });

  it("returns the agent name itself when no executable override is set", () => {
    expect(agentExecutable("claude")).toBe("claude");
  });

  it("falls back to the agentType itself when no matching AgentDef exists", () => {
    expect(agentExecutable("not-a-real-agent")).toBe("not-a-real-agent");
  });
});

describe("findMissingAgents", () => {
  it("returns exactly the agentTypes whose executable resolves to null", () => {
    const adapters = createBuiltinHookAdapters();
    const present = new Set(["claude", "codex"]);
    const which = (cmd: string): string | null =>
      present.has(cmd) ? `/usr/local/bin/${cmd}` : null;

    const missing = findMissingAgents(adapters, which);
    const expectedMissing = new Set(
      adapters
        .filter((a) => !present.has(agentExecutable(a.agentType)))
        .map((a) => a.agentType),
    );
    expect(missing).toEqual(expectedMissing);
  });

  it("returns an empty set when all agent executables are present", () => {
    const adapters: HookAdapter[] = [
      { agentType: "claude" } as HookAdapter,
      { agentType: "cursor" } as HookAdapter,
    ];
    const which = (cmd: string): string | null => `/usr/local/bin/${cmd}`;

    expect(findMissingAgents(adapters, which)).toEqual(new Set());
  });

  it("returns every agentType when no executables are present", () => {
    const adapters: HookAdapter[] = [
      { agentType: "claude" } as HookAdapter,
      { agentType: "cursor" } as HookAdapter,
    ];
    const which = (_cmd: string): string | null => null;

    expect(findMissingAgents(adapters, which)).toEqual(
      new Set(["claude", "cursor"]),
    );
  });
});
