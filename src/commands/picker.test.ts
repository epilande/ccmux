import { describe, it, expect } from "bun:test";
import { createPickerCommand, resolvePersistent } from "./picker";
import { createProgram } from "../program";

describe("resolvePersistent", () => {
  it("defaults to false with no CLI flag and no config value", () => {
    expect(resolvePersistent(undefined, undefined)).toBe(false);
  });

  it("uses the config value when no CLI flag is passed", () => {
    expect(resolvePersistent(undefined, true)).toBe(true);
    expect(resolvePersistent(undefined, false)).toBe(false);
  });

  it("--persistent overrides an unset or false config value", () => {
    expect(resolvePersistent(true, undefined)).toBe(true);
    expect(resolvePersistent(true, false)).toBe(true);
  });

  it("--no-persistent overrides a true config value", () => {
    expect(resolvePersistent(false, true)).toBe(false);
  });
});

describe("picker command --persistent/--no-persistent flag parsing", () => {
  // Mirrors the actual Commander option declarations in createPickerCommand,
  // exercising the CLI-flag half of the precedence chain end-to-end rather
  // than just the pure resolver fold.
  const parsePersistentFlag = (args: string[]): boolean | undefined => {
    const command = createPickerCommand();
    // Avoid triggering the real async action handler during parsing.
    command.action(() => {});
    command.parse(args, { from: "user" });
    return (command.opts() as { persistent?: boolean }).persistent;
  };

  it("is undefined when neither flag is passed", () => {
    expect(parsePersistentFlag([])).toBeUndefined();
  });

  it("is true when --persistent is passed", () => {
    expect(parsePersistentFlag(["--persistent"])).toBe(true);
  });

  it("is false when --no-persistent is passed", () => {
    expect(parsePersistentFlag(["--no-persistent"])).toBe(false);
  });

  describe("end-to-end precedence: CLI flag > config > default(false)", () => {
    it("1. no CLI flag, no config -> false", () => {
      const cli = parsePersistentFlag([]);
      expect(resolvePersistent(cli, undefined)).toBe(false);
    });

    it("2. no CLI flag, config persistent:true -> true", () => {
      const cli = parsePersistentFlag([]);
      expect(resolvePersistent(cli, true)).toBe(true);
    });

    it("3. --persistent CLI flag, config false/unset -> true", () => {
      const cli = parsePersistentFlag(["--persistent"]);
      expect(resolvePersistent(cli, false)).toBe(true);
      expect(resolvePersistent(cli, undefined)).toBe(true);
    });

    it("4. --no-persistent CLI flag, config persistent:true -> false (new override case)", () => {
      const cli = parsePersistentFlag(["--no-persistent"]);
      expect(resolvePersistent(cli, true)).toBe(false);
    });
  });
});

describe("--client-tty on the bare `ccmux` command", () => {
  // The tmux binding runs `ccmux --client-tty #{client_tty}` with no
  // subcommand, so the flag has to survive commander's default-command
  // dispatch. Asserted through the root program, which is what does the
  // dispatching: parsing the picker command directly would prove nothing.
  async function parseThroughRoot(args: string[]): Promise<string | undefined> {
    const program = createProgram();
    program.exitOverride();
    const picker = program.commands.find((cmd) => cmd.name() === "picker");
    expect(picker).toBeDefined();
    picker!.exitOverride();
    let seen: string | undefined;
    picker!.action((options: { clientTty?: string }) => {
      seen = options.clientTty;
    });
    await program.parseAsync(args, { from: "user" });
    return seen;
  }

  it("reaches the picker action with the tty the binding captured", async () => {
    expect(await parseThroughRoot(["--client-tty", "/dev/ttys004"])).toBe(
      "/dev/ttys004",
    );
  });

  it("is undefined when the binding passes nothing", async () => {
    expect(await parseThroughRoot([])).toBeUndefined();
  });

  it("still reaches the action when the subcommand is spelled out", async () => {
    expect(
      await parseThroughRoot(["picker", "--client-tty", "/dev/ttys004"]),
    ).toBe("/dev/ttys004");
  });
});
