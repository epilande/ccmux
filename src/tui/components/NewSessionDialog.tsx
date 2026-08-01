import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import type { SpawnableAgent } from "../../lib/spawnable-agents";
import {
  namesAWorktree as draftNamesAWorktree,
  type NewSessionDestination,
  type NewSessionDraft,
  type NewSessionField,
  type NewSessionPlacement,
} from "../store";
import type { UntrackedMode } from "../../daemon/worktree-move-changes";
import { slugForFork, slugFromPrompt } from "../../daemon/worktree-create";
import {
  displayWidth,
  shortenCwd,
  sliceToWidth,
  truncateMiddle,
  truncateText,
} from "../utils/format";
import { agentColorFor } from "./SessionItem";
import { theme } from "../theme";

/** Width of the label gutter: focus marker (1) + "Placement" (9, the
 *  longest label) + one column of air before the content. */
const LABEL_WIDTH = 11;
/** Wide enough for the placement row's full labels; see COMPACT_CONTENT_WIDTH. */
const MAX_WIDTH = 65;
const MIN_WIDTH = 24;
/** The blank spacer plus the key-hint row, when the dialog draws its own. */
const KEY_HINT_ROWS = 2;
/** Content width the placement row's full labels need (number, brackets,
 *  and gaps included). Below it the row switches to the short labels and
 *  the key-hint line drops its middle segment. MAX_WIDTH is sized to leave
 *  exactly this much. */
const COMPACT_CONTENT_WIDTH = 49;
/** Content width the placement row needs even with the short labels. Below
 *  it the options stack vertically, which is the sidebar's 30-column rail:
 *  clipping the row would hide two of the three choices entirely. */
const STACKED_CONTENT_WIDTH = 33;

interface PlacementOption {
  value: NewSessionPlacement;
  label: string;
  compactLabel: string;
}

/** Placement choices, in the order their number keys select them. */
export const PLACEMENT_OPTIONS: readonly PlacementOption[] = [
  { value: "window", label: "New window", compactLabel: "Window" },
  { value: "split-h", label: "Split right", compactLabel: "Right" },
  { value: "split-v", label: "Split down", compactLabel: "Down" },
];

interface DestinationOption {
  value: NewSessionDestination;
  label: string;
  compactLabel: string;
}

/** Destination choices, in the order their number keys select them. */
export const DESTINATION_OPTIONS: readonly DestinationOption[] = [
  { value: "here", label: "This checkout", compactLabel: "Here" },
  { value: "worktree", label: "New worktree", compactLabel: "Worktree" },
];

interface UntrackedOption {
  value: UntrackedMode;
  label: string;
  compactLabel: string;
}

/**
 * What a move does with files git is not tracking yet, in the order their
 * number keys select them.
 *
 * The full labels name the DESTINATION rather than repeating the verb,
 * because "Copy" alone leaves the question this field exists to answer (does
 * the source keep them?) unanswered.
 */
export const UNTRACKED_OPTIONS: readonly UntrackedOption[] = [
  { value: "move", label: "Move", compactLabel: "Move" },
  { value: "copy", label: "Copy to both", compactLabel: "Copy" },
  { value: "leave", label: "Leave here", compactLabel: "Leave" },
];

/**
 * What a derived name row says about itself.
 *
 * The name shown is a preview of a rule, not a reservation: two prompts that
 * open the same way derive the same slug, and the daemon numbers the second
 * one rather than joining it. Someone who reads the row as a promise and
 * finds `-2` on disk has been misled by a row that could have said so.
 *
 * The short form is what survives once the name itself has eaten the row.
 */
export const NAME_HINT = "auto · -2 if taken";
export const NAME_HINT_SHORT = "auto";

/**
 * Greedy word-wrap into lines of at most `width` columns, breaking a word
 * that cannot fit on a line of its own.
 *
 * The dialog wraps its agent error itself rather than handing a long string
 * to the renderer, because the height budget below has to know the row count
 * BEFORE layout and the renderer's own wrapping cannot be predicted from
 * here (it breaks mid-word at the tail of a line, and a space landing on the
 * boundary moves to the next row). Lines produced here already fit, so
 * nothing can wrap a second time and the budget cannot be wrong.
 *
 * Widths are display columns (`displayWidth`), so a line of wide glyphs (CJK,
 * emoji) fits its column like an ASCII one does, and mid-word breaks land on
 * grapheme boundaries (issue #91).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    // Longer than the whole column: it can only be broken mid-word.
    while (displayWidth(rest) > width) {
      if (line) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      const head = sliceToWidth(rest, width);
      if (!head) {
        // A single cluster wider than the whole column (a wide glyph at
        // width 1): nothing can be split off it, so let the word overflow
        // rather than slice a cluster or spin on an empty head.
        lines.push(rest);
        rest = "";
        break;
      }
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (!rest) continue;
    const restWidth = displayWidth(rest);
    if (!line) {
      line = rest;
      lineWidth = restWidth;
    } else if (lineWidth + 1 + restWidth <= width) {
      line += ` ${rest}`;
      lineWidth += 1 + restWidth;
    } else {
      lines.push(line);
      line = rest;
      lineWidth = restWidth;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** What a draft needs from the row budget, without any of the width-dependent
 *  detail: one row per field it renders. */
