import { describe, expect, it } from "bun:test";
import { SessionManager } from "./sessions";
import { StatusBar, statusBarValues } from "./status-bar";
import type { StatusBarConfig } from "../lib/preferences";

const panes = [
  { paneId: "%1", windowId: "@10" },
  { paneId: "%2", windowId: "@10" },
  { paneId: "%3", windowId: "@20" },
];

function harness(config: StatusBarConfig = { enabled: true }) {
  const sessions = new SessionManager();
  const calls: string[][] = [];
  const bar = new StatusBar(sessions, config, async (args) => {
    calls.push(args);
    return true;
  });
  const add = (paneId = "%1") =>
    sessions.createPaneTrackedSession({
      paneId,
      agentType: "claude",
      cwd: "/repo",
      pid: 123,
    });
  return { sessions, calls, bar, add };
}

describe("status bar", () => {
  it("is opt-in and never subscribes or runs tmux when disabled", async () => {
    const { bar, sessions, calls, add } = harness({});
    bar.start();
    add();
    bar.updatePanes(panes);
    await bar.refresh();
    await bar.stop();
    expect(calls).toEqual([]);
    expect(sessions.listenerCount("change")).toBe(0);
  });

  it("counts background sessions globally and prioritizes waiting in shared windows", () => {
    const values = statusBarValues(
      [
        {
          status: "waiting",
          attentionState: null,
          tmuxPane: "%1",
          trackingMode: "pane",
        },
        {
          status: "idle",
          attentionState: "unread",
          tmuxPane: "%2",
          trackingMode: "pane",
        },
        {
          status: "working",
          attentionState: null,
          tmuxPane: "%3",
          trackingMode: "pane",
        },
        {
          status: "waiting",
          attentionState: "unread",
          tmuxPane: null,
          trackingMode: "background",
        },
      ],
      panes,
      {},
    );
    expect(Object.fromEntries(values.globals)).toEqual({
      "@ccmux_waiting": "2",
      "@ccmux_unread": "2",
      "@ccmux_working": "1",
      "@ccmux_status": "⚠2 ●2",
    });
    expect(Object.fromEntries(values.windows)).toEqual({
      "@10": "⚠",
      "@20": null,
    });
  });

  it("publishes initial zero counts, clears stale marks, and skips unchanged log updates", async () => {
    const { bar, calls, sessions, add } = harness();
    const session = add();
    bar.start();
    bar.updatePanes(panes);
    await bar.refresh();
    expect(calls).toContainEqual(["set-option", "-g", "@ccmux_status", ""]);
    expect(calls).toContainEqual([
      "set-option",
      "-qwu",
      "-t",
      "@20",
      "@ccmux_mark",
    ]);
    calls.length = 0;
    for (let i = 0; i < 20; i++)
      sessions.updateSession(session.id, { lastPrompt: `prompt ${i}` });
    await bar.refresh();
    expect(calls).toEqual([]);
    sessions.updateSession(session.id, { status: "working" });
    await bar.refresh();
    expect(calls).toEqual([["set-option", "-g", "@ccmux_working", "1"]]);
    await bar.stop();
  });

  it("updates through change events and clears on focus, removal, and pane moves", async () => {
    const { bar, calls, sessions, add } = harness();
    const session = add();
    bar.start();
    bar.updatePanes(panes);
    await bar.refresh();
    calls.length = 0;
    sessions.setAttentionState(session.id, "unread");
    // No explicit refresh: the SessionManager event schedules the write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "@10",
      "@ccmux_mark",
      "●",
    ]);
    calls.length = 0;
    bar.updatePanes([
      { paneId: "%1", windowId: "@20" },
      { paneId: "%2", windowId: "@10" },
    ]);
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option",
      "-qwu",
      "-t",
      "@10",
      "@ccmux_mark",
    ]);
    expect(calls).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "@20",
      "@ccmux_mark",
      "●",
    ]);
    calls.length = 0;
    sessions.setAttentionState(session.id, "read");
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option",
      "-qwu",
      "-t",
      "@20",
      "@ccmux_mark",
    ]);
    sessions.updateSession(session.id, { status: "waiting" });
    await bar.refresh();
    calls.length = 0;
    sessions.removeSession(session.id);
    await bar.refresh();
    expect(calls).toContainEqual(["set-option", "-g", "@ccmux_waiting", "0"]);
    expect(calls).toContainEqual([
      "set-option",
      "-qwu",
      "-t",
      "@20",
      "@ccmux_mark",
    ]);
    await bar.stop();
  });

  it("uses custom icons/colors and ignores malformed hand-edited values", () => {
    const sessions = [
      {
        status: "waiting" as const,
        attentionState: null,
        tmuxPane: "%1",
        trackingMode: "pane" as const,
      },
    ];
    const values = statusBarValues(sessions, panes, {
      waitingIcon: "!",
      waitingColor: "yellow",
    });
    expect(values.globals.get("@ccmux_status")).toBe(
      "#[fg=yellow]!1#[fg=default]",
    );
    expect(values.windows.get("@10")).toBe(
      "#[fg=yellow]!#[fg=default]",
    );
    expect(
      statusBarValues(sessions, panes, {
        waitingIcon: "#{bad}",
        waitingColor: "red]oops",
      }).globals.get("@ccmux_status"),
    ).toBe("⚠1");
  });

  it("retries failed writes on the next scan without rewriting successful values", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let failing = true;
    const bar = new StatusBar(sessions, { enabled: true }, async (args) => {
      calls.push(args);
      if (failing && args.includes("@ccmux_unread"))
        throw new Error("tmux unavailable");
      return true;
    });
    bar.start();
    await bar.refresh();
    calls.length = 0;
    failing = false;
    bar.updatePanes([]);
    await bar.refresh();
    expect(calls).toEqual([["set-option", "-g", "@ccmux_unread", "0"]]);
    calls.length = 0;
    bar.updatePanes([], true);
    await bar.refresh();
    expect(calls).toHaveLength(4);
    await bar.stop();
  });

  it("converges on changes and pane moves received during an in-flight write", async () => {
    const sessions = new SessionManager();
    const session = sessions.createPaneTrackedSession({
      paneId: "%1",
      agentType: "claude",
      cwd: "/repo",
      pid: 123,
    });
    sessions.updateSession(session.id, { status: "waiting" });
    const values = new Map<string, string>();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const bar = new StatusBar(sessions, { enabled: true }, async (args) => {
      if (first) {
        first = false;
        await blocked;
      }
      const name = args[1].includes("w") ? `${args[3]}/@ccmux_mark` : args[2];
      if (args[1].includes("u")) values.delete(name);
      else values.set(name, args.at(-1)!);
      return true;
    });
    bar.start();
    bar.updatePanes(panes);
    await Promise.resolve();
    sessions.updateSession(session.id, { status: "idle" });
    sessions.setAttentionState(session.id, "unread");
    bar.updatePanes([
      { paneId: "%1", windowId: "@20" },
      { paneId: "%2", windowId: "@10" },
    ]);
    const settled = bar.refresh();
    release();
    await settled;
    expect(values.get("@ccmux_status")).toBe("●1");
    expect(values.get("@ccmux_waiting")).toBe("0");
    expect(values.has("@10/@ccmux_mark")).toBe(false);
    expect(values.get("@20/@ccmux_mark")).toBe("●");
    await bar.stop();
    expect(values.size).toBe(0);
  });

  it("serializes writes and drains in-flight work before shutdown cleanup", async () => {
    const sessions = new SessionManager();
    const session = sessions.createPaneTrackedSession({
      paneId: "%1",
      agentType: "claude",
      cwd: "/repo",
      pid: 123,
    });
    sessions.updateSession(session.id, { status: "waiting" });
    const calls: string[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const bar = new StatusBar(sessions, { enabled: true }, async (args) => {
      calls.push(args);
      if (first) {
        first = false;
        await blocked;
      }
      return true;
    });
    bar.start();
    bar.updatePanes(panes);
    await Promise.resolve();
    sessions.updateSession(session.id, { status: "working" });
    const stopping = bar.stop();
    expect(calls).toHaveLength(1);
    release();
    await stopping;
    const cleanup = calls.findIndex((args) => args[1] === "-gu");
    expect(cleanup).toBeGreaterThan(0);
    expect(calls.slice(cleanup).every((args) => args[1].includes("u"))).toBe(
      true,
    );
    expect(
      calls.slice(cleanup).filter((args) => args[1] === "-gu"),
    ).toHaveLength(4);
    expect(calls.slice(cleanup)).toContainEqual([
      "set-option",
      "-qwu",
      "-t",
      "@10",
      "@ccmux_mark",
    ]);
    expect(sessions.listenerCount("change")).toBe(0);
    calls.length = 0;
    sessions.setAttentionState(session.id, "unread");
    await bar.refresh();
    expect(calls).toEqual([]);
  });
});
