import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { getDaemonUrl } from "../../lib/config";
import type {
  PruneCandidate,
  PruneRunResult,
  PruneScan,
} from "../../daemon/worktree-prune";
import { theme } from "../theme";

/**
 * The picker's worktree-prune surface (issue #68).
 *
 * Owns its own state and keyboard handling rather than pushing either into
 * the store: everything here is scoped to one open/close cycle, and App.tsx
 * simply stops handling keys while it is up (the same shape the help overlay
 * uses).
 *
 * The flow is deliberately three explicit steps — pick, then opt in to
 * anything dirty, then confirm — because the action deletes directories and
 * branches. Nothing is pre-selected: an empty selection is the default, and a
 * dirty row needs its own `D` on top of being selected. The daemon enforces
 * the same dirty gate independently, so this is the ergonomic half of the
 * rule, not the whole of it.
 */

type Phase = "loading" | "list" | "confirm" | "running" | "done" | "error";

interface PruneDialogProps {
  /** Main checkout to scope the scan to; null scans every known repo. */
  repo: string | null;
  /**
   * Sidebar widths (~40 cols) truncate the full hint line, and what gets cut
   * is the end — including the live "prune N" count, which is exactly the
   * feedback that tells the user a dirty row is being held back.
   */
  compact?: boolean;
  onClose: () => void;
}

/**
 * Split a selection into what will actually be removed and what the dirty
 * gate is holding back.
 *
 * Separated from the component (and exported) because it is the rule, not a
 * rendering detail: a selected worktree with uncommitted or untracked changes
 * is removed only if it ALSO carries its own opt-in. The daemon enforces the
 * same thing independently — this half exists so the dialog can say so before
 * the user commits, instead of reporting a refusal afterwards.
 */
export function partitionSelection(
  candidates: PruneCandidate[],
  selected: ReadonlySet<string>,
  dirtyOk: ReadonlySet<string>,
): { removable: PruneCandidate[]; blockedDirty: PruneCandidate[] } {
  const removable: PruneCandidate[] = [];
  const blockedDirty: PruneCandidate[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.path)) continue;
    if (candidate.dirty && !dirtyOk.has(candidate.path)) {
      blockedDirty.push(candidate);
    } else {
      removable.push(candidate);
    }
  }
  return { removable, blockedDirty };
}

/** Green for a proven merge, blue for the inferred one, peach for closed. */
function reasonColor(reason: PruneCandidate["reason"]): string {
  switch (reason) {
    case "pr-merged":
    case "merged-locally":
      return theme.green;
    case "upstream-gone":
      return theme.blue;
    case "pr-closed":
      return theme.peach;
  }
}

