#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { createDaemonCommand } from "./commands/daemon";
import { createShowCommand } from "./commands/show";
import { createDismissCommand } from "./commands/dismiss";
import { createKillCommand } from "./commands/kill";
import { createRestartCommand } from "./commands/restart";
import { createSwitchCommand } from "./commands/switch";
import { createReviewCommand } from "./commands/review";
import { createSendCommand } from "./commands/send";
import { createScreenCommand } from "./commands/screen";
import { createStatusCommand } from "./commands/status";
import { createPickerCommand } from "./commands/picker";
import { createSetupCommand } from "./commands/setup";
import { createDebugCommand } from "./commands/debug";
import { createConfigCommand } from "./commands/config";
import { createSpawnCommand } from "./commands/spawn";
import { createInvokeCommand } from "./commands/invoke";
import { createSidebarCommand } from "./commands/sidebar";
import { createNotifyCommand } from "./commands/notify";

const program = new Command();

program
  .name("ccmux")
  .description(
    "Track all your AI coding agents (Claude Code, Codex, Cursor, ...) in tmux and jump to the one that needs you",
  )
  .version(pkg.version);

// Register commands
program.addCommand(createDaemonCommand());
program.addCommand(createShowCommand());
program.addCommand(createDismissCommand());
program.addCommand(createKillCommand());
program.addCommand(createRestartCommand());
program.addCommand(createSwitchCommand());
program.addCommand(createReviewCommand());
program.addCommand(createSendCommand());
program.addCommand(createScreenCommand());
program.addCommand(createStatusCommand());
program.addCommand(createPickerCommand(), { isDefault: true });
program.addCommand(createSetupCommand());
program.addCommand(createDebugCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSpawnCommand());
program.addCommand(createInvokeCommand());
program.addCommand(createSidebarCommand());
program.addCommand(createNotifyCommand());

program.parse();
