import { describe, it, expect, mock } from "bun:test";
import type { FlatItem } from "./utils/grouping";
import { mockEnrichedSession } from "./components/test-helpers";

// capturePane is mocked (process-wide, per Bun's mock.module) so the
// searchPaneLines tests can assert what the store passes it, without
// shelling out to a real `tmux capture-pane`. Spread the real module so
// other exports (unused here) stay intact. Must be mocked BEFORE "./store"
// is (dynamically) imported below, so the store's own import of capturePane
// resolves to this mock.
const realTmux = await import("./utils/tmux");
const capturePaneSpy = mock(async (_pane: string, _lines: number) => "");
mock.module("./utils/tmux", () => ({
  ...realTmux,
  capturePane: capturePaneSpy,
}));

const { createTUIStore: _createTUIStore } = await import("./store");

function headerLabels(items: FlatItem[]): string[] {
  return items
    .filter(
      (i): i is Extract<FlatItem, { type: "header" }> => i.type === "header",
    )
    .map((h) => h.label);
}

/** Wrap createTUIStore with a no-op persist to avoid writing state.json in tests */
const noop = () => {};
function createTUIStore(options: Parameters<typeof _createTUIStore>[0] = {}) {
  return _createTUIStore({ onPersistState: noop, ...options });
}

const createMockSession = mockEnrichedSession;

/** Wait for the 300ms store debounce to flush (+ 50ms buffer) */
const waitForDebounce = () => new Promise((r) => setTimeout(r, 350));