export interface DialogShape {
  moveChanges: boolean;
  /** Continuing a session rather than starting one, which drops the agent
   *  and prompt rows and locks the destination. */
  fork: boolean;
  /** The name row is shown, i.e. this spawn is making a worktree. */
  namesAWorktree: boolean;
  /** Rows the agent field would like: its list length, or its error's. */
  agentRows: number;
  /** Options stack vertically (a narrow surface), so a field can want more
   *  than one row. */
  stacked: boolean;
  keyHints: boolean;
}

/** Rows a field is asking for, keyed by the field list itself. */
type FieldRows = Record<NewSessionField, number>;

/**
 * One row per field the draft renders, and zero for the fields it does not.
 *
 * A `Record<NewSessionField, number>` on purpose. The height below is a SUM,
 * and a field added to `NEW_SESSION_FIELDS` whose rows nobody counted makes
 * that sum one short — which does not clip, it draws the extra row over its
 * neighbour. Declaring the counts here is what turns that into a compile
 * error: a new member of `NewSessionField` fails to typecheck until it says
 * how many rows it wants.
 */
function floorFieldRows(shape: {
  moveChanges: boolean;
  fork: boolean;
  namesAWorktree: boolean;
}): FieldRows {
  return {
    // Neither survives a fork: it continues the source's agent, and it
    // continues a conversation rather than opening one with a first message.
    agent: shape.fork ? 0 : 1,
    placement: 1,
    prompt: shape.fork ? 0 : 1,
    // Present in every mode: a locked one-row restatement where the
    // destination is fixed (a move, a fork), the choice otherwise.
    destination: 1,
    worktreeName: shape.namesAWorktree ? 1 : 0,
    untracked: shape.moveChanges ? 1 : 0,
  };
}

const sumFieldRows = (rows: FieldRows): number =>
  Object.values(rows).reduce((total, n) => total + n, 0);

/**
 * The shortest the dialog can be drawn and still be a dialog: a border, its
 * title, and one row for every field it has. Everything else — the hints, the
 * move note, the directory, the spacer, the stacked options' extra rows — can
 * be given up before this point.
 *
 * Shared with `App.tsx`, which gates the option keys on it: below this height
 * the fields are not on screen, and a `2` that changed an invisible choice
 * would be the worst version of running out of room.
 */
export function newSessionFloorRows(shape: {
  moveChanges: boolean;
  fork: boolean;
  namesAWorktree: boolean;
}): number {
  // Border (2) + title, then the fields.
  return 3 + sumFieldRows(floorFieldRows(shape));
}

/** How the dialog spends the rows it has. Every count is final: the component
 *  renders exactly this, so nothing can wrap or overflow into a neighbour. */
export interface DialogRowPlan {
  /** No room even for the floor: the dialog says so instead of drawing itself
   *  over its own border. */
  tooShort: boolean;
  height: number;
  showTitleSpacer: boolean;
  showDirectory: boolean;
  /** The one-line footnote a mode adds under the directory: what a move costs
   *  the checkout named above it, or which session a fork continues. One flag
   *  because it is one row, given up at one point in the order below. */
  showModeNote: boolean;
  showKeyHints: boolean;
  agentRows: number;
  /** Rows each option field gets. Fewer than its options means a window that
   *  scrolls to keep the selection visible. */
  placementRows: number;
  destinationRows: number;
  untrackedRows: number;
}

/**
 * Fit the dialog into `height`, giving up rows in a fixed order.
 *
 * Order matters and is the whole design: the key hints go first (the picker
 * repeats them in its footer anyway), then the move note, then the blank row
 * under the title, then the stacked options collapse to a scrolling window,
 * then the directory. Nothing a user has to ACT on is dropped while anything
 * decorative is still on screen, and no option ever becomes unreachable — a
 * windowed list still shows each option's own number and scrolls to whichever
 * one a number key picks.
 *
 * Under-counting here does not clip: OpenTUI draws children past their
 * parent's height, so the rows that do not fit land on top of the ones that
 * do and the bottom border walks off the screen. That is why this is a
 * budget computed up front rather than a layout left to the renderer.
 */