export const PruneDialog: Component<PruneDialogProps> = (props) => {
  const [phase, setPhase] = createSignal<Phase>("loading");
  const [scan, setScan] = createSignal<PruneScan>({
    candidates: [],
    skipped: [],
  });
  const [index, setIndex] = createSignal(0);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [dirtyOk, setDirtyOk] = createSignal<Set<string>>(new Set());
  const [result, setResult] = createSignal<PruneRunResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let listBox: ScrollBoxRenderable | undefined;
  let resultBox: ScrollBoxRenderable | undefined;

  const candidates = (): PruneCandidate[] => scan().candidates;

  const partition = createMemo(() =>
    partitionSelection(candidates(), selected(), dirtyOk()),
  );
  /** Selected rows that will actually be removed (dirty ones need `D`). */
  const effective = () => partition().removable;
  const blockedDirty = () => partition().blockedDirty;

  onMount(() => {
    const query = props.repo ? `?repo=${encodeURIComponent(props.repo)}` : "";
    fetch(`${getDaemonUrl()}/worktrees/prune-candidates${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as PruneScan;
        setScan(data);
        setPhase("list");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
  });

  function toggleSelected(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleDirtyOk(candidate: PruneCandidate): void {
    if (!candidate.dirty) return;
    setDirtyOk((prev) => {
      const next = new Set(prev);
      if (next.has(candidate.path)) next.delete(candidate.path);
      else next.add(candidate.path);
      return next;
    });
    // Opting in to losing the work is a strictly stronger statement than
    // selecting the row, so it implies the selection rather than requiring a
    // second keypress to express the same intent.
    setSelected((prev) => new Set(prev).add(candidate.path));
  }

  function runPrune(): void {
    const chosen = effective();
    setPhase("running");
    fetch(`${getDaemonUrl()}/worktrees/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: chosen.map((c) => c.path),
        allowDirty: chosen.filter((c) => c.dirty).map((c) => c.path),
        source: "picker",
        repo: props.repo,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as PruneRunResult & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error ?? `HTTP ${response.status}`);
        setResult(data);
        setPhase("done");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
  }

  useKeyboard((event: KeyEvent) => {
    const key = event.name;
    event.preventDefault();

    if (phase() === "running") return;

    if (phase() === "done" || phase() === "error") {
      if (
        key === "q" ||
        key === "escape" ||
        key === "return" ||
        key === "enter"
      ) {
        props.onClose();
      }
      if (resultBox && (key === "j" || key === "k")) {
        resultBox.scrollTo(resultBox.scrollTop + (key === "j" ? 1 : -1));
      }
      return;
    }

    if (phase() === "confirm") {
      if (key === "y" || key === "Y") runPrune();
      else if (key === "n" || key === "N" || key === "escape") setPhase("list");
      return;
    }

    const list = candidates();
    switch (key) {
      case "j":
      case "down":
        if (list.length > 0) setIndex((i) => Math.min(i + 1, list.length - 1));
        break;
      case "k":
      case "up":
        setIndex((i) => Math.max(i - 1, 0));
        break;
      case "space":
      case " ": {
        const candidate = list[index()];
        if (candidate) toggleSelected(candidate.path);
        break;
      }
      case "a":
        // "All" means all CLEAN rows: a bulk key must never be the thing that
        // opts a dirty worktree in.
        setSelected(new Set(list.filter((c) => !c.dirty).map((c) => c.path)));
        break;
      case "D":
      case "d": {
        const candidate = list[index()];
        if (candidate) toggleDirtyOk(candidate);
        break;
      }
      case "return":
      case "enter":
        if (effective().length > 0) setPhase("confirm");
        break;
      case "q":
      case "escape":
        props.onClose();
        break;
    }

    if (listBox) listBox.scrollTo(Math.max(0, index() - 2));
  });

  const rowColor = (candidate: PruneCandidate, isCursor: boolean): string => {
    if (isCursor) return theme.text;
    return candidate.dirty ? theme.yellow : theme.subtext;
  };

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box justifyContent="center" width="100%" height={1}>
        <text fg={theme.text}>
          <strong>Prune Worktrees</strong>
        </text>
      </box>

      {/* One always-present growing body. A `flexGrow` scrollbox that only
          exists inside a <Show> never resolves a height, which drops the
          footer to the top of the dialog and paints the list under it. */}
      <box flexGrow={1} flexDirection="column">
        <Show when={phase() === "loading"}>
          <box paddingTop={1}>
            <text fg={theme.subtext}>Scanning worktrees...</text>
          </box>
        </Show>

        <Show when={phase() === "error"}>
          <box paddingTop={1} flexDirection="column">
            <text fg={theme.red}>{error()}</text>
            <text fg={theme.overlay}>q close</text>
          </box>
        </Show>

        <Show when={phase() === "list" || phase() === "confirm"}>
          <Show
            when={candidates().length > 0}
            fallback={
              <box paddingTop={1}>
                <text fg={theme.subtext}>No worktrees are ready to prune.</text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              ref={(r: ScrollBoxRenderable) => (listBox = r)}
            >
              <For each={candidates()}>
                {(candidate, i) => {
                  const isCursor = () => i() === index();
                  const isSelected = () => selected().has(candidate.path);
                  const opted = () => dirtyOk().has(candidate.path);
                  return (
                    <box flexDirection="column">
                      <box height={1} flexDirection="row">
                        <text fg={isCursor() ? theme.mauve : theme.overlay}>
                          {isCursor() ? "▎" : " "}
                        </text>
                        <text fg={isSelected() ? theme.green : theme.overlay}>
                          {isSelected() ? "[x] " : "[ ] "}
                        </text>
                        <text fg={rowColor(candidate, isCursor())}>
                          {`${candidate.repoName}/${candidate.name}`}
                        </text>
                        <text fg={theme.overlay}>
                          {`  ${candidate.branch ?? "detached"}`}
                        </text>
                      </box>
                      <box height={1} flexDirection="row" paddingLeft={5}>
                        <text fg={reasonColor(candidate.reason)}>
                          {candidate.detail}
                        </text>
                        <Show when={candidate.sessions.length > 0}>
                          <text fg={theme.overlay}>
                            {`  [${candidate.sessions
                              .map((s) => `${s.agentType} ${s.status}`)
                              .join(", ")}]`}
                          </text>
                        </Show>
                        <Show when={candidate.dirty}>
                          <text fg={opted() ? theme.red : theme.yellow}>
                            {`  DIRTY ${candidate.modified}m/${candidate.untracked}u${
                              opted()
                                ? " — will be deleted (D)"
                                : " — press D to include"
                            }`}
                          </text>
                        </Show>
                      </box>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          <Show when={scan().skipped.length > 0}>
            <box height={1}>
              <text fg={theme.overlay}>
                {`${scan().skipped.length} not offered (agent working / locked)`}
              </text>
            </box>
          </Show>
        </Show>

        <Show when={phase() === "running"}>
          <box paddingTop={1}>
            <text fg={theme.peach}>Pruning...</text>
          </box>
        </Show>

        <Show when={phase() === "done"}>
          <scrollbox
            flexGrow={1}
            ref={(r: ScrollBoxRenderable) => (resultBox = r)}
          >
            <For each={result()?.outcomes ?? []}>
              {(outcome) => (
                <box flexDirection="column">
                  <box height={1}>
                    <text fg={outcome.removed ? theme.green : theme.red}>
                      {`${outcome.removed ? "✓" : "✗"} ${outcome.path}`}
                    </text>
                  </box>
                  <For each={outcome.steps}>
                    {(step) => (
                      <box height={1} paddingLeft={4}>
                        <text fg={step.ok ? theme.subtext : theme.red}>
                          {`${step.step}: ${step.detail}`}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>

      <box justifyContent="center" width="100%" height={1}>
        <Show when={phase() === "list"}>
          <text fg={theme.overlay}>
            {props.compact
              ? `space pick · D dirty · enter ${effective().length} · q`
              : `j/k move · space select · a all clean · D include dirty · enter prune ${effective().length} · q close`}
          </text>
        </Show>
        <Show when={phase() === "confirm"}>
          <text fg={theme.text}>
            {`Delete ${effective().length} worktree(s)` +
              `, ${effective().filter((c) => c.branch && c.branchDeletion !== "none").length} branch(es)` +
              (blockedDirty().length > 0
                ? `, skipping ${blockedDirty().length} dirty`
                : "") +
              "?  y / n"}
          </text>
        </Show>
        <Show when={phase() === "done"}>
          <text fg={theme.overlay}>j/k scroll · q close</text>
        </Show>
      </box>
    </box>
  );
};
