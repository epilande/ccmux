import { describe, it, expect } from "bun:test";
import {
  getActiveTmuxClientPid,
  resolveActiveTmuxClientTty,
} from "./tmux-client";

/** Stub `Bun.spawn` to return canned stdout/exit code for the next call. */
function withSpawn(stdout: string, exitCode = 0): () => void {
  const original = Bun.spawn;
  Bun.spawn = (() => ({
    stdout: new Blob([stdout]).stream(),
    exited: Promise.resolve(exitCode),
  })) as unknown as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

function withThrowingSpawn(): () => void {
  const original = Bun.spawn;
  Bun.spawn = (() => {
    throw new Error("no tmux server");
  }) as unknown as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

describe("getActiveTmuxClientPid", () => {
  it("parses the pid from display-message output", async () => {
    const restore = withSpawn("12345\n");
    try {
      expect(await getActiveTmuxClientPid()).toBe(12345);
    } finally {
      restore();
    }
  });

  it("returns null on a non-zero exit", async () => {
    const restore = withSpawn("", 1);
    try {
      expect(await getActiveTmuxClientPid()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when spawn throws (no tmux server)", async () => {
    const restore = withThrowingSpawn();
    try {
      expect(await getActiveTmuxClientPid()).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("resolveActiveTmuxClientTty", () => {
  it("picks the tty with the highest client_activity", async () => {
    const restore = withSpawn(
      "100 /dev/ttys001\n200 /dev/ttys002\n50 /dev/ttys003\n",
    );
    try {
      expect(await resolveActiveTmuxClientTty()).toBe("/dev/ttys002");
    } finally {
      restore();
    }
  });

  it("returns null when no clients are attached", async () => {
    const restore = withSpawn("");
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null on a non-zero exit", async () => {
    const restore = withSpawn("100 /dev/ttys001\n", 1);
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when spawn throws", async () => {
    const restore = withThrowingSpawn();
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });
});
