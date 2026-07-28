import type { AgentDef } from "../lib/agents";
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type CommandRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

interface VersionResolverOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  runCommand?: CommandRunner;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_VERSION_PATTERNS = [
  /\bv?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)\b/i,
];

function regexTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function executableName(token: string): string {
  return token.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

function findFirstNonOption(tokens: string[], start: number): string | null {
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (!token || token === "--") continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function findNpmExecTarget(tokens: string[], start: number): string | null {
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (!token) continue;
    if (token === "--") {
      return findFirstNonOption(tokens, idx + 1);
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function parseShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of command.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function getCommandPathCandidates(tokens: string[]): string[] {
  if (tokens.length === 0) return [];

  const candidates: string[] = [];
  const executable = executableName(tokens[0]);

  if (tokens[0].includes("/") && executable !== "node") {
    candidates.push(tokens[0]);
  }

  if (executable === "node" && tokens[1] && tokens[1].includes("/")) {
    candidates.push(tokens[1]);
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (!token) continue;
    if (idx === 0 && executable === "node") continue;
    if (token.includes("/")) {
      candidates.push(token);
    }
  }

  return uniqueStrings(candidates);
}

function probeFromProcess(
  processCommand: string,
  agent: AgentDef,
): string[] | null {
  const tokens = parseShellTokens(processCommand);
  if (tokens.length === 0) return null;

  const executable = executableName(tokens[0]);

  if (executable === "npx") {
    const target = findFirstNonOption(tokens, 1);
    if (target) {
      return [tokens[0], target, "--version"];
    }
  }

  if (executable === "npm") {
    const execIndex = tokens.findIndex(
      (token, idx) => idx > 0 && token.toLowerCase() === "exec",
    );
    if (execIndex !== -1) {
      const target = findNpmExecTarget(tokens, execIndex + 1);
      if (target) {
        return [tokens[0], "exec", target, "--", "--version"];
      }
    }
  }

  if (executable === "node" && tokens[1]) {
    const scriptToken = tokens[1];
    const scriptName = executableName(scriptToken);
    if (regexTest(agent.processMatch, scriptName)) {
      return [tokens[0], scriptToken, "--version"];
    }
  }

  if (regexTest(agent.processMatch, executable)) {
    return [tokens[0], "--version"];
  }

  return null;
}

export function buildVersionProbeCommand(
  processCommand: string,
  agent: AgentDef,
): string[] | null {
  const processProbe = probeFromProcess(processCommand, agent);
  if (processProbe) {
    return processProbe;
  }

  if (!agent.versionCommand) {
    return null;
  }

  const fallback = parseShellTokens(agent.versionCommand);
  return fallback.length > 0 ? fallback : null;
}

function normalizeVersion(version: string): string | null {
  const normalized = version.trim().replace(/^v/i, "");
  return normalized.length > 0 ? normalized : null;
}

function inferVersionFromPath(
  pathValue: string,
  agent: AgentDef,
): string | null {
  const cellarMatch = pathValue.match(
    /\/Cellar\/([^/]+)\/(v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.-]+)?)\//i,
  );
  if (cellarMatch?.[1] && cellarMatch?.[2]) {
    const formula = cellarMatch[1].toLowerCase();
    const agentName = agent.name.toLowerCase();
    const aliases =
      agentName === "gemini" ? ["gemini", "gemini-cli"] : [agentName];
    if (aliases.some((alias) => formula.includes(alias))) {
      return normalizeVersion(cellarMatch[2]);
    }
  }
  return null;
}

function inferVersionFromPackageJson(
  pathValue: string,
  agent: AgentDef,
): string | null {
  let dir = dirname(pathValue);

  for (let depth = 0; depth < 7; depth += 1) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        const version =
          typeof parsed.version === "string"
            ? normalizeVersion(parsed.version)
            : null;
        const name =
          typeof parsed.name === "string" ? parsed.name.toLowerCase() : "";

        if (!version) {
          // Keep walking up - wrapper package may not be the CLI package.
        } else if (name.includes(agent.name.toLowerCase())) {
          return version;
        } else if (agent.name === "gemini" && name === "@google/gemini-cli") {
          return version;
        } else if (agent.name === "codex" && name === "@openai/codex") {
          return version;
        } else if (
          agent.name === "omp" &&
          name === "@oh-my-pi/pi-coding-agent"
        ) {
          // oh-my-pi ships as `@oh-my-pi/pi-coding-agent`, which contains
          // "pi" but not "omp", so the generic `name.includes(agent.name)`
          // check above never fires for it.
          return version;
        }
      } catch {
        // Ignore malformed package.json and keep searching.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function inferVersionFromProcessCommand(
  processCommand: string,
  agent: AgentDef,
): string | null {
  const tokens = parseShellTokens(processCommand);
  if (tokens.length === 0) return null;

  const pathCandidates = getCommandPathCandidates(tokens);
  for (const pathCandidate of pathCandidates) {
    const variants = [pathCandidate];
    if (existsSync(pathCandidate)) {
      try {
        variants.push(realpathSync(pathCandidate));
      } catch {
        // Keep using unresolved path only.
      }
    }

    for (const variant of uniqueStrings(variants)) {
      const fromPath = inferVersionFromPath(variant, agent);
      if (fromPath) {
        return fromPath;
      }

      if (existsSync(variant)) {
        const fromPackage = inferVersionFromPackageJson(variant, agent);
        if (fromPackage) {
          return fromPackage;
        }
      }
    }
  }

  return null;
}

export function extractVersionFromOutput(
  output: string,
  patterns: RegExp[] = DEFAULT_VERSION_PATTERNS,
): string | null {
  const text = output.trim();
  if (!text) return null;

  for (const pattern of patterns) {
    const safePattern = new RegExp(
      pattern.source,
      pattern.flags.replace(/g/g, ""),
    );
    const match = safePattern.exec(text);
    if (!match) continue;
    if (match[1]) {
      return normalizeVersion(match[1]);
    }
    if (match[0]) {
      return normalizeVersion(match[0]);
    }
  }

  for (const pattern of DEFAULT_VERSION_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return normalizeVersion(match[1]);
    }
  }

  return null;
}

async function runCommandWithTimeout(
  argv: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timeout);
    return {
      stdout,
      stderr,
      exitCode: timedOut ? 124 : exitCode,
    };
  } catch {
    return { stdout: "", stderr: "", exitCode: -1 };
  }
}