export function planDialogRows(
  shape: DialogShape,
  height: number,
): DialogRowPlan {
  const floor = newSessionFloorRows(shape);
  if (height < floor) {
    return {
      tooShort: true,
      // Border, the title, and the one line explaining itself.
      height: Math.min(height, 3),
      showTitleSpacer: false,
      showDirectory: false,
      showModeNote: false,
      showKeyHints: false,
      agentRows: 0,
      placementRows: 0,
      destinationRows: 0,
      untrackedRows: 0,
    };
  }

  const plan: DialogRowPlan = {
    tooShort: false,
    height: 0,
    showTitleSpacer: true,
    showDirectory: true,
    showModeNote: shape.moveChanges || shape.fork,
    showKeyHints: shape.keyHints,
    // A fork has no agent row at all, so it asks for none rather than for the
    // one row `Math.max` would floor an empty list at.
    agentRows: shape.fork ? 0 : Math.max(1, shape.agentRows),
    placementRows: shape.stacked ? PLACEMENT_OPTIONS.length : 1,
    // Locked wherever the destination is fixed, where it is one derived row
    // with no options to stack.
    destinationRows:
      shape.moveChanges || shape.fork || !shape.stacked
        ? 1
        : DESTINATION_OPTIONS.length,
    untrackedRows: !shape.moveChanges
      ? 0
      : shape.stacked
        ? UNTRACKED_OPTIONS.length
        : 1,
  };

  /** What the fields currently want, as the plan gives their rows away. The
   *  floor's presence rules, with the magnitudes the plan has settled on. */
  const fieldRows = (): FieldRows => ({
    ...floorFieldRows(shape),
    agent: plan.agentRows,
    placement: plan.placementRows,
    destination: plan.destinationRows,
    untracked: plan.untrackedRows,
  });

  const total = (): number =>
    3 + // border and title
    (plan.showTitleSpacer ? 1 : 0) +
    (plan.showDirectory ? 1 : 0) +
    (plan.showModeNote ? 1 : 0) +
    (plan.showKeyHints ? KEY_HINT_ROWS : 0) +
    sumFieldRows(fieldRows());

  /** Give up rows until it fits, or until this step has nothing left. */
  const shrink = (over: number, take: (n: number) => void, has: number) => {
    if (over <= 0 || has <= 0) return;
    take(Math.min(over, has));
  };

  // The agent list first, since it is already a scrolling window and shrinks
  // without losing anything: it is the one field whose "natural" size is the
  // whole of some other list.
  shrink(total() - height, (n) => (plan.agentRows -= n), plan.agentRows - 1);
  if (total() > height && plan.showKeyHints) plan.showKeyHints = false;
  if (total() > height && plan.showModeNote) plan.showModeNote = false;
  if (total() > height && plan.showTitleSpacer) plan.showTitleSpacer = false;
  // Bottom-up through the stacked options, so the rows nearest the bottom
  // border are the first to become windows.
  shrink(
    total() - height,
    (n) => (plan.untrackedRows -= n),
    Math.max(0, plan.untrackedRows - 1),
  );
  shrink(
    total() - height,
    (n) => (plan.destinationRows -= n),
    Math.max(0, plan.destinationRows - 1),
  );
  shrink(
    total() - height,
    (n) => (plan.placementRows -= n),
    Math.max(0, plan.placementRows - 1),
  );
  // Last, because in move-changes mode this row names the checkout being
  // emptied, which is the one fact the title does not carry.
  if (total() > height && plan.showDirectory) plan.showDirectory = false;

  plan.height = Math.min(height, total());
  return plan;
}

/**
 * Slice of a longer option list to show, keeping the selection visible and
 * centered where it can be. Exported for its own tests: an off-by-one here
 * hides the row the user is on.
 */
export function optionWindow(
  total: number,
  selected: number,
  size: number,
): { start: number; end: number } {
  if (size >= total || size <= 0) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(selected - half, 0), total - size);
  return { start, end: start + size };
}

interface NewSessionDialogProps {
  draft: NewSessionDraft;
  /** Spawnable agents, or null while `GET /agents` is still in flight. */
  agents: SpawnableAgent[] | null;
  agentsError?: string | null;
  onFocusField: (field: NewSessionField) => void;
  onSelectAgent: (name: string) => void;
  onSelectPlacement: (placement: NewSessionPlacement) => void;
  onSelectDestination: (destination: NewSessionDestination) => void;
  onSelectUntracked: (untracked: UntrackedMode) => void;
  onPromptInput: (prompt: string) => void;
  /** A keystroke in the name field. Empty means "back to derived". */
  onWorktreeNameInput: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /**
   * Draw the dialog's own key-hint row. The picker's Footer switches to a
   * near-identical line whenever this dialog is open, and showing both puts
   * the same hints on screen twice; the footer wins there because that is
   * where the picker's hints always live. The sidebar has no footer at all,
   * so its dialog carries the row itself.
   */
  showKeyHints?: boolean;
}

