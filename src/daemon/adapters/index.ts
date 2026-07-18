import { AntigravityHookAdapter } from "./antigravity/hook-adapter";
import { ClaudeHookAdapter } from "./claude/hook-adapter";
import { CodexHookAdapter } from "./codex/hook-adapter";
import { CopilotHookAdapter } from "./copilot/hook-adapter";
import { CursorHookAdapter } from "./cursor/hook-adapter";
import { OpenCodePluginAdapter } from "./opencode/plugin-adapter";
import { PiHookAdapter } from "./pi/hook-adapter";
import type { HookAdapter } from "../hook-adapter";

/**
 * Single source of truth for ccmux's built-in hook adapters.
 *
 * Both the daemon (registers with `HookManager`) and `ccmux setup`
 * (dispatches install/uninstall/--status/--agent) must go through this
 * factory. Before it existed the two sites maintained independent
 * hardcoded lists, so a new adapter added in one place was silently
 * invisible to the other.
 */
export function createBuiltinHookAdapters(): HookAdapter[] {
  return [
    new ClaudeHookAdapter(),
    new CodexHookAdapter(),
    new OpenCodePluginAdapter(),
    new CursorHookAdapter(),
    new PiHookAdapter(),
    new AntigravityHookAdapter(),
    new CopilotHookAdapter(),
  ];
}