describe("store", () => {
  describe("sortedSessions", () => {
    it("should sort waiting to top, working and idle in same tier", () => {
      const store = createTUIStore({ groupBy: "none" });

      store.actions.setSessions([
        createMockSession({
          id: "idle",
          status: "idle",
          lastUserInputAt: "2024-01-01T12:00:00Z",
        }),
        createMockSession({
          id: "working",
          status: "working",
          lastUserInputAt: "2024-01-01T13:00:00Z",
        }),
        createMockSession({
          id: "waiting",
          status: "waiting",
          attentionType: "permission",
          lastUserInputAt: "2024-01-01T11:00:00Z",
        }),
      ]);

      const sorted = store.sortedSessions();
      // waiting floats to top; working/idle share a tier, ordered by time
      expect(sorted.map((s) => s.id)).toEqual(["waiting", "working", "idle"]);
    });

    it("should sort by lastUserInputAt within same status", () => {
      const store = createTUIStore({ groupBy: "none" });

      store.actions.setSessions([
        createMockSession({
          id: "older",
          status: "working",
          lastUserInputAt: "2024-01-01T12:00:00Z",
          lastActivityAt: "2024-01-01T12:05:00Z",
        }),
        createMockSession({
          id: "newer",
          status: "working",
          lastUserInputAt: "2024-01-01T12:30:00Z",
          lastActivityAt: "2024-01-01T12:30:00Z",
        }),
      ]);

      const sorted = store.sortedSessions();
      expect(sorted.map((s) => s.id)).toEqual(["newer", "older"]);
    });

    it("should fall back to statusChangedAt when lastUserInputAt is null", () => {
      const store = createTUIStore({ groupBy: "none" });

      store.actions.setSessions([
        createMockSession({
          id: "with-input",
          status: "idle",
          lastUserInputAt: "2024-01-01T12:00:00Z",
          lastActivityAt: "2024-01-01T12:00:00Z",
        }),
        createMockSession({
          id: "no-input",
          status: "idle",
          lastUserInputAt: null,
          statusChangedAt: "2024-01-01T12:30:00Z",
          // Fresher than everything else, but activity must NOT be a sort
          // key: it churns while working (see the j/k regression below).
          lastActivityAt: "2024-01-01T13:00:00Z",
        }),
      ]);

      const sorted = store.sortedSessions();
      expect(sorted.map((s) => s.id)).toEqual(["no-input", "with-input"]);
    });

    it("keeps j/k navigation advancing while working sessions emit activity", () => {
      const store = createTUIStore({ groupBy: "none" });

      // Marker/terminal-tracked agents: no lastUserInputAt, so they sort by
      // the statusChangedAt fallback. All working, all churning activity.
      const base = Date.parse("2024-01-15T12:00:00Z");
      store.actions.setSessions(
        Array.from({ length: 8 }, (_, i) =>
          createMockSession({
            id: `s${i}`,
            status: "working",
            lastUserInputAt: null,
            statusChangedAt: new Date(base + i * 1000).toISOString(),
            lastActivityAt: new Date(base + i * 1000).toISOString(),
          }),
        ),
      );

      // Press j repeatedly; between presses, agents emit activity (the SSE
      // session_updated deltas a busy daemon streams). With lastActivityAt as
      // a sort key this reordered the list under the cursor and navigation
      // looped instead of reaching the bottom.
      let clock = base + 100_000;
      for (let press = 0; press < 20; press++) {
        store.actions.moveSelection(1);
        for (const id of [`s${press % 8}`, `s${(press + 3) % 8}`]) {
          const cur = store.state.sessions.find((s) => s.id === id)!;
          clock += 1000;
          store.actions.updateSession({
            ...cur,
            lastActivityAt: new Date(clock).toISOString(),
          });
        }
      }

      expect(store.selectedIndex()).toBe(store.flatItems().length - 1);
      expect(store.selectedSession()?.id).toBe("s0");
    });

    it("should remain stable when lastActivityAt changes but lastUserInputAt does not", () => {
      const store = createTUIStore({ groupBy: "none" });

      const session1 = createMockSession({
        id: "first",
        status: "working",
        lastUserInputAt: "2024-01-01T12:30:00Z",
        lastActivityAt: "2024-01-01T12:30:00Z",
      });
      const session2 = createMockSession({
        id: "second",
        status: "working",
        lastUserInputAt: "2024-01-01T12:00:00Z",
        lastActivityAt: "2024-01-01T12:00:00Z",
      });

      store.actions.setSessions([session1, session2]);

      let sorted = store.sortedSessions();
      expect(sorted.map((s) => s.id)).toEqual(["first", "second"]);

      store.actions.updateSession({
        ...session2,
        lastActivityAt: "2024-01-01T13:00:00Z",
      });

      sorted = store.sortedSessions();
      expect(sorted.map((s) => s.id)).toEqual(["first", "second"]);
    });

    it("should reorder when lastUserInputAt changes", () => {
      const store = createTUIStore({ groupBy: "none" });

      const session1 = createMockSession({
        id: "first",
        status: "working",
        lastUserInputAt: "2024-01-01T12:30:00Z",
      });
      const session2 = createMockSession({
        id: "second",
        status: "working",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });

      store.actions.setSessions([session1, session2]);
      expect(store.sortedSessions().map((s) => s.id)).toEqual([
        "first",
        "second",
      ]);

      store.actions.updateSession({
        ...session2,
        lastUserInputAt: "2024-01-01T13:00:00Z",
        lastActivityAt: "2024-01-01T13:00:00Z",
      });

      expect(store.sortedSessions().map((s) => s.id)).toEqual([
        "second",
        "first",
      ]);
    });

    it("should handle sessions with no timestamps", () => {
      const store = createTUIStore({ groupBy: "none" });

      store.actions.setSessions([
        createMockSession({
          id: "no-timestamps",
          status: "idle",
          lastUserInputAt: null,
          lastActivityAt: null,
        }),
        createMockSession({
          id: "has-timestamps",
          status: "idle",
          lastUserInputAt: "2024-01-01T12:00:00Z",
          lastActivityAt: "2024-01-01T12:00:00Z",
        }),
      ]);

      const sorted = store.sortedSessions();
      expect(sorted.map((s) => s.id)).toEqual([
        "has-timestamps",
        "no-timestamps",
      ]);
    });
  });

  describe("confirmDialog", () => {
    it("should show kill confirmation for a session", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog("s1", "kill");

      expect(store.state.confirmMode).toBe(true);
      expect(store.state.confirmSessionId).toBe("s1");
      expect(store.state.confirmAction).toBe("kill");
    });

    it("should show kill-all confirmation", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog(null, "kill-all");

      expect(store.state.confirmMode).toBe(true);
      expect(store.state.confirmSessionId).toBeNull();
      expect(store.state.confirmAction).toBe("kill-all");
    });

    it("should show kill-group confirmation", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog(null, "kill-group");

      expect(store.state.confirmMode).toBe(true);
      expect(store.state.confirmSessionId).toBeNull();
      expect(store.state.confirmAction).toBe("kill-group");
    });

    it("should show restart confirmation for a session", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog("s1", "restart");

      expect(store.state.confirmMode).toBe(true);
      expect(store.state.confirmSessionId).toBe("s1");
      expect(store.state.confirmAction).toBe("restart");
    });

    it("should default action to kill", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog("s1");

      expect(store.state.confirmAction).toBe("kill");
    });

    it("should reset all confirm state on hide", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showConfirmDialog("s1", "restart");
      store.actions.hideConfirmDialog();

      expect(store.state.confirmMode).toBe(false);
      expect(store.state.confirmSessionId).toBeNull();
      expect(store.state.confirmAction).toBeNull();
    });
  });

  describe("contextMenu", () => {
    it("should default to null", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.state.contextMenu).toBeNull();
    });

    it("should store sessionId and coordinates via showContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showContextMenu("s1", 12, 34);

      expect(store.state.contextMenu).toEqual({
        sessionId: "s1",
        x: 12,
        y: 34,
      });
    });

    it("should clear contextMenu via hideContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showContextMenu("s1", 5, 6);
      store.actions.hideContextMenu();

      expect(store.state.contextMenu).toBeNull();
    });

    it("should overwrite an existing menu when reopened on another session", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showContextMenu("s1", 1, 2);
      store.actions.showContextMenu("s2", 9, 8);

      expect(store.state.contextMenu).toEqual({
        sessionId: "s2",
        x: 9,
        y: 8,
      });
    });

    it("should close groupContextMenu when opening sessionContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showGroupContextMenu("gk", 3, 4);
      store.actions.showContextMenu("s1", 1, 2);

      expect(store.state.contextMenu).toEqual({
        sessionId: "s1",
        x: 1,
        y: 2,
      });
      expect(store.state.groupContextMenu).toBeNull();
    });
  });

  describe("groupContextMenu", () => {
    it("should default to null", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.state.groupContextMenu).toBeNull();
    });

    it("should store groupKey and coordinates via showGroupContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showGroupContextMenu("ccmux", 12, 34);

      expect(store.state.groupContextMenu).toEqual({
        groupKey: "ccmux",
        x: 12,
        y: 34,
      });
    });

    it("should clear groupContextMenu via hideGroupContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showGroupContextMenu("ccmux", 5, 6);
      store.actions.hideGroupContextMenu();

      expect(store.state.groupContextMenu).toBeNull();
    });

    it("should close sessionContextMenu when opening groupContextMenu", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.showContextMenu("s1", 1, 2);
      store.actions.showGroupContextMenu("gk", 3, 4);

      expect(store.state.groupContextMenu).toEqual({
        groupKey: "gk",
        x: 3,
        y: 4,
      });
      expect(store.state.contextMenu).toBeNull();
    });
  });

  describe("activePaneId", () => {
    it("should default to null", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.state.activePaneId).toBeNull();
    });

    it("should store pane id via setActivePaneId", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setActivePaneId("%5");
      expect(store.state.activePaneId).toBe("%5");
    });

    it("should allow clearing back to null", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setActivePaneId("%5");
      store.actions.setActivePaneId(null);
      expect(store.state.activePaneId).toBeNull();
    });
  });

  describe("help overlay", () => {
    it("should default to hidden", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.state.showHelp).toBe(false);
    });

    it("should toggle help on/off", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.toggleHelp();
      expect(store.state.showHelp).toBe(true);
      store.actions.toggleHelp();
      expect(store.state.showHelp).toBe(false);
    });

    it("should hide help explicitly", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.toggleHelp();
      expect(store.state.showHelp).toBe(true);
      store.actions.hideHelp();
      expect(store.state.showHelp).toBe(false);
    });
  });

  describe("resizePreview", () => {
    it("should default to 40%", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.state.previewWidth).toBe(40);
    });

    it("should accept initial previewWidth option", () => {
      const store = createTUIStore({ previewWidth: 50 });
      expect(store.state.previewWidth).toBe(50);
    });

    it("should grow by delta", () => {
      const store = createTUIStore({ previewWidth: 35 });
      store.actions.resizePreview(5);
      expect(store.state.previewWidth).toBe(40);
    });

    it("should shrink by delta", () => {
      const store = createTUIStore({ previewWidth: 35 });
      store.actions.resizePreview(-5);
      expect(store.state.previewWidth).toBe(30);
    });

    it("should clamp at minimum 20%", () => {
      const store = createTUIStore({ previewWidth: 25 });
      store.actions.resizePreview(-10);
      expect(store.state.previewWidth).toBe(20);
    });

    it("should clamp at maximum 70%", () => {
      const store = createTUIStore({ previewWidth: 65 });
      store.actions.resizePreview(10);
      expect(store.state.previewWidth).toBe(70);
    });

    it("should not change when already at min", () => {
      const store = createTUIStore({ previewWidth: 20 });
      store.actions.resizePreview(-5);
      expect(store.state.previewWidth).toBe(20);
    });

    it("should not change when already at max", () => {
      const store = createTUIStore({ previewWidth: 70 });
      store.actions.resizePreview(5);
      expect(store.state.previewWidth).toBe(70);
    });
  });

  describe("togglePreview", () => {
    it("should default to hidden", () => {
      const store = createTUIStore();
      expect(store.state.showPreview).toBe(false);
    });

    it("should accept initialPreview option", () => {
      const store = createTUIStore({ initialPreview: true });
      expect(store.state.showPreview).toBe(true);
    });

    it("should toggle showPreview state", () => {
      const store = createTUIStore();
      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(true);
      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(false);
    });

    it("should exit preview focus when toggling off", () => {
      const store = createTUIStore({ initialPreview: true });
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);
      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(false);
      expect(store.state.previewFocused).toBe(false);
    });

    it("should persist showPreview state", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        onPersistState: (updates) => persisted.push(updates),
      });

      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(true);

      // Wait for debounced persistence (300ms)
      await waitForDebounce();
      expect(persisted).toContainEqual({ showPreview: true });

      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(false);

      await waitForDebounce();
      expect(persisted).toContainEqual({ showPreview: false });
    });
  });

  describe("hideIdle", () => {
    it("should default to false", () => {
      const store = createTUIStore();
      expect(store.state.hideIdle).toBe(false);
    });

    it("should accept hideIdle option", () => {
      const store = createTUIStore({ hideIdle: true });
      expect(store.state.hideIdle).toBe(true);
    });

    it("should toggle hideIdle state", () => {
      const store = createTUIStore();
      store.actions.toggleHideIdle();
      expect(store.state.hideIdle).toBe(true);
      store.actions.toggleHideIdle();
      expect(store.state.hideIdle).toBe(false);
    });

    it("should filter out idle sessions when enabled", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1", status: "idle" }),
        createMockSession({ id: "s2", status: "working" }),
        createMockSession({ id: "s3", status: "waiting" }),
      ]);

      expect(store.filteredSessions().length).toBe(3);

      store.actions.toggleHideIdle();
      const filtered = store.filteredSessions();
      expect(filtered.length).toBe(2);
      expect(filtered.map((f) => f.session.id)).toEqual(["s3", "s2"]);
    });

    it("should show all sessions when disabled", () => {
      const store = createTUIStore({ groupBy: "none", hideIdle: true });
      store.actions.setSessions([
        createMockSession({ id: "s1", status: "idle" }),
        createMockSession({ id: "s2", status: "working" }),
      ]);

      expect(store.filteredSessions().length).toBe(1);

      store.actions.toggleHideIdle();
      expect(store.filteredSessions().length).toBe(2);
    });

    it("should keep unread sessions visible when hiding idle", () => {
      const store = createTUIStore({ groupBy: "none", hideIdle: true });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          status: "idle",
          attentionState: "unread",
        }),
        createMockSession({ id: "s2", status: "idle" }),
        createMockSession({ id: "s3", status: "working" }),
      ]);

      const filtered = store.filteredSessions();
      expect(filtered.length).toBe(2);
      expect(filtered.map((f) => f.session.id)).toEqual(["s1", "s3"]);
    });

    it("should compose with search", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1", status: "idle", project: "my-app" }),
        createMockSession({ id: "s2", status: "working", project: "my-app" }),
        createMockSession({
          id: "s3",
          status: "working",
          project: "other-thing",
        }),
      ]);

      store.actions.toggleHideIdle();
      store.actions.setSearchQuery("my-app");
      const filtered = store.filteredSessions();
      expect(filtered.length).toBe(1);
      expect(filtered[0].session.id).toBe("s2");
    });

    it("should reset selection when toggling", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1", status: "idle" }),
        createMockSession({ id: "s2", status: "working" }),
      ]);
      // s1 (idle) and s2 (working) both have priority 1, input order preserved
      store.actions.setSelectedIndex(0);
      expect(store.state.selectedSessionId).toBe("s1");

      store.actions.toggleHideIdle();
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("should persist hideIdle state", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        onPersistState: (updates) => persisted.push(updates),
      });

      store.actions.toggleHideIdle();
      expect(store.state.hideIdle).toBe(true);

      // Wait for debounced persistence (300ms)
      await waitForDebounce();
      expect(persisted).toContainEqual({ hideIdle: true });

      store.actions.toggleHideIdle();
      expect(store.state.hideIdle).toBe(false);

      await waitForDebounce();
      expect(persisted).toContainEqual({ hideIdle: false });
    });
  });

  describe("promptDisplay", () => {
    it("should default to inline", () => {
      const store = createTUIStore();
      expect(store.state.promptDisplay).toBe("inline");
    });

    it("should accept promptDisplay option", () => {
      const store = createTUIStore({ promptDisplay: "row2" });
      expect(store.state.promptDisplay).toBe("row2");
    });

    it("should cycle inline -> row2 -> off -> inline", () => {
      const store = createTUIStore();
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("row2");
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("off");
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("inline");
    });

    it("should cycle only the two visible states in the sidebar (row2 <-> off)", () => {
      // The narrow rail can't inline, so inline renders the same as row2;
      // cycling skips it and treats a stored inline as row2 so every press
      // changes the rendering.
      const store = createTUIStore({ sidebar: true });
      expect(store.state.promptDisplay).toBe("inline");
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("off");
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("row2");
      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("off");
    });

    it("should persist promptDisplay state", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        onPersistState: (updates) => persisted.push(updates),
      });

      store.actions.cyclePrompt();
      expect(store.state.promptDisplay).toBe("row2");

      // Wait for debounced persistence (300ms)
      await waitForDebounce();
      expect(persisted).toContainEqual({ promptDisplay: "row2" });
    });

    it("should apply promptDisplay from reloaded UI state", () => {
      const store = createTUIStore();
      store.actions.reloadUIState({ promptDisplay: "off" });
      expect(store.state.promptDisplay).toBe("off");
    });

    it("does not re-run the legacy showPrompt migration on reload (launch owns it)", () => {
      // A store launched with a config-resolved mode (e.g. row2) must not be
      // flipped to off by a reload carrying a stale legacy showPrompt:false.
      // Migration is a one-time launch concern; reload only syncs an explicit
      // promptDisplay written by the `p` key, so the config default can't be
      // clobbered by a leftover legacy flag.
      const store = createTUIStore({ promptDisplay: "row2" });
      store.actions.reloadUIState({ showPrompt: false });
      expect(store.state.promptDisplay).toBe("row2");
    });

    it("should leave promptDisplay unchanged when reload carries neither promptDisplay nor showPrompt:false", () => {
      const store = createTUIStore({ promptDisplay: "row2" });
      // Legacy showPrompt:true (prompt was on) does not migrate, and an
      // unrelated reload must not clobber the current mode back to a default.
      store.actions.reloadUIState({ showPrompt: true, hideIdle: true });
      expect(store.state.promptDisplay).toBe("row2");
    });
  });

  describe("cycleGroupBy", () => {
    it("should default to project", () => {
      const store = createTUIStore();
      expect(store.state.groupBy).toBe("project");
    });

    it("should accept groupBy option", () => {
      const store = createTUIStore({ groupBy: "cwd" });
      expect(store.state.groupBy).toBe("cwd");
    });

    it("should cycle through all groupBy values", () => {
      const store = createTUIStore();
      expect(store.state.groupBy).toBe("project");

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("cwd");

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("session");

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("window");

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("none");

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("project");
    });

    it("should reset selection when cycling", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);
      store.actions.setSelectedIndex(1);
      expect(store.state.selectedSessionId).toBe("s2");

      store.actions.cycleGroupBy();
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("should persist groupBy and clear collapsed/pinned groups", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        onPersistState: (updates) => persisted.push(updates),
      });

      store.actions.cycleGroupBy();
      expect(store.state.groupBy).toBe("cwd");

      await waitForDebounce();
      expect(persisted).toContainEqual({
        groupBy: "cwd",
        collapsedGroups: [],
        pinnedGroups: [],
      });
    });
  });

  describe("selection", () => {
    it("should default to first session when no ID set", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "a" }),
        createMockSession({ id: "b", project: "b" }),
      ]);

      expect(store.selectedIndex()).toBe(0);
      expect(store.selectedSession()?.id).toBe("a");
    });

    it("should track selection by ID through status changes", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "idle",
        lastUserInputAt: "2024-01-01T12:30:00Z",
      });
      const s2 = createMockSession({
        id: "s2",
        status: "idle",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      store.actions.setSessions([s1, s2]);

      // Select second item
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("s2");

      // s1 transitions to working — same tier, no reorder
      store.actions.updateSession({ ...s1, status: "working" });
      expect(store.selectedSession()?.id).toBe("s2");
      expect(store.selectedIndex()).toBe(1);
    });

    it("should keep selection when working↔idle transitions don't reorder", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "working",
        lastUserInputAt: "2024-01-01T13:00:00Z",
      });
      const s2 = createMockSession({
        id: "s2",
        status: "idle",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      store.actions.setSessions([s1, s2]);

      // Select s1
      expect(store.selectedSession()?.id).toBe("s1");

      // s1 goes idle — still same tier, order unchanged
      store.actions.updateSession({ ...s1, status: "idle" });
      expect(store.selectedSession()?.id).toBe("s1");
      expect(store.selectedIndex()).toBe(0);
    });

    it("should follow selection when waiting causes reorder", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "idle",
        lastUserInputAt: "2024-01-01T13:00:00Z",
      });
      const s2 = createMockSession({
        id: "s2",
        status: "idle",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      store.actions.setSessions([s1, s2]);

      // Select s2 at index 1
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("s2");
      expect(store.selectedIndex()).toBe(1);

      // s2 transitions to waiting — floats to top
      store.actions.updateSession({
        ...s2,
        status: "waiting",
        attentionType: "permission",
      });
      expect(store.selectedSession()?.id).toBe("s2");
      expect(store.selectedIndex()).toBe(0);
    });

    it("moveSelection should navigate correctly", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
        createMockSession({ id: "c", lastUserInputAt: "2024-01-01T11:00:00Z" }),
      ]);

      expect(store.selectedIndex()).toBe(0);
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("b");
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("c");
      // Clamp at end
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("c");
      // Go back
      store.actions.moveSelection(-1);
      expect(store.selectedSession()?.id).toBe("b");
    });

    it("moveSelection should clamp at beginning", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      store.actions.moveSelection(-1);
      expect(store.selectedIndex()).toBe(0);
    });

    it("setSelectedIndex should set selection by ID", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
      ]);

      store.actions.setSelectedIndex(1);
      expect(store.selectedSession()?.id).toBe("b");
    });

    it("should reset to first when selected session is removed", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
      ]);

      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("b");

      store.actions.removeSession("b");
      expect(store.selectedSession()?.id).toBe("a");
      expect(store.selectedIndex()).toBe(0);
    });

    it("should reset to first when setSessions drops selected", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("b");

      // Replace sessions without "b"
      store.actions.setSessions([createMockSession({ id: "a" })]);
      expect(store.selectedSession()?.id).toBe("a");
      expect(store.selectedIndex()).toBe(0);
    });

    it("should reset selection when search query changes", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("b");

      store.actions.setSearchQuery("alpha");
      expect(store.selectedIndex()).toBe(0);
    });

    it("should reset selection on exitSearchMode", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveSelection(1);
      store.actions.enterSearchMode();
      store.actions.setSearchQuery("beta");
      store.actions.exitSearchMode();

      expect(store.state.selectedSessionId).toBeNull();
      expect(store.selectedIndex()).toBe(0);
    });

    it("should return -1 index for empty list", () => {
      const store = createTUIStore({ groupBy: "none" });
      expect(store.selectedIndex()).toBe(-1);
      expect(store.selectedSession()).toBeNull();
    });

    it("should return correct session by ID even when sorted list reorders", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "waiting",
        attentionType: "permission",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      const s2 = createMockSession({
        id: "s2",
        status: "idle",
        lastUserInputAt: "2024-01-01T13:00:00Z",
      });
      store.actions.setSessions([s1, s2]);

      // Explicitly select s1 (waiting, at index 0)
      store.actions.setSelectedIndex(0);
      expect(store.selectedSession()?.id).toBe("s1");

      // s1 transitions waiting → working (sort priority changes from 0 to 1)
      // s2 (idle, priority 1) stays at priority 1, but s1 now also priority 1
      // s2 has newer lastUserInputAt so it sorts first
      store.actions.updateSession({
        ...s1,
        status: "working",
        attentionType: null,
      });

      // selectedSession still returns s1 via direct ID lookup
      expect(store.selectedSession()?.id).toBe("s1");
      // But selectedIndex reflects s1's new position in the sorted list
      expect(store.selectedIndex()).toBe(1);
    });

    it("should stay pinned to session during preview focus when status reorders list", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "waiting",
        attentionType: "permission",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      const s2 = createMockSession({
        id: "s2",
        status: "idle",
        lastUserInputAt: "2024-01-01T13:00:00Z",
      });
      store.actions.setSessions([s1, s2]);

      // Select s1 and enter preview focus (simulating user tabbing into preview)
      store.actions.setSelectedIndex(0);
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);
      expect(store.selectedSession()?.id).toBe("s1");

      // User approves a tool — session transitions waiting → working
      store.actions.updateSession({
        ...s1,
        status: "working",
        attentionType: null,
      });

      // Preview stays pinned to s1 despite reorder
      expect(store.state.previewFocused).toBe(true);
      expect(store.selectedSession()?.id).toBe("s1");
      expect(store.selectedSession()?.status).toBe("working");
    });

    it("should reflect updated session data via direct ID lookup", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({
        id: "s1",
        status: "idle",
        project: "old-name",
      });
      store.actions.setSessions([s1]);
      store.actions.setSelectedIndex(0);

      expect(store.selectedSession()?.project).toBe("old-name");

      store.actions.updateSession({
        ...s1,
        project: "new-name",
        status: "working",
      });

      expect(store.selectedSession()?.project).toBe("new-name");
      expect(store.selectedSession()?.status).toBe("working");
    });

    it("should preserve sibling sessions when updating one session", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({ id: "s1", project: "proj-a" });
      const s2 = createMockSession({ id: "s2", project: "proj-b" });
      const s3 = createMockSession({ id: "s3", project: "proj-c" });
      store.actions.setSessions([s1, s2, s3]);

      store.actions.updateSession({ ...s2, status: "working" });

      // Sibling sessions should be untouched
      expect(store.state.sessions[0].project).toBe("proj-a");
      expect(store.state.sessions[0].status).toBe("idle");
      expect(store.state.sessions[1].status).toBe("working");
      expect(store.state.sessions[2].project).toBe("proj-c");
      expect(store.state.sessions[2].status).toBe("idle");
    });

    it("should no-op when updating a non-existent session", () => {
      const store = createTUIStore({ groupBy: "none" });
      const s1 = createMockSession({ id: "s1" });
      store.actions.setSessions([s1]);

      const ghost = createMockSession({ id: "ghost", project: "phantom" });
      store.actions.updateSession(ghost);

      expect(store.state.sessions).toHaveLength(1);
      expect(store.state.sessions[0].id).toBe("s1");
    });

    it("should fall back to first filtered session when selectedSessionId is null", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
      ]);

      expect(store.state.selectedSessionId).toBeNull();
      expect(store.selectedSession()?.id).toBe("a");
    });
  });

  describe("preview focus on session removal", () => {
    it("removeSession should exit preview focus when focused session is removed", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
      ]);

      // Select and focus preview on "b"
      store.actions.moveSelection(1);
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);
      expect(store.selectedSession()?.id).toBe("b");

      // Remove the focused session
      store.actions.removeSession("b");
      expect(store.state.previewFocused).toBe(false);
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("removeSession should not exit preview focus when a different session is removed", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", lastUserInputAt: "2024-01-01T13:00:00Z" }),
        createMockSession({ id: "b", lastUserInputAt: "2024-01-01T12:00:00Z" }),
      ]);

      // Focus preview on "a"
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);

      // Remove a different session
      store.actions.removeSession("b");
      expect(store.state.previewFocused).toBe(true);
      expect(store.selectedSession()?.id).toBe("a");
    });

    it("setSessions should exit preview focus when focused session is dropped", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      // Select and focus preview on "b"
      store.actions.moveSelection(1);
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);

      // Replace sessions without "b"
      store.actions.setSessions([createMockSession({ id: "a" })]);
      expect(store.state.previewFocused).toBe(false);
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("setSessions should not exit preview focus when focused session is retained", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      // Focus preview on "a"
      store.actions.enterPreviewFocus();
      expect(store.state.previewFocused).toBe(true);

      // Replace sessions, keeping "a"
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "c" }),
      ]);
      expect(store.state.previewFocused).toBe(true);
      expect(store.selectedSession()?.id).toBe("a");
    });
  });

  describe("filteredSessions (fuzzy search)", () => {
    it("should match on project name", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "my-app" }),
        createMockSession({ id: "s2", project: "other-thing" }),
      ]);

      store.actions.setSearchQuery("my-app");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      expect(filtered[0].session.id).toBe("s1");
    });

    it("should match on gitBranch", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          gitBranch: "feat/login",
        }),
        createMockSession({
          id: "s2",
          project: "proj",
          gitBranch: "main",
        }),
      ]);

      store.actions.setSearchQuery("login");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      expect(filtered[0].session.id).toBe("s1");
    });

    it("should not match on tmuxTarget", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          tmuxTarget: "main:0.1",
          gitBranch: null,
        }),
      ]);

      store.actions.setSearchQuery("main:0.1");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(0);
    });

    it("should return all sessions when search is empty", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);

      store.actions.setSearchQuery("");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(2);
    });

    it("should include paneMatch: false when no pane search results", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "my-app" }),
      ]);

      store.actions.setSearchQuery("my-app");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      expect(filtered[0].paneMatch).toBe(false);
    });

    it("should include paneMatch: false for all results when query is empty", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);

      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(2);
      expect(filtered[0].paneMatch).toBe(false);
      expect(filtered[1].paneMatch).toBe(false);
    });

    it("should not crash when searchPaneContent is disabled", () => {
      const store = createTUIStore({ searchPaneContent: false });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "my-app", tmuxPane: "%1" }),
      ]);

      store.actions.setSearchQuery("my-app");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      expect(filtered[0].paneMatch).toBe(false);
    });

    it("unions transcript matches from /search and sets transcriptMatch/transcriptSnippet", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              {
                sessionId: "s1",
                matches: [{ role: "user", snippet: "matched transcript text" }],
              },
            ],
          }),
        }) as unknown as Response) as unknown as typeof fetch;
      try {
        const store = createTUIStore({ groupBy: "none" });
        store.actions.setSessions([
          // Neither session matches the query on metadata; only s1 matches via
          // the mocked transcript search.
          createMockSession({ id: "s1", project: "zzz", gitBranch: null }),
          createMockSession({ id: "s2", project: "yyy", gitBranch: null }),
        ]);
        store.actions.setSearchQuery("transcript");
        await waitForDebounce();

        const filtered = store.filteredSessions();
        const s1 = filtered.find((f) => f.session.id === "s1");
        expect(s1).toBeDefined();
        expect(s1!.transcriptMatch).toBe(true);
        expect(s1!.transcriptSnippet).toBe("matched transcript text");
        expect(filtered.some((f) => f.session.id === "s2")).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("discards a superseded /search response that resolves out of order (generation guard)", async () => {
      const origFetch = globalThis.fetch;
      // Each query's fetch is held open until we resolve it by hand, so we can
      // land query A's response AFTER query B's and prove the gen guard drops
      // the stale one.
      const resolvers: Record<string, () => void> = {};
      const resultsFor: Record<string, unknown> = {
        alpha: [{ sessionId: "sa", matches: [{ role: "user", snippet: "A" }] }],
        beta: [{ sessionId: "sb", matches: [{ role: "user", snippet: "B" }] }],
      };
      globalThis.fetch = ((url: string) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        return new Promise((resolve) => {
          resolvers[q] = () =>
            resolve({
              ok: true,
              json: async () => ({ results: resultsFor[q] }),
            } as unknown as Response);
        });
      }) as unknown as typeof fetch;

      const settle = () => new Promise((r) => setTimeout(r, 20));

      try {
        const store = createTUIStore({ groupBy: "none" });
        store.actions.setSessions([
          createMockSession({ id: "sa", project: "zzz", gitBranch: null }),
          createMockSession({ id: "sb", project: "yyy", gitBranch: null }),
        ]);

        // Query A fires and its fetch is now in flight (held open).
        store.actions.setSearchQuery("alpha");
        await waitForDebounce();
        // Query B supersedes A; B's fetch fires and we resolve it first.
        store.actions.setSearchQuery("beta");
        await waitForDebounce();
        resolvers.beta();
        await settle();
        // A resolves LATE. The gen guard must drop it (query is now "beta").
        resolvers.alpha();
        await settle();

        const filtered = store.filteredSessions();
        // Cache reflects B, not the stale A response.
        expect(filtered.some((f) => f.session.id === "sb")).toBe(true);
        expect(filtered.some((f) => f.session.id === "sa")).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("does not fetch /search when searchTranscript is disabled", async () => {
      const origFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                sessionId: "s1",
                matches: [{ role: "user", snippet: "matched transcript text" }],
              },
            ],
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      try {
        const store = createTUIStore({
          groupBy: "none",
          searchTranscript: false,
        });
        store.actions.setSessions([
          // Metadata doesn't match "transcript"; only the (disabled) /search
          // path could match it.
          createMockSession({ id: "s1", project: "zzz", gitBranch: null }),
        ]);
        store.actions.setSearchQuery("transcript");
        await waitForDebounce();

        expect(fetchCalled).toBe(false);
        // The transcript cache never got populated, so s1 has no match path.
        const filtered = store.filteredSessions();
        expect(filtered.some((f) => f.session.id === "s1")).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("passes the configured searchPaneLines through to capturePane", async () => {
      capturePaneSpy.mockClear();
      const store = createTUIStore({ groupBy: "none", searchPaneLines: 250 });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "zzz",
          gitBranch: null,
          tmuxPane: "%1",
        }),
      ]);
      store.actions.setSearchQuery("zzz");
      await waitForDebounce();

      expect(capturePaneSpy).toHaveBeenCalledWith("%1", 250);
    });

    it("defaults searchPaneLines to 100 when omitted", async () => {
      capturePaneSpy.mockClear();
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "zzz",
          gitBranch: null,
          tmuxPane: "%1",
        }),
      ]);
      store.actions.setSearchQuery("zzz");
      await waitForDebounce();

      expect(capturePaneSpy).toHaveBeenCalledWith("%1", 100);
    });

    it("matches an older prompt by substring with a single-span highlight when lastPrompt did not match", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          cwd: "/tmp/s1",
          gitBranch: null,
          // The query is absent from the newest prompt ("deploy"), so only
          // the older prompt matches (by substring, not fuzzy).
          lastPrompt: "deploy",
          prompts: ["please refactor the parser", "deploy"],
        }),
      ]);

      store.actions.setSearchQuery("refactor the parser");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      expect(filtered[0].session.id).toBe("s1");
      // Substring match: exactly one contiguous <b> span around the query,
      // not scattered fuzzy characters.
      expect(filtered[0].highlights?.prompts).toBe(
        "please <b>refactor the parser</b>",
      );
      // The newest prompt itself did not match the query.
      expect(filtered[0].highlights?.lastPrompt).toBeNull();
    });

    it("normalizes a multi-line prompt to a single line before matching/highlighting", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          cwd: "/tmp/s1",
          gitBranch: null,
          lastPrompt: "unrelated newest",
          prompts: ["line one\nfind MERGEABLE here\nline three"],
        }),
      ]);

      store.actions.setSearchQuery("mergeable");
      const filtered = store.filteredSessions();

      expect(filtered.length).toBe(1);
      const highlighted = filtered[0].highlights?.prompts;
      // Single line (embedded newlines collapsed) with the <b> span intact,
      // so it can't wrap/overlap in the height-1 row.
      expect(highlighted).toBe(
        "line one find <b>MERGEABLE</b> here line three",
      );
      expect(highlighted).not.toContain("\n");
    });

    it("highlights a lastPrompt substring hit as a single normalized span", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          cwd: "/tmp/s1",
          gitBranch: null,
          // Multi-line lastPrompt (task notification): normalized to one line.
          lastPrompt: "review this\nMERGEABLE check\ndone",
          prompts: ["review this\nMERGEABLE check\ndone"],
        }),
      ]);

      store.actions.setSearchQuery("mergeable");
      const hl = store.filteredSessions()[0].highlights?.lastPrompt;
      // One clean bold span on normalized text, not fuzzysort scatter markup.
      expect(hl).toBe("review this <b>MERGEABLE</b> check done");
      expect(hl).not.toContain("\n");
    });

    it("renders no lastPrompt highlight for a scatter-only fuzzy match (membership only)", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "s1",
          project: "proj",
          cwd: "/tmp/s1",
          gitBranch: null,
          // Contains m,e,r,g,e,a,b,l,e as a scattered subsequence (fuzzysort
          // matches it, so the row is a member) but NOT the substring
          // "mergeable", so nothing should render highlighted.
          lastPrompt: "make every rug generate a big lovely edge",
          prompts: ["make every rug generate a big lovely edge"],
        }),
      ]);

      store.actions.setSearchQuery("mergeable");
      const filtered = store.filteredSessions();
      // Fuzzy match still makes it a member...
      expect(filtered.map((f) => f.session.id)).toEqual(["s1"]);
      // ...but the scatter-only hit renders no highlight (plain lastPrompt).
      expect(filtered[0].highlights?.lastPrompt).toBeNull();
      expect(filtered[0].highlights?.prompts).toBeNull();
    });

    it("does not scatter-match a prompt (substring, not fuzzy, over the prompt index)", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({
          id: "hit",
          project: "proj",
          cwd: "/tmp/hit",
          gitBranch: null,
          lastPrompt: "is this mergeable now",
          prompts: ["is this mergeable now"],
        }),
        createMockSession({
          id: "scatter",
          project: "proj",
          cwd: "/tmp/scatter",
          gitBranch: null,
          // lastPrompt (a fuzzy key) has no relation to the query; the only
          // link is the prompt "merge available table", which contains
          // m,e,r,g,e,a,b,l,e as a scattered subsequence but NOT the contiguous
          // substring "mergeable". Fuzzy over a joined haystack would have
          // matched it; substring must not.
          lastPrompt: "zzz",
          prompts: ["merge available table"],
        }),
      ]);

      store.actions.setSearchQuery("mergeable");
      const filtered = store.filteredSessions();

      expect(filtered.map((f) => f.session.id)).toEqual(["hit"]);
    });
  });

  describe("grouping", () => {
    it("should produce flat items with headers when groupBy is project", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "alpha" }),
        createMockSession({ id: "c", project: "beta" }),
      ]);

      const items = store.flatItems();
      // header(alpha) + 2 sessions + header(beta) + 1 session
      expect(items).toHaveLength(5);
      expect(items[0].type).toBe("header");
      expect(items[1].type).toBe("session");
      expect(items[2].type).toBe("session");
      expect(items[3].type).toBe("header");
      expect(items[4].type).toBe("session");
    });

    it("should produce flat items without headers when groupBy is none", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      const items = store.flatItems();
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.type === "session")).toBe(true);
    });

    it("should navigate through headers and sessions with moveSelection", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // items: [header(alpha), session(a), header(beta), session(b)]
      // Initial state: nothing explicitly selected, falls back to index 0
      expect(store.selectedIndex()).toBe(0);

      // Move to session(a)
      store.actions.moveSelection(1);
      expect(store.selectedIndex()).toBe(1);
      expect(store.selectedSession()?.id).toBe("a");

      // Move to header(beta)
      store.actions.moveSelection(1);
      expect(store.selectedIndex()).toBe(2);
      expect(store.selectedHeaderKey()).toBe("beta");

      // Move to session(b)
      store.actions.moveSelection(1);
      expect(store.selectedIndex()).toBe(3);
      expect(store.selectedSession()?.id).toBe("b");
    });

    it("should collapse and expand groups", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "alpha" }),
        createMockSession({ id: "c", project: "beta" }),
      ]);

      expect(store.flatItems()).toHaveLength(5);

      store.actions.toggleGroupCollapse("alpha");
      // header(alpha, collapsed) + header(beta) + session(c)
      expect(store.flatItems()).toHaveLength(3);

      store.actions.toggleGroupCollapse("alpha");
      expect(store.flatItems()).toHaveLength(5);
    });

    it("should move selection to header when collapsing group with selected child", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "alpha" }),
      ]);

      // Select session "a"
      store.actions.moveSelection(1); // move to first session
      expect(store.selectedSession()?.id).toBe("a");

      // Collapse the group
      store.actions.toggleGroupCollapse("alpha");
      expect(store.selectedHeaderKey()).toBe("alpha");
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("should collapse all and expand all", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // 2 headers + 2 sessions = 4
      expect(store.flatItems()).toHaveLength(4);

      store.actions.collapseAll();
      // 2 headers only
      expect(store.flatItems()).toHaveLength(2);

      store.actions.expandAll();
      expect(store.flatItems()).toHaveLength(4);
    });

    it("should collapse parent group from session", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "alpha" }),
      ]);

      // Select session "a"
      store.actions.moveSelection(1);
      expect(store.selectedSession()?.id).toBe("a");

      store.actions.collapseParent();
      expect(store.selectedHeaderKey()).toBe("alpha");
      expect(store.collapsedGroups().has("alpha")).toBe(true);
    });

    it("should restore collapsed groups from options", () => {
      const store = createTUIStore({
        groupBy: "project",
        collapsedGroups: ["alpha"],
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // alpha collapsed: header(alpha) + header(beta) + session(b) = 3
      expect(store.flatItems()).toHaveLength(3);
      expect(store.collapsedGroups().has("alpha")).toBe(true);
    });

    it("should persist collapsed groups on toggle", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "project",
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.toggleGroupCollapse("alpha");
      await waitForDebounce();
      expect(persisted).toContainEqual({ collapsedGroups: ["alpha"] });

      // Uncollapse should persist empty
      store.actions.toggleGroupCollapse("alpha");
      await waitForDebounce();
      expect(persisted).toContainEqual({ collapsedGroups: [] });
    });

    it("should persist collapsed groups on collapseAll and expandAll", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "project",
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.collapseAll();
      await waitForDebounce();
      const collapsed = persisted.find((p) => "collapsedGroups" in p);
      expect(collapsed?.collapsedGroups).toEqual(
        expect.arrayContaining(["alpha", "beta"]),
      );

      store.actions.expandAll();
      await waitForDebounce();
      expect(persisted).toContainEqual({ collapsedGroups: [] });
    });

    it("should persist collapsed groups on collapseParent", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "project",
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveSelection(1); // select session "a"
      store.actions.collapseParent();
      await waitForDebounce();
      const collapsed = persisted.find((p) => "collapsedGroups" in p);
      expect(collapsed?.collapsedGroups).toEqual(["alpha"]);
    });

    it("should persist collapsed groups on expandGroup", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "project",
        collapsedGroups: ["alpha", "beta"],
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.expandGroup("alpha");
      await waitForDebounce();
      expect(persisted).toContainEqual({ collapsedGroups: ["beta"] });
    });

    it("should prune stale collapsed groups on persist", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "project",
        collapsedGroups: ["stale-group"],
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
      ]);

      // Toggle alpha to trigger persistence; "stale-group" should be pruned
      store.actions.toggleGroupCollapse("alpha");
      await waitForDebounce();
      expect(persisted).toContainEqual({ collapsedGroups: ["alpha"] });
    });

    it("should move group up by swapping with group above", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Natural order: alpha, beta, charlie (all idle, alphabetical)
      const headersBefore = store
        .flatItems()
        .filter((i) => i.type === "header");
      expect(
        headersBefore[0].type === "header" && headersBefore[0].groupKey,
      ).toBe("alpha");

      // Move beta up: swaps with alpha -> beta, alpha, charlie
      store.actions.moveGroupUp("beta");

      const headersAfter = store.flatItems().filter((i) => i.type === "header");
      expect(
        headersAfter[0].type === "header" && headersAfter[0].groupKey,
      ).toBe("beta");
      expect(
        headersAfter[1].type === "header" && headersAfter[1].groupKey,
      ).toBe("alpha");
      expect(
        headersAfter[2].type === "header" && headersAfter[2].groupKey,
      ).toBe("charlie");
    });

    it("should move group down by swapping with group below", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Move alpha down: swaps with beta -> beta, alpha, charlie
      store.actions.moveGroupDown("alpha");

      const headersAfter = store.flatItems().filter((i) => i.type === "header");
      expect(
        headersAfter[0].type === "header" && headersAfter[0].groupKey,
      ).toBe("beta");
      expect(
        headersAfter[1].type === "header" && headersAfter[1].groupKey,
      ).toBe("alpha");
      expect(
        headersAfter[2].type === "header" && headersAfter[2].groupKey,
      ).toBe("charlie");
    });

    it("should unpin groups when moved back to natural position", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Move beta up (out of natural order)
      store.actions.moveGroupUp("beta");
      expect(store.pinnedGroups().length).toBeGreaterThan(0);

      // Move beta back down (restores natural order)
      store.actions.moveGroupDown("beta");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should no-op when moving first group up", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
      ]);

      store.actions.moveGroupUp("alpha");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should no-op when moving last group down", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
      ]);

      store.actions.moveGroupDown("alpha");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should sort groups alphabetically regardless of status", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha", status: "idle" }),
        createMockSession({
          id: "b",
          project: "beta",
          status: "waiting",
          attentionType: "permission",
        }),
      ]);

      const headers = store.flatItems().filter((i) => i.type === "header");
      // alphabetical: alpha before beta, regardless of status
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("alpha");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe("beta");
    });

    it("should move a group multiple positions with repeated moves", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
        createMockSession({ id: "d", project: "delta" }),
      ]);

      // Natural: alpha, beta, charlie, delta
      // Move delta to the top with 3 successive moves up
      store.actions.moveGroupUp("delta");
      store.actions.moveGroupUp("delta");
      store.actions.moveGroupUp("delta");

      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("delta");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe("alpha");
      expect(headers[2].type === "header" && headers[2].groupKey).toBe("beta");
      expect(headers[3].type === "header" && headers[3].groupKey).toBe(
        "charlie",
      );

      // Extra move up should no-op (already at top)
      store.actions.moveGroupUp("delta");
      const headersAfter = store.flatItems().filter((i) => i.type === "header");
      expect(
        headersAfter[0].type === "header" && headersAfter[0].groupKey,
      ).toBe("delta");
    });

    it("should move groups when some are collapsed", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "alpha" }),
        createMockSession({ id: "c", project: "beta" }),
        createMockSession({ id: "d", project: "charlie" }),
      ]);

      // Collapse alpha (hides its 2 sessions)
      store.actions.toggleGroupCollapse("alpha");
      const itemsBefore = store.flatItems();
      // header(alpha, collapsed) + header(beta) + session(c) + header(charlie) + session(d)
      expect(itemsBefore).toHaveLength(5);

      // Move charlie up past beta
      store.actions.moveGroupUp("charlie");

      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("alpha");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe(
        "charlie",
      );
      expect(headers[2].type === "header" && headers[2].groupKey).toBe("beta");

      // Alpha should still be collapsed
      expect(store.collapsedGroups().has("alpha")).toBe(true);
    });

    it("should allow moving groups during search but operate on filtered groups", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha", cwd: "/path/alpha" }),
        createMockSession({ id: "b", project: "beta", cwd: "/path/beta" }),
        createMockSession({
          id: "c",
          project: "charlie",
          cwd: "/path/charlie",
        }),
      ]);

      // Search filters to matching sessions only
      store.actions.setSearchQuery("alpha");
      const filtered = store.filteredSessions();
      expect(filtered.length).toBe(1);

      // Only one group visible during search, move is a no-op
      store.actions.moveGroupUp("alpha");
      expect(store.pinnedGroups()).toEqual([]);

      // Exit search, verify original groups are intact
      store.actions.exitSearchMode();
      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers).toHaveLength(3);
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("alpha");
    });

    it("should follow selection when moving group multiple times", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Move charlie up twice - selection should follow
      store.actions.moveGroupUp("charlie");
      expect(store.selectedHeaderKey()).toBe("charlie");

      store.actions.moveGroupUp("charlie");
      expect(store.selectedHeaderKey()).toBe("charlie");

      // charlie is now at position 0
      expect(store.selectedIndex()).toBe(0);
    });

    it("should prune stale pinned keys when sessions are removed", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Pin beta to top
      store.actions.moveGroupUp("beta");
      expect(store.pinnedGroups().includes("beta")).toBe(true);

      // Remove all beta sessions
      store.actions.removeSession("b");

      // Move alpha down to trigger computePinnedFromOrder (which prunes stale keys)
      store.actions.moveGroupDown("alpha");

      // beta should be pruned from pinned since it has no sessions
      expect(store.pinnedGroups().includes("beta")).toBe(false);
    });

    it("should compute minimal pinned set (only pin what differs from natural order)", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
        createMockSession({ id: "d", project: "delta" }),
      ]);

      // Natural order: alpha, beta, charlie, delta
      // Move beta above alpha: beta, alpha, charlie, delta
      // Only beta and alpha need pinning (charlie and delta match natural tail)
      store.actions.moveGroupUp("beta");
      expect(store.pinnedGroups()).toEqual(["beta", "alpha"]);
    });

    it("should clear all pins when order matches natural order", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Move beta up: beta, alpha (pinned: ["beta", "alpha"])
      store.actions.moveGroupUp("beta");
      expect(store.pinnedGroups().length).toBeGreaterThan(0);

      // Move beta back down: alpha, beta (matches natural, pins cleared)
      store.actions.moveGroupDown("beta");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should handle moving with groupBy none as no-op", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveGroupUp("alpha");
      store.actions.moveGroupDown("beta");
      expect(store.pinnedGroups()).toEqual([]);
      // No headers in flat items
      expect(store.flatItems().every((i) => i.type === "session")).toBe(true);
    });

    it("should preserve pinned order across session additions", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Pin beta first
      store.actions.moveGroupUp("beta");
      const headersBefore = store
        .flatItems()
        .filter((i) => i.type === "header");
      expect(
        headersBefore[0].type === "header" && headersBefore[0].groupKey,
      ).toBe("beta");

      // Add a new session in a new group
      store.actions.addSession(
        createMockSession({ id: "c", project: "charlie" }),
      );

      // beta should still be first (pinned), then alpha, then charlie (alphabetical unpinned)
      const headersAfter = store.flatItems().filter((i) => i.type === "header");
      expect(
        headersAfter[0].type === "header" && headersAfter[0].groupKey,
      ).toBe("beta");
      expect(
        headersAfter[1].type === "header" && headersAfter[1].groupKey,
      ).toBe("alpha");
      expect(
        headersAfter[2].type === "header" && headersAfter[2].groupKey,
      ).toBe("charlie");
    });

    it("should move group when triggered from a session row", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Move beta's group up via session id
      store.actions.moveGroupUp("beta", "b");

      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("beta");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe("alpha");
    });

    it("should preserve session selection when moving from a session row", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Select session b (index 1 = header(alpha), 2 = session(a), 3 = header(beta), 4 = session(b))
      store.actions.setSelectedIndex(3); // header(beta)
      store.actions.moveSelection(1); // session(b)
      store.actions.moveGroupUp("beta", "b");

      // Selection should stay on the session, not jump to header
      expect(store.state.selectedSessionId).toBe("b");
      expect(store.selectedHeaderKey()).toBeNull();
    });

    it("should move group down when triggered from a session row", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Move alpha's group down via session id
      store.actions.moveGroupDown("alpha", "a");

      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("beta");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe("alpha");

      // Selection stays on the session
      expect(store.state.selectedSessionId).toBe("a");
      expect(store.selectedHeaderKey()).toBeNull();
    });

    it("should no-op at boundary when triggered from a session row", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Try moving last group down from session row
      store.actions.setSelectedIndex(3); // header(beta)
      store.actions.moveSelection(1); // session(b)
      store.actions.moveGroupDown("beta", "b");

      // Order unchanged
      const headers = store.flatItems().filter((i) => i.type === "header");
      expect(headers[0].type === "header" && headers[0].groupKey).toBe("alpha");
      expect(headers[1].type === "header" && headers[1].groupKey).toBe("beta");

      // Selection still on session b
      expect(store.state.selectedSessionId).toBe("b");
    });

    it("should select header when moving from a header row", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Move without sessionId (from header)
      store.actions.moveGroupUp("beta");

      expect(store.state.selectedSessionId).toBeNull();
      expect(store.selectedHeaderKey()).toBe("beta");
    });
  });

  describe("moveGroupToEdge", () => {
    it("should move group to top", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Natural order: alpha, beta, charlie
      store.actions.moveGroupToEdge("charlie", "top");

      expect(headerLabels(store.flatItems())).toEqual([
        "charlie",
        "alpha",
        "beta",
      ]);
    });

    it("should move group to bottom", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      // Natural order: alpha, beta, charlie
      store.actions.moveGroupToEdge("alpha", "bottom");

      expect(headerLabels(store.flatItems())).toEqual([
        "beta",
        "charlie",
        "alpha",
      ]);
    });

    it("should no-op when group is already at top", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveGroupToEdge("alpha", "top");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should no-op when group is already at bottom", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      store.actions.moveGroupToEdge("beta", "bottom");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should no-op when groupBy is none", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
      ]);

      store.actions.moveGroupToEdge("alpha", "top");
      expect(store.pinnedGroups()).toEqual([]);
    });

    it("should follow selection to moved group header", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      store.actions.moveGroupToEdge("charlie", "top");

      expect(store.selectedHeaderKey()).toBe("charlie");
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("should follow selection to session when sessionId is provided", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
        createMockSession({ id: "c", project: "charlie" }),
      ]);

      store.actions.moveGroupToEdge("charlie", "top", "c");

      expect(store.state.selectedSessionId).toBe("c");
      expect(store.selectedHeaderKey()).toBeNull();
    });
  });

  describe("group selection memos", () => {
    it("should return group header on initial load when first item is a header", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // No explicit selection yet, first item is header(alpha)
      expect(store.selectedIndex()).toBe(0);
      expect(store.selectedGroupHeader()?.groupKey).toBe("alpha");
      expect(store.selectedSession()).toBeNull();
      expect(store.selectedGroupSessions().map((s) => s.id)).toEqual(["a"]);
    });

    it("should return session on initial load when groupBy is none", () => {
      const store = createTUIStore({ groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      expect(store.selectedIndex()).toBe(0);
      expect(store.selectedGroupHeader()).toBeNull();
      expect(store.selectedSession()?.id).toBe("a");
      expect(store.selectedGroupSessions()).toEqual([]);
    });

    it("should return group header when header is explicitly selected", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Select header(beta) explicitly
      store.actions.setSelectedIndex(2); // header(beta)
      expect(store.selectedGroupHeader()?.groupKey).toBe("beta");
      expect(store.selectedSession()).toBeNull();
      expect(store.selectedGroupSessions().map((s) => s.id)).toEqual(["b"]);
    });

    it("should return session when session is explicitly selected", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a", project: "alpha" }),
        createMockSession({ id: "b", project: "beta" }),
      ]);

      // Select session(a)
      store.actions.setSelectedIndex(1); // session(a)
      expect(store.selectedGroupHeader()).toBeNull();
      expect(store.selectedSession()?.id).toBe("a");
      expect(store.selectedGroupSessions()).toEqual([]);
    });

    it("should return all group sessions for a multi-session group", () => {
      const store = createTUIStore({ groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "a1", project: "alpha" }),
        createMockSession({ id: "a2", project: "alpha" }),
        createMockSession({ id: "b1", project: "beta" }),
      ]);

      // Select header(alpha)
      store.actions.setSelectedIndex(0);
      expect(store.selectedGroupHeader()?.groupKey).toBe("alpha");
      expect(store.selectedGroupSessions().map((s) => s.id)).toEqual([
        "a1",
        "a2",
      ]);
    });
  });

  describe("sidebar mode", () => {
    it("forces showPreview false regardless of initialPreview", () => {
      const store = createTUIStore({ sidebar: true, initialPreview: true });
      expect(store.state.showPreview).toBe(false);
    });

    it("togglePreview is a no-op in sidebar mode", () => {
      const store = createTUIStore({ sidebar: true });
      expect(store.state.showPreview).toBe(false);
      store.actions.togglePreview();
      expect(store.state.showPreview).toBe(false);
    });

    it("reloadUIState updates groupBy", () => {
      const store = createTUIStore({ sidebar: true });
      expect(store.state.groupBy).toBe("project");
      store.actions.reloadUIState({ groupBy: "cwd" });
      expect(store.state.groupBy).toBe("cwd");
    });

    it("reloadUIState updates hideIdle", () => {
      const store = createTUIStore({ sidebar: true });
      expect(store.state.hideIdle).toBe(false);
      store.actions.reloadUIState({ hideIdle: true });
      expect(store.state.hideIdle).toBe(true);
    });

    it("reloadUIState updates collapsedGroups", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "alpha" }),
        createMockSession({ id: "s2", project: "beta" }),
      ]);
      expect(store.collapsedGroups().size).toBe(0);
      store.actions.reloadUIState({ collapsedGroups: ["alpha"] });
      expect(store.collapsedGroups().has("alpha")).toBe(true);
    });

    it("reloadUIState updates pinnedGroups", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "project" });
      store.actions.reloadUIState({ pinnedGroups: ["beta", "alpha"] });
      expect(store.pinnedGroups()).toEqual(["beta", "alpha"]);
    });

    it("reloadUIState ignores undefined fields", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "project" });
      store.actions.reloadUIState({});
      expect(store.state.groupBy).toBe("project");
      expect(store.state.hideIdle).toBe(false);
    });

    it("reloadUIState does not sync selectedSessionId", () => {
      const store = createTUIStore({ sidebar: true });
      store.actions.setSelectedSessionId("s1");

      // selectedSessionId is SSE-synced, not file-synced
      store.actions.reloadUIState({});

      expect(store.state.selectedSessionId).toBe("s1");
    });
  });

  describe("setSelectedSessionId", () => {
    it("should set value directly", () => {
      const store = createTUIStore();
      store.actions.setSelectedSessionId("s1");
      expect(store.state.selectedSessionId).toBe("s1");
      store.actions.setSelectedSessionId(null);
      expect(store.state.selectedSessionId).toBeNull();
    });

    it("selection via moveSelection should not persist selectedSessionId to file", async () => {
      const persisted: Record<string, unknown>[] = [];
      const store = createTUIStore({
        groupBy: "none",
        onPersistState: (updates) => persisted.push(updates),
      });
      store.actions.setSessions([
        createMockSession({ id: "a" }),
        createMockSession({ id: "b" }),
      ]);

      store.actions.moveSelection(1);
      await waitForDebounce();

      const hasSelectedSessionId = persisted.some(
        (p) => "selectedSessionId" in p,
      );
      expect(hasSelectedSessionId).toBe(false);
    });
  });

  describe("applySidebarSelection", () => {
    it("sets session selection from another sidebar", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);

      store.actions.applySidebarSelection("s2", null);

      expect(store.state.selectedSessionId).toBe("s2");
      expect(store.selectedHeaderKey()).toBeNull();
      expect(store.selectedIndex()).toBe(1);
    });

    it("sets header selection from another sidebar", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "alpha" }),
        createMockSession({ id: "s2", project: "beta" }),
      ]);

      store.actions.applySidebarSelection(null, "beta");

      expect(store.state.selectedSessionId).toBeNull();
      expect(store.selectedHeaderKey()).toBe("beta");
    });

    it("clears both when receiving null/null", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      store.actions.setSessions([createMockSession({ id: "s1" })]);
      store.actions.setSelectedSessionId("s1");

      store.actions.applySidebarSelection(null, null);

      expect(store.state.selectedSessionId).toBeNull();
      expect(store.selectedHeaderKey()).toBeNull();
    });

    it("atomically switches from header to session", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "project" });
      store.actions.setSessions([
        createMockSession({ id: "s1", project: "alpha" }),
        createMockSession({ id: "s2", project: "beta" }),
      ]);

      // Start on a header
      store.actions.applySidebarSelection(null, "alpha");
      expect(store.selectedHeaderKey()).toBe("alpha");

      // Switch to a session: both fields update atomically
      store.actions.applySidebarSelection("s2", null);
      expect(store.state.selectedSessionId).toBe("s2");
      expect(store.selectedHeaderKey()).toBeNull();
      // selectedIndex should never have been 0 (fallback) during transition
      expect(store.selectedIndex()).toBe(3); // header alpha, s1, header beta, s2
    });
  });

  describe("isSidebarVersionNewer", () => {
    it("treats undefined version as newer (legacy event)", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      expect(store.isSidebarVersionNewer(undefined)).toBe(true);
    });

    it("rejects version 0 before any local navigation", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      // Version starts at 0; an incoming 0 is not strictly greater
      expect(store.isSidebarVersionNewer(0)).toBe(false);
    });

    it("rejects stale versions after local navigation", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
        createMockSession({ id: "s3" }),
      ]);

      // Initial state: selectedSessionId is null, fallback shows s1.
      // moveSelection(1) selects s2 (version 1), then s3 (version 2).
      store.actions.moveSelection(1);
      store.actions.moveSelection(1);

      // Versions 1 and 2 are stale echo-backs of our own navigation
      expect(store.isSidebarVersionNewer(1)).toBe(false);
      expect(store.isSidebarVersionNewer(2)).toBe(false);
    });

    it("accepts version from another sidebar instance", () => {
      const store = createTUIStore({ sidebar: true, groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);

      // Local navigation: version goes to 1
      store.actions.moveSelection(1);

      // Another sidebar navigated further (version 5 > local 1)
      expect(store.isSidebarVersionNewer(5)).toBe(true);
    });

    it("increments version in non-sidebar mode (picker also broadcasts)", () => {
      const store = createTUIStore({ sidebar: false, groupBy: "none" });
      store.actions.setSessions([
        createMockSession({ id: "s1" }),
        createMockSession({ id: "s2" }),
      ]);

      store.actions.moveSelection(1);

      // Picker broadcasts too, so version increments
      expect(store.isSidebarVersionNewer(0)).toBe(false);
      expect(store.isSidebarVersionNewer(1)).toBe(false);
      expect(store.isSidebarVersionNewer(2)).toBe(true);
    });
  });
});