export const NewSessionDialog: Component<NewSessionDialogProps> = (props) => {
  const dims = useTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - LABEL_WIDTH - 4);
  const compact = () => contentWidth() < COMPACT_CONTENT_WIDTH;
  const stacked = () => contentWidth() < STACKED_CONTENT_WIDTH;

  /**
   * The label to draw for a numbered option, shared by Placement and Where.
   *
   * Stacking gives each option its own row, but a row is not unlimited: at
   * the sidebar's real 30-column rail the dialog is 26 wide and the label
   * column is 8, which renders `New window` / `Split right` / `Split down`
   * as `New` / `Split` / `Split` — two of the three indistinguishable, and
   * `This checkout` / `New worktree` the same way. The full label is
   * therefore used only when it actually fits, and the short label (which
   * exists for exactly this) is the fallback in both layouts.
   */
  const optionLabel = (option: {
    label: string;
    compactLabel: string;
  }): string => {
    // The row also spends a 2-wide number cell and two 1-wide bracket cells.
    const room = contentWidth() - 4;
    if (!stacked()) return compact() ? option.compactLabel : option.label;
    return option.label.length <= room ? option.label : option.compactLabel;
  };

  const showKeyHints = () => props.showKeyHints !== false;

  /** Relocating this checkout's uncommitted work, rather than starting fresh
   *  in it. Changes the title, locks the destination, and adds the
   *  untracked-files choice. */
  const moveChanges = () => props.draft.moveChanges;

  /** Continuing an existing session rather than starting a new one: no agent
   *  and no prompt to choose, and the worktree is where the fork lands. */
  const forking = () => props.draft.fork;

  /** Whether this spawn is making a worktree at all, which is what the name
   *  row exists for. Move-changes and fork mode always are; see
   *  `newSessionFields`. */
  const namesAWorktree = () => draftNamesAWorktree(props.draft);

  /** The name is the prompt's (or the source branch's) to give until someone
   *  types over it. */
  const derivedName = () => props.draft.worktreeName === null;

  /**
   * What a derived name currently resolves to, or "" with nothing to derive
   * it from. Empty for an explicit name, which needs no preview.
   *
   * A fork derives from the SOURCE'S BRANCH, by the daemon's own
   * `<branch>-fork` rule, rather than from a prompt it does not have. Empty
   * where the branch never reached the client: the daemon reads the
   * checkout's HEAD for itself, so there is a name coming — just not one this
   * row can show. See `nameHint`, which is what says so.
   */
  const derivedSlug = () => {
    if (!derivedName()) return "";
    const fork = forking();
    if (!fork) return slugFromPrompt(props.draft.prompt);
    return fork.branch ? slugForFork(fork.branch) : "";
  };

  /**
   * A fork whose source branch HAS a name, but not one a directory can be
   * called: nothing in it survives slugifying (a non-Latin branch), so
   * `<branch>-fork` derives to nothing.
   *
   * The distinction the rows below turn on. An unknown branch still gets a
   * name — the daemon reads the checkout's own HEAD — but a known one that
   * slugifies away gets none, and the daemon refuses the fork and says to
   * type one here. Promising `auto` on that path walks the user into the
   * refusal by doing what the row suggested.
   */
  const forkNeedsAName = () => {
    const fork = forking();
    return fork !== null && fork.branch !== null && !slugForFork(fork.branch);
  };

  /**
   * What the Name row shows in place of a typed name, before it is fitted to
   * the columns it ends up with: the derived slug, or the sentence saying
   * where the name is coming from instead.
   *
   * Split from `namePlaceholder` because the hint below is budgeted against
   * this text and the fitting depends on the hint — asking for the fitted
   * text first is the circle.
   */
  const namePlaceholderText = () => {
    const slug = derivedSlug();
    if (slug) return slug;
    if (!derivedName()) return "";
    if (forking()) {
      // A branch that slugifies to nothing: the fork has no name coming, and
      // the daemon's own refusal says to type one in this row. So the row
      // asks, in the same words, rather than being the thing that caused it.
      if (forkNeedsAName()) {
        return stacked() ? "Type a name" : "Type a name for the worktree";
      }
      // No branch to preview, but the name is coming either way (the daemon
      // reads the checkout's HEAD), so the row says where it comes from
      // rather than offering a way out that would be a fiction — there is no
      // prompt here to derive one from instead.
      return stacked() ? "Source branch" : "Named after the source branch";
    }
    // Nothing to derive from yet. Both ways out are named, because the second
    // one is new (issue #83) and the row is where it is discoverable.
    return stacked() ? "Prompt or name" : "Type a prompt, or a name here";
  };

  /**
   * The suffix caveat, when it fits beside the name it applies to.
   *
   * The name is given the whole row first and the hint takes the leftovers,
   * rather than the other way round: the row exists to make the name legible,
   * and a caveat that squeezed the thing it is about would defeat it. The
   * short form is the fallback, and no hint at all is the last resort — at a
   * sidebar width every column belongs to the name.
   *
   * "The name" is whatever stands in the name's place, which on the no-slug
   * path is the sentence explaining where the name comes from. Budgeting
   * against the slug alone made that path the exception to the rule above: at
   * 40 columns the caveat survived whole and the sentence it qualified was
   * cut to a single character.
   */
  const nameHint = () => {
    if (!derivedName()) return "";
    const slug = derivedSlug();
    // No preview and no rule that will produce one: an ordinary spawn is not
    // going to be given a name at all, and a fork whose branch slugifies away
    // gets none either. Nothing to caveat, so nothing is said. A fork with a
    // branch it merely could not READ is the case that keeps its hint: the
    // daemon derives one, and this is the only thing that says the field can
    // be left alone.
    if (!slug && (!forking() || forkNeedsAName())) return "";
    const taken = displayWidth(namePlaceholderText());
    const spare = contentWidth() - (taken ? taken + 1 : 0);
    if (spare >= displayWidth(NAME_HINT)) return NAME_HINT;
    if (spare >= displayWidth(NAME_HINT_SHORT)) return NAME_HINT_SHORT;
    return "";
  };

  /** Columns the name itself gets, once the hint has taken its own. */
  const nameRoom = () => {
    const hint = nameHint();
    return Math.max(1, contentWidth() - (hint ? displayWidth(hint) + 1 : 0));
  };

  /**
   * The derived name, or what to do about there not being one.
   *
   * Drawn as the input's PLACEHOLDER rather than its value, which is what
   * makes the two states tell themselves apart: dim text is a preview the
   * prompt still owns, and typing replaces it with a name of your own.
   *
   * Truncated here rather than by the layout, because the input draws its
   * placeholder in full past its own box.
   */
  const namePlaceholder = () => {
    const text = namePlaceholderText();
    // From the middle only for a slug: clipped from the right it leaves
    // `fix-sidebar-…`, and every task that starts "fix sidebar" looks the
    // same — the tail is what tells them apart. The sentences have no such
    // tail to save, and one cut in half would read as a glitch.
    return derivedSlug()
      ? truncateMiddle(text, nameRoom())
      : truncateText(text, nameRoom());
  };

  const agents = createMemo(() => props.agents ?? []);
  const selectedAgentIndex = createMemo(() => {
    const index = agents().findIndex((a) => a.name === props.draft.agent);
    return index >= 0 ? index : 0;
  });
  const selectedAgent = createMemo(
    () => agents()[selectedAgentIndex()] ?? null,
  );

  /** The agent field carries an error instead of a list: the daemon answered
   *  with one, or answered with nothing to spawn. */
  const showAgentError = () => props.agents !== null && agents().length === 0;

  /** `||`, not `??`: the daemon's own error text is passed straight through
   *  (App.tsx takes `body?.error` at its word), and a `{"error": ""}` body
   *  would otherwise render an empty red row that says nothing at all. */
  const agentErrorText = () => props.agentsError || "No agents found on PATH";

  /**
   * How the dialog spends the rows the terminal has: which optional rows it
   * can afford, and how many each field gets. Every count below is read from
   * here rather than computed twice, because a row rendered that the budget
   * did not know about does not clip — it draws over its neighbour.
   *
   * The agent field's natural size is the whole agent list, which is the one
   * thing here that can be arbitrarily long; the plan shrinks it first and
   * scrolls the rest.
   */
  const plan = createMemo(() =>
    planDialogRows(
      {
        moveChanges: moveChanges(),
        fork: forking() !== null,
        namesAWorktree: namesAWorktree(),
        agentRows: showAgentError()
          ? wrapText(agentErrorText(), contentWidth()).length
          : Math.max(1, agents().length),
        stacked: stacked(),
        keyHints: showKeyHints(),
      },
      dims().height,
    ),
  );

  /** Rows the agent field ended up with. */
  const agentRoom = () => plan().agentRows;

  /** Where the visible slice of the agent list starts. Split from the slice
   *  itself so the rows can derive their absolute number from it without the
   *  slice having to carry a wrapper object per entry (see below). */
  const agentWindowStart = createMemo(() => {
    const list = agents();
    return optionWindow(
      list.length,
      selectedAgentIndex(),
      Math.min(agentRoom(), list.length),
    ).start;
  });

  /**
   * The agent list is the only field that can grow past a screen; cap it at
   * what every other row has left over, and scroll the rest.
   *
   * Returns the raw slice, NOT `{agent, index}` wrappers. `<For>` is keyed by
   * reference, so freshly minted wrappers made every visible row tear down
   * and rebuild on each j/k; the underlying agent objects are stable, so
   * slicing them directly lets it reuse the rows and move only the marker.
   */
  const visibleAgents = createMemo(() => {
    const list = agents();
    const start = agentWindowStart();
    return list.slice(start, start + Math.min(agentRoom(), list.length));
  });

  /**
   * The agent error, pre-wrapped to the content column and capped at the rows
   * the field actually has. Budgeting this field as one row was what clipped
   * the dialog's bottom rows outside its border whenever the message wrapped
   * (issue #85) — the stale-daemon message is three rows at a sidebar width.
   * Capping matters too: an error longer than the screen would otherwise push
   * the height past `dims().height`, where the clamp below re-creates exactly
   * the same clipping.
   */
  const agentErrorLines = createMemo(() => {
    const lines = wrapText(agentErrorText(), contentWidth());
    const room = agentRoom();
    if (lines.length <= room) return lines;
    // Say that it was cut, rather than ending mid-sentence: the last visible
    // row carries as much of the remainder as fits, with an ellipsis.
    const kept = lines.slice(0, room);
    kept[room - 1] = truncateText(
      lines.slice(room - 1).join(" "),
      contentWidth(),
    );
    return kept;
  });

  const height = () => plan().height;

  /**
   * A numbered option list, windowed to the rows the plan gave it.
   *
   * Only ever a window when the terminal is too short for the whole list, and
   * the selection is always inside it, so the row a number key picks scrolls
   * into view rather than acting off screen. The number drawn is the option's
   * ABSOLUTE position, exactly as the agent list does it, so a scrolled list
   * never renumbers the keys.
   */
  function optionSlice<T>(
    options: readonly T[],
    selected: number,
    rows: number,
  ): { option: T; number: number }[] {
    // Side by side on one row, every option is already visible; the window is
    // only ever needed where each option has a row of its own.
    if (!stacked()) {
      return options.map((option, i) => ({ option, number: i + 1 }));
    }
    const { start, end } = optionWindow(
      options.length,
      selected,
      Math.min(rows, options.length),
    );
    return options
      .slice(start, end)
      .map((option, i) => ({ option, number: start + i + 1 }));
  }

  /**
   * A field's label cell, carrying a one-character focus marker.
   *
   * Colour alone is not enough here: the number keys are scoped to the
   * FOCUSED field, so a viewer who can't tell which label is highlighted
   * can press `2` believing they are on Agent, get "Split right", and spawn
   * with no confirmation step. The selections themselves already use
   * colour-safe markers (`>` and `[brackets]`); this closes the last one.
   *
   * Marker (1) plus label cell (the rest of the gutter) is exactly the
   * width the content column is measured against, so nothing reflows.
   */
  const FieldLabel: Component<{ field: NewSessionField; text: string }> = (
    labelProps,
  ) => {
    const focused = () => props.draft.field === labelProps.field;
    return (
      <box flexDirection="row" width={LABEL_WIDTH} height={1}>
        <box width={1}>
          <text fg={theme.blue}>{focused() ? ">" : ""}</text>
        </box>
        <box width={LABEL_WIDTH - 1}>
          <text fg={focused() ? theme.blue : theme.overlay}>
            {labelProps.text}
          </text>
        </box>
      </box>
    );
  };

  const cwdLabel = () =>
    truncateText(shortenCwd(props.draft.cwd), contentWidth());

  /**
   * The locked destination row's text. Only where the changes are going: the
   * name they will go under is the Name row's, in both modes, so that the one
   * editable field is in the same place wherever it is reached from.
   */
  const lockedDestinationLabel = () =>
    truncateText(stacked() ? "Worktree" : "New worktree", contentWidth());

  /** What the mode's footnote says, and what to label it. A move reports what
   *  it costs the directory named directly above; a fork names the session it
   *  continues, which is the one thing that row cannot say. */
  const modeNote = (): { label: string; text: string; color: string } => {
    const fork = forking();
    if (fork) {
      return {
        label: "Source",
        text: truncateText(fork.label, contentWidth()),
        color: theme.blue,
      };
    }
    return {
      label: "Changes",
      text: truncateText(
        stacked() ? "Moved out" : "Moved out of this checkout",
        contentWidth(),
      ),
      color: theme.peach,
    };
  };

  /** Says whether this agent can take a prompt at all, which is per-agent
   *  and not otherwise discoverable. Shortened on a narrow surface, where
   *  the full sentence would run past the border. */
  const promptPlaceholder = () => {
    const agent = selectedAgent();
    let text: string;
    if (agent && !agent.supportsPrompt) {
      text = stacked()
        ? "no prompt support"
        : `${agent.displayName} can't start with a prompt`;
    } else {
      text = stacked() ? "Optional prompt..." : "Optional first message...";
    }
    // The input draws its placeholder in full, past its own box, so the
    // fit has to be enforced here rather than left to the layout.
    return truncateText(text, contentWidth());
  };

  /** The whole dialog, when there is room for one row and it has to say why
   *  the rest is missing. */
  const tooShortLabel = () => {
    const needed = newSessionFloorRows({
      moveChanges: moveChanges(),
      fork: forking() !== null,
      namesAWorktree: namesAWorktree(),
    });
    return truncateText(`Needs ${needed} rows to show`, contentWidth());
  };

  return (
    <box
      position="absolute"
      /* Centered by arithmetic rather than by a 50% offset and a negative
         margin: those disagree by a row when the dialog and the terminal are
         both odd-height, and the row they disagree by is the bottom border,
         which lands off screen exactly when the dialog is already as tall as
         the terminal. */
      top={Math.max(0, Math.floor((dims().height - height()) / 2))}
      left={Math.max(0, Math.floor((dims().width - width()) / 2))}
      width={width()}
      height={height()}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Nothing left to give up: one honest row rather than a dialog drawn
          over its own border. Enter and Esc still work, and the fields keep
          their values — this is a viewport problem, not a broken draft. */}
      <Show when={plan().tooShort}>
        <box height={1}>
          <text fg={theme.peach}>{tooShortLabel()}</text>
        </box>
      </Show>

      <Show when={!plan().tooShort}>
        <box height={1}>
          <text fg={theme.text}>
            {/* The title is the mode indicator: it is the one row the eye
              lands on first, and "Move changes" (or "Fork") is what makes this
              dialog different from every other time it opens. */}
            <strong>
              {forking()
                ? truncateText("Fork into worktree", width() - 4)
                : moveChanges()
                  ? truncateText("Move changes to worktree", width() - 4)
                  : "New session"}
            </strong>
          </text>
        </box>
        <Show when={plan().showTitleSpacer}>
          <box height={1} />
        </Show>

        {/* A fork continues the source's agent, so there is nothing to pick.
          Hidden rather than locked: unlike the destination, no part of the
          request is clearer for restating it. */}
        <Show when={!forking()}>
          <box flexDirection="row">
            <FieldLabel field="agent" text="Agent" />
            <box flexDirection="column" flexGrow={1}>
              <Show
                when={props.agents !== null}
                fallback={
                  <box height={1}>
                    <text fg={theme.overlay}>
                      {truncateText("Loading agents...", contentWidth())}
                    </text>
                  </box>
                }
              >
                <Show
                  when={agents().length > 0}
                  fallback={
                    /* One row per pre-wrapped line, which is the same count the
                   height was budgeted from. Left to the renderer instead,
                   a long message wrapped past its single budgeted row and
                   pushed the dialog's last rows outside the border. */
                    <For each={agentErrorLines()}>
                      {(line) => (
                        <box height={1}>
                          <text fg={theme.red}>{line}</text>
                        </box>
                      )}
                    </For>
                  }
                >
                  <For each={visibleAgents()}>
                    {(agent, i) => {
                      /** Absolute position, so the number key shown is the one
                       *  that picks it even when the list has scrolled. */
                      const number = () => agentWindowStart() + i() + 1;
                      return (
                        <box
                          height={1}
                          flexDirection="row"
                          onMouseDown={(event) => {
                            if (event.button !== MouseButton.LEFT) return;
                            props.onFocusField("agent");
                            props.onSelectAgent(agent.name);
                          }}
                        >
                          <box width={2}>
                            <text fg={theme.green}>
                              {agent.name === props.draft.agent ? ">" : ""}
                            </text>
                          </box>
                          {/* Only the first nine get a number key. */}
                          <box width={2}>
                            <text fg={theme.overlay}>
                              {number() <= 9 ? `${number()}` : ""}
                            </text>
                          </box>
                          <text fg={agentColorFor(agent.name)}>
                            {agent.displayName}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                </Show>
              </Show>
            </box>
          </box>
        </Show>

        <box flexDirection="row">
          <FieldLabel field="placement" text="Placement" />
          <box
            flexDirection={stacked() ? "column" : "row"}
            flexGrow={1}
            onMouseDown={() => props.onFocusField("placement")}
          >
            <For
              each={optionSlice(
                PLACEMENT_OPTIONS,
                PLACEMENT_OPTIONS.findIndex(
                  (o) => o.value === props.draft.placement,
                ),
                plan().placementRows,
              )}
            >
              {({ option, number }) => {
                const selected = () => option.value === props.draft.placement;
                return (
                  <box
                    height={1}
                    flexDirection="row"
                    flexShrink={0}
                    marginRight={stacked() ? 0 : 2}
                    onMouseDown={(event) => {
                      if (event.button !== MouseButton.LEFT) return;
                      props.onFocusField("placement");
                      props.onSelectPlacement(option.value);
                    }}
                  >
                    {/* Spacing comes from box widths and margins, never from
                      padded strings: a `<text>` is measured on its trimmed
                      content, so trailing spaces collapse under flex. */}
                    <box width={2}>
                      <text fg={theme.overlay}>{`${number}`}</text>
                    </box>
                    {/* Brackets, not colour alone: the placements have no
                      selection gutter of their own. Each bracket gets a
                      fixed-width box so choosing an option never reflows the
                      row, and so the marker survives a colourless terminal. */}
                    <box width={1}>
                      <text fg={theme.green}>{selected() ? "[" : ""}</text>
                    </box>
                    <text fg={selected() ? theme.green : theme.subtext}>
                      {optionLabel(option)}
                    </text>
                    <box width={1}>
                      <text fg={theme.green}>{selected() ? "]" : ""}</text>
                    </box>
                  </box>
                );
              }}
            </For>
          </box>
        </box>

        {/* A fork continues a conversation; there is no first message to
          open it with. */}
        <Show when={!forking()}>
          <box flexDirection="row" height={1}>
            <FieldLabel field="prompt" text="Prompt" />
            <input
              value={props.draft.prompt}
              onInput={props.onPromptInput}
              focused={props.draft.field === "prompt"}
              placeholder={promptPlaceholder()}
              placeholderColor={theme.overlay}
              textColor={theme.text}
              cursorColor={theme.blue}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              flexGrow={1}
            />
          </box>
        </Show>

        <Show when={moveChanges() || forking()}>
          {/* Locked, so it is drawn like Directory rather than as a field: no
            focus marker and no number keys, because a row that looks
            selectable but refuses every key reads as broken. The changes (or
            the fork) have nowhere to go but a new worktree, so there is no
            second choice to offer. */}
          <box flexDirection="row" height={1}>
            <box width={LABEL_WIDTH} paddingLeft={1}>
              <text fg={theme.overlay}>Where</text>
            </box>
            <text fg={theme.green}>{lockedDestinationLabel()}</text>
          </box>
        </Show>

        <Show when={!moveChanges() && !forking()}>
          <box flexDirection="row">
            <FieldLabel field="destination" text="Where" />
            <box
              flexDirection={stacked() ? "column" : "row"}
              flexGrow={1}
              onMouseDown={() => props.onFocusField("destination")}
            >
              <For
                each={optionSlice(
                  DESTINATION_OPTIONS,
                  DESTINATION_OPTIONS.findIndex(
                    (o) => o.value === props.draft.destination,
                  ),
                  plan().destinationRows,
                )}
              >
                {({ option, number }) => {
                  const selected = () =>
                    option.value === props.draft.destination;
                  /* Just the choice. The name the worktree option would create
                   used to be appended here and truncated against what the row
                   had left, which at this dialog's width meant committing to
                   `fix-sidebar-…` (issue #83). Selecting it opens a row of its
                   own below, where the name is both legible and editable. */
                  const label = () => optionLabel(option);
                  return (
                    <box
                      height={1}
                      flexDirection="row"
                      flexShrink={0}
                      marginRight={stacked() ? 0 : 2}
                      onMouseDown={(event) => {
                        if (event.button !== MouseButton.LEFT) return;
                        props.onFocusField("destination");
                        props.onSelectDestination(option.value);
                      }}
                    >
                      <box width={2}>
                        <text fg={theme.overlay}>{`${number}`}</text>
                      </box>
                      <box width={1}>
                        <text fg={theme.green}>{selected() ? "[" : ""}</text>
                      </box>
                      <text fg={selected() ? theme.green : theme.subtext}>
                        {label()}
                      </text>
                      <box width={1}>
                        <text fg={theme.green}>{selected() ? "]" : ""}</text>
                      </box>
                    </box>
                  );
                }}
              </For>
            </box>
          </box>
        </Show>

        <Show when={namesAWorktree()}>
          {/* A row of its own, which is the point: the name was a suffix on the
            row above, truncated against whatever that row had left. Here it
            gets the width, and the keyboard. */}
          <box flexDirection="row" height={1}>
            <FieldLabel field="worktreeName" text="Name" />
            <input
              value={props.draft.worktreeName ?? ""}
              onInput={props.onWorktreeNameInput}
              focused={props.draft.field === "worktreeName"}
              placeholder={namePlaceholder()}
              placeholderColor={theme.overlay}
              textColor={theme.text}
              cursorColor={theme.blue}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              flexGrow={1}
            />
            <Show when={nameHint()}>
              <box flexShrink={0} marginLeft={1}>
                <text fg={theme.overlay}>{nameHint()}</text>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={moveChanges()}>
          <box flexDirection="row">
            <FieldLabel field="untracked" text="Untracked" />
            <box
              flexDirection={stacked() ? "column" : "row"}
              flexGrow={1}
              onMouseDown={() => props.onFocusField("untracked")}
            >
              <For
                each={optionSlice(
                  UNTRACKED_OPTIONS,
                  UNTRACKED_OPTIONS.findIndex(
                    (o) => o.value === props.draft.untracked,
                  ),
                  plan().untrackedRows,
                )}
              >
                {({ option, number }) => {
                  const selected = () => option.value === props.draft.untracked;
                  return (
                    <box
                      height={1}
                      flexDirection="row"
                      flexShrink={0}
                      marginRight={stacked() ? 0 : 2}
                      onMouseDown={(event) => {
                        if (event.button !== MouseButton.LEFT) return;
                        props.onFocusField("untracked");
                        props.onSelectUntracked(option.value);
                      }}
                    >
                      <box width={2}>
                        <text fg={theme.overlay}>{`${number}`}</text>
                      </box>
                      <box width={1}>
                        <text fg={theme.green}>{selected() ? "[" : ""}</text>
                      </box>
                      <text fg={selected() ? theme.green : theme.subtext}>
                        {optionLabel(option)}
                      </text>
                      <box width={1}>
                        <text fg={theme.green}>{selected() ? "]" : ""}</text>
                      </box>
                    </box>
                  );
                }}
              </For>
            </box>
          </box>
        </Show>

        <Show when={plan().showDirectory}>
          <box flexDirection="row" height={1}>
            {/* Not a field: derived, never focused, so it only pads past the
              marker column to stay aligned with the labels above. */}
            <box width={LABEL_WIDTH} paddingLeft={1}>
              <text fg={theme.overlay}>Directory</text>
            </box>
            <text fg={theme.subtext}>{cwdLabel()}</text>
          </box>
        </Show>

        <Show when={plan().showModeNote}>
          {/* The title says WHAT is happening; this says what it happens to.
            For a move that is what it costs the directory named directly
            above, which is the part someone can still back out of at this
            point; for a fork it is which session is being continued, since
            the directory alone can hold several. */}
          <box flexDirection="row" height={1}>
            <box width={LABEL_WIDTH} paddingLeft={1}>
              <text fg={theme.overlay}>{modeNote().label}</text>
            </box>
            <text fg={modeNote().color}>{modeNote().text}</text>
          </box>
        </Show>

        <Show when={plan().showKeyHints}>
          <box height={1} />
          <box flexDirection="row" height={1}>
            <box
              flexDirection="row"
              flexShrink={0}
              marginRight={1}
              onMouseDown={(event) => {
                if (event.button === MouseButton.LEFT) props.onSubmit();
              }}
            >
              <text fg={theme.green}>
                <strong>enter</strong>
              </text>
              <box width={1} />
              <text fg={theme.overlay}>spawn</text>
            </box>
            {/* The middle hint is the one that goes when there is no room for
              it: the two it sits between are the dialog's only exits. */}
            <Show when={!compact()}>
              <box flexDirection="row" marginRight={1}>
                <text fg={theme.overlay}>· tab field · j/k or 1-9 pick</text>
              </box>
            </Show>
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={(event) => {
                if (event.button === MouseButton.LEFT) props.onCancel();
              }}
            >
              <text fg={theme.overlay}>·</text>
              <box width={1} />
              <text fg={theme.red}>
                <strong>esc</strong>
              </text>
              {/* At the real 30-column rail even this two-hint line overruns
                the border; Esc needs no gloss, so its word is what goes. */}
              <Show when={!stacked()}>
                <box width={1} />
                <text fg={theme.overlay}>cancel</text>
              </Show>
            </box>
          </box>
        </Show>
      </Show>
    </box>
  );
};
