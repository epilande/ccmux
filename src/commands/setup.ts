import { Command } from "commander";
import { isDaemonRunningAsync } from "../daemon";
import { createBuiltinHookAdapters } from "../daemon/adapters";
import type { HookAdapter, HookAdapterOutcome } from "../daemon/hook-adapter";
import { getAgentExecutable } from "../lib/agents";

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
 * agentTypes whose executable isn't found on PATH. Used to skip installing
 * hooks for agents the user doesn't have, unless explicitly named via
 * `--agent`.
 */
export function findMissingAgents(
  adapters: HookAdapter[],
  which: (cmd: string) => string | null = Bun.which,
): Set<string> {
  const missing = new Set<string>();
  for (const adapter of adapters) {
    if (which(getAgentExecutable(adapter.agentType)) === null) {
      missing.add(adapter.agentType);
    }
  }
  return missing;
}

interface AdapterCommand {
  banner: string;
  run: (adapter: HookAdapter) => Promise<HookAdapterOutcome>;
  summarize: (changed: number, skipped: number, total: number) => string;
}

async function runAdapterCommand(
  adapters: HookAdapter[],
  command: AdapterCommand,
): Promise<void> {
  console.log(`${command.banner}\n`);
  let changed = 0;
  let skipped = 0;
  for (const adapter of adapters) {
    console.log(`${adapter.agentType}:`);
    // One adapter's failure must not abort the rest: a combined run
    // should still install/uninstall the agents that can succeed.
    try {
      const outcome = await command.run(adapter);
      for (const line of outcome.lines) console.log(`  ${line}`);
      if (outcome.changed) changed += 1;
      if (outcome.skipped) skipped += 1;
    } catch (error) {
      console.log(
        `  Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    console.log();
  }
  console.log(command.summarize(changed, skipped, adapters.length));
  await printDaemonRestartHint();
}

function runInstall(adapters: HookAdapter[], skip: Set<string>): Promise<void> {
  return runAdapterCommand(adapters, {
    banner: "Setting up ccmux hooks...",
    run: (adapter) => {
      if (skip.has(adapter.agentType)) {
        return Promise.resolve({
          changed: false,
          skipped: true,
          lines: [
            `Skipped: '${getAgentExecutable(adapter.agentType)}' not found on PATH (use --agent ${adapter.agentType} to install anyway)`,
          ],
        });
      }
      return adapter.install();
    },
    summarize: (changed, skipped, total) => {
      const attempted = total - skipped;
      const skipNote =
        skipped > 0 ? ` (${skipped} skipped: not found on PATH)` : "";
      if (attempted === 0) {
        return "No agents set up: no supported agent executables found on PATH. Use --agent <name> to force install.";
      }
      if (changed === 0) {
        const skipDetail =
          skipped > 0 ? `, ${skipped} skipped: not found on PATH` : "";
        return `No changes (${attempted} ${plural("agent", attempted)} already set up${skipDetail}).`;
      }
      if (changed === attempted) {
        return `Setup complete for ${changed} ${plural("agent", changed)}${skipNote}. Restart sessions to pick up hooks.`;
      }
      return `Setup complete: ${changed} of ${attempted} ${plural("agent", attempted)} newly configured${
        skipped > 0 ? skipNote : " (others already set up)"
      }.`;
    },
  });
}

function runUninstall(adapters: HookAdapter[]): Promise<void> {
  return runAdapterCommand(adapters, {
    banner: "Removing ccmux hooks...",
    run: (adapter) => adapter.uninstall(),
    summarize: (changed, _skipped, total) => {
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
