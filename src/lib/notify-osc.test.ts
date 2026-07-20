import { describe, it, expect } from "bun:test";
import {
  stripControlBytes,
  buildOsc9Sequence,
  buildOsc99Sequence,
  wrapTmuxPassthrough,
  isKittyTermnames,
  buildPassthroughSequence,
  probeAllowPassthrough,
  deliverOscNotification,
} from "./notify-osc";
import type { NotificationPayload } from "./notify";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

const BASE_PAYLOAD: NotificationPayload = {
  title: "ccmux (main) · Claude Code",
  subtitle: "Needs permission: Bash",
  body: "rm -rf build",
  event: "waiting",
  sessionId: "abc123",
  agent: "Claude Code",
  project: "ccmux",
  pane: "%5",
};

function decodeB64(text: string): string {
  return Buffer.from(text, "base64").toString("utf8");
}

describe("stripControlBytes", () => {
  it("removes C0 controls, DEL, and C1 controls", () => {
    expect(stripControlBytes(`a${ESC}b${BEL}c`)).toBe("abc");
    expect(stripControlBytes("a\x00\x1f\x7f\x9fb")).toBe("ab");
    // A raw ST's ESC is removed, so it can't break out of the OSC string
    // (the bare backslash left behind is harmless printable text).
    expect(stripControlBytes(`title${ST}]9;injected`)).toBe(
      "title\\]9;injected",
    );
  });

  it("preserves printable Unicode above the C1 range", () => {
    expect(stripControlBytes("café · 日本語 · ✓")).toBe("café · 日本語 · ✓");
  });
});

describe("buildOsc9Sequence", () => {
  it("builds a single `title: body` string terminated by BEL", () => {
    expect(buildOsc9Sequence("ccmux", "Finished")).toBe(
      `${ESC}]9;ccmux: Finished${BEL}`,
    );
  });

  it("omits the separator when there is no body", () => {
    expect(buildOsc9Sequence("ccmux", "")).toBe(`${ESC}]9;ccmux${BEL}`);
  });

  it("flattens embedded newlines to spaces so the sequence stays single-line", () => {
    expect(buildOsc9Sequence("ccmux", "line1\nline2")).toBe(
      `${ESC}]9;ccmux: line1 line2${BEL}`,
    );
  });

  it("strips control bytes from both title and body", () => {
    expect(buildOsc9Sequence(`c${ESC}cmux`, `bo${BEL}dy`)).toBe(
      `${ESC}]9;ccmux: body${BEL}`,
    );
  });
});

describe("buildOsc99Sequence", () => {
  it("emits base64 title and body chunks sharing a done flag order", () => {
    const seq = buildOsc99Sequence("abc123", "ccmux", "Finished");
    expect(seq).toBe(
      `${ESC}]99;i=abc123:d=0:e=1:p=title;Y2NtdXg=${ST}` +
        `${ESC}]99;i=abc123:d=1:e=1:p=body;RmluaXNoZWQ=${ST}`,
    );
    // Sanity-check the payloads decode back to the originals.
    expect(decodeB64("Y2NtdXg=")).toBe("ccmux");
    expect(decodeB64("RmluaXNoZWQ=")).toBe("Finished");
  });

  it("marks the title chunk done when there is no body", () => {
    const seq = buildOsc99Sequence("abc123", "ccmux", "");
    expect(seq).toBe(`${ESC}]99;i=abc123:d=1:e=1:p=title;Y2NtdXg=${ST}`);
  });

  it("reduces the session id to kitty's identifier charset", () => {
    const seq = buildOsc99Sequence("claude-99:xy/z", "t", "b");
    expect(seq).toContain("i=claude-99xyz:");
  });

  it("falls back to a stable identifier when the id has no usable chars", () => {
    const seq = buildOsc99Sequence("::/::", "t", "b");
    expect(seq).toContain("i=ccmux:");
  });

  it("base64-encodes so an embedded ST cannot break out", () => {
    const seq = buildOsc99Sequence("abc", "t", `body${ST}more`);
    // Only the two framing STs remain; the payload's ST was stripped then
    // base64-encoded, so it never appears literally.
    const stCount = seq.split(ST).length - 1;
    expect(stCount).toBe(2);
  });
});

