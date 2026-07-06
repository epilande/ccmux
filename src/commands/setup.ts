import { Command } from "commander";
import { isDaemonRunningAsync } from "../daemon";
import { createBuiltinHookAdapters } from "../daemon/adapters";
import type { HookAdapter, HookAdapterOutcome } from "../daemon/hook-adapter";
import { BUILTIN_AGENTS } from "../lib/agents";

function appendAgent(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function pickAdapters(
  adapters: HookAdapter[],
  requested: string[],
): { selected: HookAdapter[]; unknown: string[] } {
  if (!requested || requested.length === 0) {
    return { selected: adapters, unknown: [] };
  }
  const known = new Map(adapters.map((a) => [a.agentType, a]));
  const selected: HookAdapter[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const adapter = known.get(name);
    if (adapter) selected.push(adapter);
    else unknown.push(name);
  }
  return { selected, unknown };
}

async function printStatus(adapters: HookAdapter[]): Promise<void> {
  for (const adapter of adapters) {
    const installed = adapter.isInstalled();
    const state = installed ? "installed" : "not installed";
    const detail = installed ? adapter.describeInstallDetail?.() : null;
    const suffix = detail ? ` ${detail}` : "";
    console.log(`${adapter.agentType}: ${state}${suffix}`);
    const anomalies = (await adapter.describeInstallAnomalies?.()) ?? [];
    for (const line of anomalies) console.log(`  ${line}`);
  }
}

async function printDaemonRestartHint(): Promise<void> {
  if (!(await isDaemonRunningAsync())) return;
  console.log(
    "\nDaemon is already running and won't pick up hook changes until it restarts.",
  );
  console.log("Run `ccmux daemon restart` to apply.");
}

function plural(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * The binary an adapter's agent actually launches, for PATH detection.
 * Falls back to the agentType itself when no matching AgentDef exists
 * (shouldn't happen for built-in adapters, but keeps this total).
 */
export function agentExecutable(agentType: string): string {
  const def = BUILTIN_AGENTS.find((a) => a.name === agentType);
  return def?.executable ?? def?.name ?? agentType;
}

/**
 * agentTypes whose executable isn't found on PATH. Used to skip installing
 * hooks for agents the user doesn't have, unless explicitly named via
 * `--agent`.
 */
export function findMissingAgents(
  adapters: HookAdapter[],
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): Set<string> {
  const missing = new Set<string>();
  for (const adapter of adapters) {
    if (which(agentExecutable(adapter.agentType)) === null) {
      missing.add(adapter.agentType);
    }
  }
  return missing;
}

interface AdapterCommand {
  banner: string;
  run: (adapter: HookAdapter) => Promise<HookAdapterOutcome>;
  summarize: (changed: number, total: number) => string;
}

async function runAdapterCommand(
  adapters: HookAdapter[],
  command: AdapterCommand,
): Promise<void> {
  console.log(`${command.banner}\n`);
  let changed = 0;
  for (const adapter of adapters) {
    console.log(`${adapter.agentType}:`);
    // One adapter's failure must not abort the rest: a combined run
    // should still install/uninstall the agents that can succeed.
    try {
      const outcome = await command.run(adapter);
      for (const line of outcome.lines) console.log(`  ${line}`);
      if (outcome.changed) changed += 1;
    } catch (error) {
      console.log(
        `  Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    console.log();
  }
  console.log(command.summarize(changed, adapters.length));
  await printDaemonRestartHint();
}

function runInstall(
  adapters: HookAdapter[],
  skipped: Set<string>,
): Promise<void> {
  return runAdapterCommand(adapters, {
    banner: "Setting up ccmux hooks...",
    run: (adapter) => {
      if (skipped.has(adapter.agentType)) {
        return Promise.resolve({
          changed: false,
          lines: [
            `Skipped: '${agentExecutable(adapter.agentType)}' not found on PATH (use --agent ${adapter.agentType} to install anyway)`,
          ],
        });
      }
      return adapter.install();
    },
    summarize: (changed, total) => {
      const skippedCount = skipped.size;
      const attempted = total - skippedCount;
      if (skippedCount === 0) {
        if (changed === 0) {
          return `No changes (${total} ${plural("agent", total)} already set up).`;
        }
        if (changed === total) {
          return `Setup complete for ${total} ${plural("agent", total)}. Restart sessions to pick up hooks.`;
        }
        return `Setup complete: ${changed} of ${total} ${plural("agent", total)} newly configured (others already set up).`;
      }
      if (attempted === 0) {
        return "No agents set up: no supported agent executables found on PATH. Use --agent <name> to force install.";
      }
      if (changed === 0) {
        return `No changes (${attempted} ${plural("agent", attempted)} already set up, ${skippedCount} skipped: not found on PATH).`;
      }
      if (changed === attempted) {
        return `Setup complete for ${changed} ${plural("agent", changed)} (${skippedCount} skipped: not found on PATH). Restart sessions to pick up hooks.`;
      }
      return `Setup complete: ${changed} of ${attempted} ${plural("agent", attempted)} newly configured (${skippedCount} skipped: not found on PATH).`;
    },
  });
}

function runUninstall(adapters: HookAdapter[]): Promise<void> {
  return runAdapterCommand(adapters, {
    banner: "Removing ccmux hooks...",
    run: (adapter) => adapter.uninstall(),
    summarize: (changed, total) => {
      if (changed === 0) return "No changes made (see messages above).";
      if (changed === total) return "Hooks fully removed.";
      return `Removed hooks for ${changed} of ${total} ${plural("agent", total)} (see messages above for skipped).`;
    },
  });
}

export function createSetupCommand(): Command {
  return new Command("setup")
    .description("Install or remove ccmux hooks for supported agents")
    .option("--uninstall", "Remove hooks and clean agent settings")
    .option(
      "--agent <name>",
      "Limit to a specific agent (repeatable; forces install even if the agent is not on PATH)",
      appendAgent,
      [] as string[],
    )
    .option("--status", "Report install state without writing anything")
    .action(async (options) => {
      const registered = createBuiltinHookAdapters();
      const { selected, unknown } = pickAdapters(
        registered,
        options.agent ?? [],
      );

      if (unknown.length > 0) {
        const available = registered.map((a) => a.agentType).join(", ");
        console.error(
          `Unknown agent(s): ${unknown.join(", ")}. Available: ${available}`,
        );
        process.exit(1);
      }

      if (selected.length === 0) {
        console.error("No matching agent adapters.");
        process.exit(1);
      }

      if (options.status) {
        await printStatus(selected);
        return;
      }

      if (options.uninstall) {
        await runUninstall(selected);
      } else {
        const explicit = (options.agent ?? []).length > 0;
        const missing = explicit
          ? new Set<string>()
          : findMissingAgents(selected);
        await runInstall(selected, missing);
      }
    });
}
