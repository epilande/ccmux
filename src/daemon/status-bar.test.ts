import { describe, expect, it } from "bun:test";
import { SessionManager } from "./sessions";
import { StatusBar, statusBarValues } from "./status-bar";
import type { StatusBarConfig } from "../lib/preferences";
import type { IconStyle } from "../lib/icons";
import type { SessionStatus } from "../types/session";

const panes = [
  { paneId: "%1", windowId: "@10" },
  { paneId: "%2", windowId: "@10" },
  { paneId: "%3", windowId: "@20" },
];
const red = (text: string) => `#[fg=red]${text}#[fg=default]`;
const green = (text: string) => `#[fg=green]${text}#[fg=default]`;
const workingMark = " #[fg=yellow]◐#[fg=default]";
const idleMark = " #[fg=brightblack]○#[fg=default]";
const stateMarks = { waiting: ` ${red("■")}`, working: workingMark, idle: idleMark };

function harness(config?: StatusBarConfig) {
  const sessions = new SessionManager();
  const calls: string[][] = [];
  const bar = new StatusBar(sessions, { statusBar: config }, async (args) => {
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
  it.each([
    [undefined, "3.8", false],
    [false, "3.8", false],
    [true, "3.8", true],
    [true, "3.8a", true],
    [true, "3.8-next", true],
    [true, "3.10", true],
    [true, "4.0", true],
    [true, "3.7c", false],
    [true, "3.2a", false],
    [true, "2.9", false],
    [true, "unknown", false],
    [true, null, false],
  ] satisfies [boolean | undefined, string | null, boolean][])(
    "uses native animation with opt-in %s and server %s only when supported (%s)",
    async (animateWorking, version, animated) => {
      const sessions = new SessionManager();
      const calls: string[][] = [];
      let probes = 0;
      const bar = new StatusBar(
        sessions,
        { statusBar: { animateWorking } },
        async (args) => { calls.push(args); return true; },
        async () => { probes++; return version; },
      );
      const session = sessions.createPaneTrackedSession({
        paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
      });
      sessions.updateSession(session.id, { status: "working" });
      bar.updatePanes(panes);
      bar.start();
      try {
        await bar.refresh();
        expect(calls).toContainEqual([
          "set-option", "-w", "-t", "@10", "@ccmux_state_mark",
          animated ? " #[fg=yellow]#{A/2:◐,◓,◑,◒}#[fg=default]" : workingMark,
        ]);
        expect(calls).toContainEqual(["set-option", "-qwu", "-t", "@10", "@ccmux_mark"]);
        if (animateWorking !== true) expect(probes).toBe(0);
      } finally {
        await bar.stop();
      }
    },
  );

  it.each([
    ["dot", " #[fg=yellow]#{A/2:◐,◓,◑,◒}#[fg=default]"],
    ["nerdfont", " #[fg=yellow]#{A/2:\uEE06,\uEE07,\uEE08,\uEE09,\uEE0A,\uEE0B}#[fg=default]"],
    ["emoji", " #[fg=yellow]⚡#[fg=default]"],
    ["none", null],
  ] satisfies [IconStyle, string | null][])(
    "preserves %s icon semantics when native animation is enabled",
    (style, expected) => {
      const sessions = new SessionManager();
      const session = sessions.createPaneTrackedSession({
        paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
      });
      sessions.updateSession(session.id, { status: "working" });
      const values = statusBarValues(sessions.getSessions(), panes, { animateWorking: true }, style, true);
      expect(values.stateMarks.get("@10")).toBe(expected);
      expect(values.windows.get("@10")).toBeNull();
    },
  );

  it("keeps attention and idle static with animation enabled", () => {
    const sessions = new SessionManager();
    const first = sessions.createPaneTrackedSession({
      paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
    });
    const second = sessions.createPaneTrackedSession({
      paneId: "%2", agentType: "claude", cwd: "/repo", pid: 124,
    });
    sessions.updateSession(first.id, { status: "working" });
    sessions.setAttentionState(second.id, "unread");
    const config = { animateWorking: true, waitingIcon: "!", unreadIcon: "*" };
    for (const [state, expected] of [
      ["unread", ` ${green("*")}`],
      ["waiting", ` ${red("!")}`],
      ["idle", idleMark],
    ] as const) {
      if (state === "waiting") sessions.updateSession(second.id, { status: "waiting" });
      if (state === "idle") {
        sessions.updateSession(first.id, { status: "idle" });
        sessions.updateSession(second.id, { status: "idle" });
        sessions.setAttentionState(second.id, "read");
      }
      const values = statusBarValues(sessions.getSessions(), panes, config, "dot", true);
      expect(values.stateMarks.get("@10")).toBe(expected);
      expect(values.windows.get("@10")).toBe(state === "idle" ? null : expected);
    }
  });

  it("caches server capability and probes again after server replacement", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let version = "3.8";
    let probes = 0;
    const bar = new StatusBar(
      sessions, { statusBar: { animateWorking: true } },
      async (args) => { calls.push(args); return true; },
      async () => { probes++; return version; },
    );
    const session = sessions.createPaneTrackedSession({
      paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
    });
    sessions.updateSession(session.id, { status: "working" });
    bar.start();
    try {
      await bar.refresh();
      expect(probes).toBe(0);
      bar.updatePanes(panes);
      await bar.refresh();
      expect(calls.some((args) => args.at(-1)?.includes("#{A/2:"))).toBe(true);
      calls.length = 0;
      bar.updatePanes(panes);
      await bar.refresh();
      expect(calls).toEqual([]);
      expect(probes).toBe(1);
      bar.updatePanes([], true);
      await bar.refresh();
      expect(probes).toBe(1);
      version = "3.7c";
      bar.updatePanes(panes);
      await bar.refresh();
      expect(calls).toContainEqual([
        "set-option", "-w", "-t", "@10", "@ccmux_state_mark", workingMark,
      ]);
      expect(probes).toBe(2);
    } finally {
      await bar.stop();
    }
  });

  it("falls back on probe failure and enables animation after the next successful probe", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let version: string | null = null;
    const bar = new StatusBar(
      sessions, { statusBar: { animateWorking: true } },
      async (args) => { calls.push(args); return true; },
      async () => version,
    );
    const session = sessions.createPaneTrackedSession({
      paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
    });
    sessions.updateSession(session.id, { status: "working" });
    bar.updatePanes(panes);
    bar.start();
    try {
      await bar.refresh();
      expect(calls).toContainEqual([
        "set-option", "-w", "-t", "@10", "@ccmux_state_mark", workingMark,
      ]);
      calls.length = 0;
      version = "3.8";
      await bar.refresh();
      expect(calls).toEqual([[
        "set-option", "-w", "-t", "@10", "@ccmux_state_mark",
        " #[fg=yellow]#{A/2:◐,◓,◑,◒}#[fg=default]",
      ]]);
    } finally {
      await bar.stop();
    }
  });

  it.each([
    ["idle", "idle", "idle"],
    ["idle", "working", "working"],
    ["working", "idle", "working"],
    ["idle", "waiting", "waiting"],
    ["waiting", "idle", "waiting"],
    ["working", "working", "working"],
    ["working", "waiting", "waiting"],
    ["waiting", "working", "waiting"],
    ["waiting", "waiting", "waiting"],
  ] satisfies [SessionStatus, SessionStatus, SessionStatus][])(
    "aggregates %s and %s as %s regardless of pane order",
    (first, second, expected) => {
      const values = statusBarValues(
        [first, second].map((status, index) => ({
          status,
          attentionState: null,
          tmuxPane: `%${index + 1}`,
          trackingMode: "pane" as const,
          logPath: null,
        })),
        panes,
        {},
      );
      expect(Object.fromEntries(values.stateMarks)).toEqual({
        "@10": stateMarks[expected],
        "@20": null,
      });
      expect(values.windows.get("@10")).toBe(expected === "waiting" ? ` ${red("■")}` : null);
    },
  );

  it.each([
    ["dot", workingMark, idleMark],
    ["emoji", " #[fg=yellow]⚡#[fg=default]", " #[fg=brightblack]💤#[fg=default]"],
    ["nerdfont", " #[fg=yellow]\uF0E7#[fg=default]", " #[fg=brightblack]\u{F04B2}#[fg=default]"],
    ["none", null, null],
  ] satisfies [IconStyle, string | null, string | null][])(
    "honors %s icons for working and idle without changing attention marks",
    (style, working, idle) => {
      const values = statusBarValues([
        { status: "working", attentionState: null, tmuxPane: "%1", trackingMode: "pane", logPath: null },
        { status: "idle", attentionState: null, tmuxPane: "%3", trackingMode: "pane", logPath: null },
      ], panes, {}, style);
      expect(Object.fromEntries(values.stateMarks)).toEqual({ "@10": working, "@20": idle });
      expect(Object.fromEntries(values.windows)).toEqual({ "@10": null, "@20": null });
    },
  );

  it.each(["idle", "working", "waiting"] satisfies SessionStatus[])(
    "preserves unread attention against a %s agent in either pane order",
    (status) => {
      for (const order of [["%1", "%2"], ["%2", "%1"]]) {
        const values = statusBarValues([
          { status, attentionState: null, tmuxPane: order[0], trackingMode: "pane", logPath: null },
          { status: "idle", attentionState: "unread", tmuxPane: order[1], trackingMode: "pane", logPath: null },
        ], panes, {});
        const expected = status === "waiting" ? ` ${red("■")}` : ` ${green("●")}`;
        expect(values.stateMarks.get("@10")).toBe(expected);
        expect(values.windows.get("@10")).toBe(expected);
      }
    },
  );

  for (const [style, waiting, unread] of [
    ["dot", "■", "●"],
    ["emoji", "⏳", "📬"],
    ["nerdfont", "\uF253", "\u{F0EB0}"],
    ["none", "", ""],
  ] satisfies [IconStyle, string, string][]) {
    it(`honors ${style} icons in the segment and window marks`, async () => {
      const sessions = new SessionManager();
      const calls: string[][] = [];
      const bar = new StatusBar(
        sessions,
        {
          statusBar: {
            enabled: true,
            waitingColor: "yellow",
            unreadColor: "green",
          },
          iconStyle: style,
        },
        async (args) => {
          calls.push(args);
          return true;
        },
      );
      for (const paneId of ["%1", "%3"]) {
        const session = sessions.createPaneTrackedSession({
          paneId,
          agentType: "claude",
          cwd: "/repo",
          pid: 123,
        });
        if (paneId === "%1")
          sessions.updateSession(session.id, { status: "waiting" });
        else sessions.setAttentionState(session.id, "unread");
      }
      bar.start();
      bar.updatePanes(panes);
      await bar.refresh();
      expect(calls).toContainEqual([
        "set-option",
        "-g",
        "@ccmux_status",
        `#[fg=yellow]${waiting ? `${waiting} ` : ""}1#[fg=default] #[fg=green]${unread ? `${unread} ` : ""}1#[fg=default]`,
      ]);
      for (const [window, icon, color] of [
        ["@10", waiting, "yellow"],
        ["@20", unread, "green"],
      ]) {
        expect(calls).toContainEqual(
          icon
            ? [
                "set-option",
                "-w",
                "-t",
                window,
                "@ccmux_mark",
                ` #[fg=${color}]${icon}#[fg=default]`,
              ]
            : ["set-option", "-qwu", "-t", window, "@ccmux_mark"],
        );
        expect(calls).toContainEqual(
          icon
            ? ["set-option", "-w", "-t", window, "@ccmux_state_mark", ` #[fg=${color}]${icon}#[fg=default]`]
            : ["set-option", "-qwu", "-t", window, "@ccmux_state_mark"],
        );
      }
      await bar.stop();
    });
  }

  it("keeps explicit icon overrides, including empty overrides and none style", () => {
    const sessions = [
      {
        status: "waiting" as const,
        attentionState: null,
        tmuxPane: "%1",
        trackingMode: "pane" as const,
        logPath: null,
      },
    ];
    expect(
      statusBarValues(
        sessions,
        panes,
        { waitingIcon: "!" },
        "none",
      ).windows.get("@10"),
    ).toBe(` ${red("!")}`);
    const hidden = statusBarValues(
      sessions,
      panes,
      { waitingIcon: "", waitingColor: "red" },
      "emoji",
    );
    expect(hidden.windows.get("@10")).toBeNull();
    expect(hidden.globals.get("@ccmux_status")).toBe("#[fg=red]1#[fg=default]");
    expect(
      statusBarValues(
        sessions,
        panes,
        { waitingIcon: "#{invalid}" },
        "emoji",
      ).windows.get("@10"),
    ).toBe(` ${red("⏳")}`);
  });

  for (const config of [undefined, {}, { enabled: true }]) {
    it(`publishes with ${JSON.stringify(config) ?? "no statusBar config"}`, async () => {
      const { bar, calls, sessions, add } = harness(config);
      sessions.updateSession(add().id, { status: "waiting" });
      // The daemon supplies the initial scan before starting the publisher.
      bar.updatePanes(panes);
      await bar.refresh();
      expect(calls).toEqual([]);
      bar.start();
      await bar.refresh();
      expect(calls).toContainEqual(["set-option", "-g", "@ccmux_waiting", "1"]);
      expect(calls).toContainEqual([
        "set-option",
        "-w",
        "-t",
        "@10",
        "@ccmux_mark",
        ` ${red("■")}`,
      ]);
      await bar.stop();
    });
  }

  it("never subscribes or runs tmux when explicitly disabled", async () => {
    const { bar, sessions, calls, add } = harness({ enabled: false });
    bar.start();
    add();
    bar.updatePanes(panes);
    await bar.refresh();
    await bar.stop();
    expect(calls).toEqual([]);
    expect(sessions.listenerCount("change")).toBe(0);
  });

  it("stays quiet before a successful scan and while no server exists, including shutdown", async () => {
    const { bar, calls, sessions, add } = harness();
    bar.start();
    const session = add();
    await bar.refresh();
    expect(calls).toEqual([]);
    for (let i = 0; i < 3; i++) {
      bar.updatePanes([], true);
      sessions.updateSession(session.id, { lastPrompt: `prompt ${i}` });
      await bar.refresh();
    }
    await bar.stop();
    expect(calls).toEqual([]);
    expect(sessions.listenerCount("change")).toBe(0);
  });

  it("republishes all counts and marks after server loss, even with reused window IDs", async () => {
    const { bar, calls, sessions, add } = harness();
    sessions.updateSession(add().id, { status: "waiting" });
    bar.updatePanes([], true);
    bar.start();
    await bar.refresh();
    expect(calls).toEqual([]);
    bar.updatePanes(panes);
    await bar.refresh();
    const initial = calls.slice();
    expect(initial.filter((args) => args[1] === "-g")).toHaveLength(4);
    expect(initial).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "@10",
      "@ccmux_mark",
      ` ${red("■")}`,
    ]);
    calls.length = 0;
    bar.updatePanes([], true);
    await bar.refresh();
    expect(calls).toEqual([]);
    bar.updatePanes(panes);
    await bar.refresh();
    expect(calls).toEqual(initial);
    await bar.stop();
  });

  it("counts background sessions globally and prioritizes waiting in shared windows", () => {
    const values = statusBarValues(
      [
        {
          status: "waiting",
          attentionState: null,
          tmuxPane: "%1",
          trackingMode: "pane",
          logPath: null,
        },
        {
          status: "idle",
          attentionState: "unread",
          tmuxPane: "%2",
          trackingMode: "pane",
          logPath: null,
        },
        {
          status: "working",
          attentionState: null,
          tmuxPane: "%3",
          trackingMode: "pane",
          logPath: null,
        },
        {
          status: "waiting",
          attentionState: "unread",
          tmuxPane: null,
          trackingMode: "background",
          logPath: null,
        },
      ],
      panes,
      {},
    );
    expect(Object.fromEntries(values.globals)).toEqual({
      "@ccmux_waiting": "2",
      "@ccmux_unread": "2",
      "@ccmux_working": "1",
      "@ccmux_status": `${red("■ 2")} ${green("● 2")}`,
    });
    expect(Object.fromEntries(values.windows)).toEqual({
      "@10": ` ${red("■")}`,
      "@20": null,
    });
    expect(Object.fromEntries(values.stateMarks)).toEqual({
      "@10": ` ${red("■")}`,
      "@20": workingMark,
    });
  });

  it("counts only sessions the picker lists", () => {
    const values = statusBarValues(
      [
        // Soft-evicted pane session: keeps its last status, hidden until reaped.
        {
          status: "waiting",
          attentionState: null,
          tmuxPane: null,
          trackingMode: "pane",
          logPath: null,
        },
        // Unbound native session: listed in the picker, so counted, but unmarked.
        {
          status: "waiting",
          attentionState: null,
          tmuxPane: null,
          trackingMode: "native",
          logPath: "/logs/session.jsonl",
        },
        {
          status: "idle",
          attentionState: "unread",
          tmuxPane: "%3",
          trackingMode: "pane",
          logPath: null,
        },
      ],
      panes,
      {},
    );
    expect(Object.fromEntries(values.globals)).toEqual({
      "@ccmux_waiting": "1",
      "@ccmux_unread": "1",
      "@ccmux_working": "0",
      "@ccmux_status": `${red("■ 1")} ${green("● 1")}`,
    });
    expect(Object.fromEntries(values.windows)).toEqual({
      "@10": null,
      "@20": ` ${green("●")}`,
    });
    expect(Object.fromEntries(values.stateMarks)).toEqual({
      "@10": null,
      "@20": ` ${green("●")}`,
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
    expect(calls).toContainEqual([
      "set-option", "-qwu", "-t", "@20", "@ccmux_state_mark",
    ]);
    calls.length = 0;
    for (let i = 0; i < 20; i++)
      sessions.updateSession(session.id, { lastPrompt: `prompt ${i}` });
    await bar.refresh();
    expect(calls).toEqual([]);
    sessions.updateSession(session.id, { status: "working" });
    await bar.refresh();
    expect(calls).toEqual([
      ["set-option", "-g", "@ccmux_working", "1"],
      ["set-option", "-w", "-t", "@10", "@ccmux_state_mark", workingMark],
    ]);
    await bar.stop();
  });

  it("updates through change events and clears on focus, removal, and pane moves", async () => {
    const { bar, calls, sessions, add } = harness();
    const session = add();
    bar.start();
    bar.updatePanes(panes);
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@10", "@ccmux_state_mark", idleMark,
    ]);
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
      ` ${green("●")}`,
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
      ` ${green("●")}`,
    ]);
    expect(calls).toContainEqual([
      "set-option", "-qwu", "-t", "@10", "@ccmux_state_mark",
    ]);
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@20", "@ccmux_state_mark", ` ${green("●")}`,
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
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@20", "@ccmux_state_mark", idleMark,
    ]);
    sessions.updateSession(session.id, { status: "working" });
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@20", "@ccmux_state_mark", workingMark,
    ]);
    sessions.updateSession(session.id, { status: "waiting" });
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@20", "@ccmux_state_mark", ` ${red("■")}`,
    ]);
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
    expect(calls).toContainEqual([
      "set-option", "-qwu", "-t", "@20", "@ccmux_state_mark",
    ]);
    await bar.stop();
  });

  it("falls back to remaining agents when one exits a shared window", async () => {
    const { bar, calls, sessions, add } = harness();
    const waiting = add("%1");
    const working = add("%2");
    sessions.updateSession(waiting.id, { status: "waiting" });
    sessions.updateSession(working.id, { status: "working" });
    bar.updatePanes(panes);
    bar.start();
    await bar.refresh();
    calls.length = 0;
    sessions.removeSession(waiting.id);
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@10", "@ccmux_state_mark", workingMark,
    ]);
    calls.length = 0;
    sessions.updateSession(working.id, { status: "idle" });
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@10", "@ccmux_state_mark", idleMark,
    ]);
    calls.length = 0;
    sessions.removeSession(working.id);
    await bar.refresh();
    expect(calls).toContainEqual([
      "set-option", "-qwu", "-t", "@10", "@ccmux_state_mark",
    ]);
    await bar.stop();
  });

  it("retries a failed state write without republishing unchanged values", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let failing = true;
    const bar = new StatusBar(sessions, {}, async (args) => {
      calls.push(args);
      return !(failing && args.includes("@10") && args.includes("@ccmux_state_mark"));
    });
    sessions.createPaneTrackedSession({
      paneId: "%1", agentType: "claude", cwd: "/repo", pid: 123,
    });
    bar.updatePanes(panes);
    bar.start();
    await bar.refresh();
    calls.length = 0;
    failing = false;
    await bar.refresh();
    expect(calls).toEqual([
      ["set-option", "-w", "-t", "@10", "@ccmux_state_mark", idleMark],
    ]);
    await bar.stop();
  });

  it("uses custom icons/colors and falls back on malformed hand-edited values", () => {
    const sessions = [
      {
        status: "waiting" as const,
        attentionState: null,
        tmuxPane: "%1",
        trackingMode: "pane" as const,
        logPath: null,
      },
    ];
    const values = statusBarValues(sessions, panes, {
      waitingIcon: "!",
      waitingColor: "yellow",
    });
    expect(values.globals.get("@ccmux_status")).toBe(
      "#[fg=yellow]! 1#[fg=default]",
    );
    expect(values.windows.get("@10")).toBe(" #[fg=yellow]!#[fg=default]");
    expect(
      statusBarValues(sessions, panes, {
        waitingIcon: "#{bad}",
        waitingColor: "red]oops",
      }).globals.get("@ccmux_status"),
    ).toBe(red("■ 1"));
  });

  it("inherits the surrounding style when a color is set to empty", () => {
    const sessions = [
      {
        status: "waiting" as const,
        attentionState: null,
        tmuxPane: "%1",
        trackingMode: "pane" as const,
        logPath: null,
      },
      {
        status: "idle" as const,
        attentionState: "unread" as const,
        tmuxPane: "%3",
        trackingMode: "pane" as const,
        logPath: null,
      },
    ];
    const values = statusBarValues(sessions, panes, {
      waitingColor: "",
      unreadColor: "",
    });
    expect(values.globals.get("@ccmux_status")).toBe("■ 1 ● 1");
    expect(values.windows.get("@10")).toBe(" ■");
    expect(values.windows.get("@20")).toBe(" ●");
  });

  it("retries failed writes on the next scan without rewriting successful values", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let failing = true;
    const bar = new StatusBar(
      sessions,
      { statusBar: { enabled: true } },
      async (args) => {
        calls.push(args);
        if (failing && args.includes("@ccmux_unread"))
          throw new Error("tmux unavailable");
        return true;
      },
    );
    bar.start();
    bar.updatePanes([]);
    await bar.refresh();
    calls.length = 0;
    failing = false;
    bar.updatePanes([]);
    await bar.refresh();
    expect(calls).toEqual([["set-option", "-g", "@ccmux_unread", "0"]]);
    await bar.stop();
  });

  it("stops further writes when server loss arrives during an in-flight write", async () => {
    const sessions = new SessionManager();
    const calls: string[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bar = new StatusBar(sessions, {}, async (args) => {
      calls.push(args);
      if (calls.length === 1) await blocked;
      return true;
    });
    bar.updatePanes(panes);
    bar.start();
    const pending = bar.refresh();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    bar.updatePanes([], true);
    release();
    await pending;
    expect(calls).toHaveLength(1);
    calls.length = 0;
    bar.updatePanes(panes);
    await bar.refresh();
    expect(calls.filter((args) => args[1] === "-g")).toHaveLength(4);
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
    const bar = new StatusBar(
      sessions,
      { statusBar: { enabled: true } },
      async (args) => {
        if (first) {
          first = false;
          await blocked;
        }
        const name = args[1].includes("w") ? `${args[3]}/${args[4]}` : args[2];
        if (args[1].includes("u")) values.delete(name);
        else values.set(name, args.at(-1)!);
        return true;
      },
    );
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
    expect(values.get("@ccmux_status")).toBe(green("● 1"));
    expect(values.get("@ccmux_waiting")).toBe("0");
    expect(values.has("@10/@ccmux_mark")).toBe(false);
    expect(values.get("@20/@ccmux_mark")).toBe(` ${green("●")}`);
    expect(values.has("@10/@ccmux_state_mark")).toBe(false);
    expect(values.get("@20/@ccmux_state_mark")).toBe(` ${green("●")}`);
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
    const bar = new StatusBar(
      sessions,
      { statusBar: { enabled: true } },
      async (args) => {
        calls.push(args);
        if (first) {
          first = false;
          await blocked;
        }
        return true;
      },
    );
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
    expect(calls.slice(cleanup)).toContainEqual([
      "set-option", "-qwu", "-t", "@10", "@ccmux_state_mark",
    ]);
    expect(sessions.listenerCount("change")).toBe(0);
    calls.length = 0;
    sessions.setAttentionState(session.id, "unread");
    await bar.refresh();
    expect(calls).toEqual([]);
  });

  it("unsets only marked windows on shutdown", async () => {
    const { bar, calls, sessions, add } = harness();
    sessions.updateSession(add().id, { status: "waiting" });
    bar.start();
    bar.updatePanes(panes);
    await bar.refresh();
    calls.length = 0;
    await bar.stop();
    expect(calls.filter((args) => args.includes("@ccmux_mark"))).toEqual([
      ["set-option", "-qwu", "-t", "@10", "@ccmux_mark"],
    ]);
    expect(calls.filter((args) => args.includes("@ccmux_state_mark"))).toEqual([
      ["set-option", "-qwu", "-t", "@10", "@ccmux_state_mark"],
    ]);
  });
});