describe("wrapTmuxPassthrough", () => {
  it("frames with ESC Ptmux; ... ESC backslash and doubles inner ESC bytes", () => {
    expect(wrapTmuxPassthrough(`${ESC}]9;hi${BEL}`)).toBe(
      `${ESC}Ptmux;${ESC}${ESC}]9;hi${BEL}${ESC}\\`,
    );
  });

  it("doubles every ESC in a multi-escape (kitty) sequence", () => {
    const raw = `${ESC}]99;a${ST}${ESC}]99;b${ST}`;
    const wrapped = wrapTmuxPassthrough(raw);
    // 3 inner ESCs (two OSC introducers + ... actually: 2 OSC + 2 ST = 4) each
    // doubled, plus the leading `ESC P` and trailing `ESC \` from the framing.
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(wrapped.endsWith(`${ESC}\\`)).toBe(true);
    expect(wrapped).toContain(`${ESC}${ESC}]99;a`);
  });
});

describe("isKittyTermnames", () => {
  it("detects a kitty terminfo name among attached clients", () => {
    expect(isKittyTermnames("xterm-kitty")).toBe(true);
    expect(isKittyTermnames("xterm-ghostty\nxterm-kitty\n")).toBe(true);
    expect(isKittyTermnames("KITTY")).toBe(true);
  });

  it("returns false for non-kitty clients", () => {
    expect(isKittyTermnames("xterm-ghostty\ntmux-256color")).toBe(false);
    expect(isKittyTermnames("")).toBe(false);
  });
});

describe("buildPassthroughSequence", () => {
  it("selects generic OSC 9 and folds the subtitle into the message", () => {
    const seq = buildPassthroughSequence(BASE_PAYLOAD, false);
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(seq).toContain("]9;");
    // Subtitle + body folded, newline flattened to a space for OSC 9.
    expect(seq).toContain(
      "ccmux (main) · Claude Code: Needs permission: Bash rm -rf build",
    );
  });

  it("selects kitty OSC 99 and carries the folded subtitle in the body chunk", () => {
    const seq = buildPassthroughSequence(BASE_PAYLOAD, true);
    expect(seq).toContain("]99;");
    expect(seq).toContain("p=title;");
    expect(seq).toContain("p=body;");
    // The body chunk's base64 decodes to the folded subtitle + body.
    const bodyChunk = seq.split("p=body;")[1]!;
    const b64 = bodyChunk.slice(0, bodyChunk.indexOf(ESC));
    expect(decodeB64(b64)).toBe("Needs permission: Bash\nrm -rf build");
  });
});

describe("probeAllowPassthrough", () => {
  it("is true when the option reads on or all", () => {
    expect(probeAllowPassthrough(() => "on")).toBe(true);
    expect(probeAllowPassthrough(() => "all\n")).toBe(true);
    expect(probeAllowPassthrough(() => "  on  ")).toBe(true);
  });

  it("is false when the option is off, empty, or the query fails", () => {
    expect(probeAllowPassthrough(() => "off")).toBe(false);
    expect(probeAllowPassthrough(() => "")).toBe(false);
    expect(probeAllowPassthrough(() => null)).toBe(false);
  });
});

describe("deliverOscNotification", () => {
  it("writes the wrapped sequence to the given tty", () => {
    const writes: Array<{ tty: string; data: string }> = [];
    deliverOscNotification(BASE_PAYLOAD, "/dev/ttys061", {
      runTmux: () => "xterm-ghostty",
      writeToTty: (tty, data) => writes.push({ tty, data }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.tty).toBe("/dev/ttys061");
    expect(writes[0]!.data).toContain(`${ESC}Ptmux;`);
  });

  it("scopes the termname sniff to the payload's pane when set", () => {
    const calls: string[][] = [];
    deliverOscNotification(BASE_PAYLOAD, "/dev/ttys061", {
      runTmux: (args) => {
        calls.push(args);
        return "xterm-ghostty";
      },
      writeToTty: () => {},
    });
    expect(calls).toEqual([
      ["list-clients", "-t", "%5", "-F", "#{client_termname}"],
    ]);
  });

  it("falls back to a server-wide sniff when the payload has no pane", () => {
    const calls: string[][] = [];
    deliverOscNotification({ ...BASE_PAYLOAD, pane: null }, "/dev/ttys061", {
      runTmux: (args) => {
        calls.push(args);
        return "xterm-ghostty";
      },
      writeToTty: () => {},
    });
    expect(calls).toEqual([["list-clients", "-F", "#{client_termname}"]]);
  });

  it("swallows a throwing tty write and logs at debug level", () => {
    const logs: string[] = [];
    expect(() =>
      deliverOscNotification(BASE_PAYLOAD, "/dev/ttys061", {
        runTmux: () => null,
        writeToTty: () => {
          throw new Error("EACCES");
        },
        log: (message) => logs.push(message),
      }),
    ).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("osc tty write failed");
  });
});
