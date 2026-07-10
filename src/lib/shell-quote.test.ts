import { describe, it, expect } from "bun:test";
import { shellQuote } from "./shell-quote";

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes an embedded single quote with the '\\'' pattern", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("neutralizes shell metacharacters (never expanded once quoted)", () => {
    const malicious = "$(rm -rf ~); echo pwned";
    expect(shellQuote(malicious)).toBe(`'${malicious}'`);
  });

  it("round-trips through a second application (nested quoting), verified by a real shell", async () => {
    // Simulates building an inner `sh -c` command from already-quoted tokens,
    // then quoting the whole thing again for an outer `/bin/sh -c` (the
    // notifier's executeCommand shape). Rather than asserting the exact
    // escaped string, prove it end to end: feed it to a real shell and check
    // the session id with an embedded quote survives untouched.
    const sessionId = "abc's-id";
    const inner = `echo ${shellQuote(sessionId)}`;
    const outer = `/bin/sh -c ${shellQuote(inner)}`;

    const proc = Bun.spawn(["/bin/sh", "-c", outer], { stdout: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(output).toBe(sessionId);
  });
});