export class VersionResolver {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly runCommand: CommandRunner;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(options: VersionResolverOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? runCommandWithTimeout;
  }

  async resolve(
    agent: AgentDef,
    processCommand: string,
  ): Promise<string | null> {
    const probe = buildVersionProbeCommand(processCommand, agent);
    if (!probe) {
      return null;
    }

    const cacheKey = `${agent.name}\0${probe.join("\0")}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = this.inflight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const pending = this.resolveAndCache(
      cacheKey,
      probe,
      processCommand,
      agent,
      agent.versionPatterns,
    );
    this.inflight.set(cacheKey, pending);
    return pending;
  }

  private async resolveAndCache(
    cacheKey: string,
    probe: string[],
    processCommand: string,
    agent: AgentDef,
    patterns?: RegExp[],
  ): Promise<string | null> {
    let value = inferVersionFromProcessCommand(processCommand, agent);

    try {
      if (!value) {
        const result = await this.runCommand(probe, this.timeoutMs);
        const output = `${result.stdout}\n${result.stderr}`;
        value = extractVersionFromOutput(output, patterns);
      }
    } catch {
      value = null;
    } finally {
      this.cache.set(cacheKey, {
        value,
        expiresAt: this.now() + this.ttlMs,
      });
      this.inflight.delete(cacheKey);
    }

    return value;
  }
}
