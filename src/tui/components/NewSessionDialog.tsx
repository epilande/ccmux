import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import type { SpawnableAgent } from "../../lib/spawnable-agents";
import {
  namesAWorktree as draftNamesAWorktree,
  NEW_SESSION_FIELDS,
  type NewSessionDraft,
  type NewSessionField,
} from "../store";
import { DESTINATION_OPTIONS, newSessionOptions } from "../new-session-options";
import { slugForFork, slugFromPrompt } from "../../daemon/worktree-create";
import {
  displayWidth,
  shortenCwd,
  sliceToWidth,
  truncateMiddle,
  truncateText,
} from "../utils/format";
import { agentColorFor } from "./SessionItem";
import { DropdownOverlay, DropdownTrigger } from "./DropdownField";
import { newSessionHintSegments } from "./Footer";
import { theme } from "../theme";

/** Width of the label gutter: focus marker (1) + "Placement" (9, the
 *  longest label) + one column of air before the content. */
const LABEL_WIDTH = 11;
/** Wide enough for the key-hint row's full middle segment; see
 *  COMPACT_CONTENT_WIDTH. */
const MAX_WIDTH = 65;
const MIN_WIDTH = 24;
/** The blank spacer plus the key-hint row, when the dialog draws its own. */
const KEY_HINT_ROWS = 2;
/** The button row with its leading and trailing blanks — one droppable
 *  unit, so the air goes with the buttons. */
const BUTTON_ROWS = 3;
/** Content width below which the pills switch to their short labels and the
 *  key-hint line drops its middle segment. MAX_WIDTH is sized to leave
 *  exactly this much. */
const COMPACT_CONTENT_WIDTH = 49;
/** The sidebar's 30-column rail, where even the short labels are fitted
 *  word by word and the esc hint gives up its gloss. */
const NARROW_CONTENT_WIDTH = 33;
/** Columns the text inputs' full-width shell spends on its own padding —
 *  the same run the pills paint, so every control shares one shape. */
const INPUT_SHELL_PADDING = 2;
/** Air between the label column and the controls' left edge. Every consumer
 *  of the control column reads it: the rows insert it, `contentWidth` (and
 *  with it every truncation budget) subtracts it, the derived rows' spacer
 *  adds it, and the overlay anchors past it. */
const CONTROL_GAP = 1;

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

/**
 * Which mode a draft is in, flattened to the booleans the budget turns on.
 * Named once and shared by the three functions below, so a mode added later
 * cannot be taught to one of them and forgotten by the next.
 */
export interface DialogModeShape {
  moveChanges: boolean;
  /** Continuing a session rather than starting one, which drops the agent
   *  and prompt rows and locks the destination. */
  fork: boolean;
  /** The name row is shown, i.e. this spawn is making a worktree. */
  namesAWorktree: boolean;
  /** Starting in a worktree that is already on disk, which creates nothing
   *  and so drops the destination row along with the name and untracked
   *  rows that the other two modes hide on their own terms. */
  existingWorktree: boolean;
}

/** What a draft needs from the row budget, without any of the width-dependent
 *  detail: one row per field it renders. */
export interface DialogShape extends DialogModeShape {
  /** Rows the agent field would like: one for its dropdown pill, or its
   *  error's wrapped lines. The only field that can want more than one row —
   *  every option list lives in an overlay outside the budget. */
  agentRows: number;
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
function floorFieldRows(shape: DialogModeShape): FieldRows {
  return {
    // Neither survives a fork: it continues the source's agent, and it
    // continues a conversation rather than opening one with a first message.
    agent: shape.fork ? 0 : 1,
    placement: 1,
    prompt: shape.fork ? 0 : 1,
    // A locked one-row restatement where the destination is fixed (a move, a
    // fork), the choice otherwise — and nothing at all where the session is
    // going into a checkout that already exists, which is neither.
    destination: shape.existingWorktree ? 0 : 1,
    worktreeName: shape.namesAWorktree ? 1 : 0,
    untracked: shape.moveChanges ? 1 : 0,
  };
}

const sumFieldRows = (rows: FieldRows): number =>
  Object.values(rows).reduce((total, n) => total + n, 0);

/**
 * The shortest the dialog can be drawn and still be a dialog: a border, its
 * title, and one row for every field it has. Everything else — the hints, the
 * move note, the directory, the spacer — can be given up before this point.
 *
 * Shared with `App.tsx`, which gates the option keys on it: below this height
 * the fields are not on screen, and a `2` that changed an invisible choice
 * would be the worst version of running out of room.
 */
export function newSessionFloorRows(shape: DialogModeShape): number {
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
  /** A blank row between every adjacent pair in the field stack (fields plus
   *  the directory row) — pure air, all on or all off, never before the
   *  first row or after the last. */
  showFieldSpacers: boolean;
  /** The confirm/Cancel button row (and its leading blank) under the form. */
  showButtons: boolean;
  showDirectory: boolean;
  /** The one-line footnote a mode adds under the directory: what a move costs
   *  the checkout named above it, which session a fork continues, or which
   *  existing worktree is being started in. One flag because it is one row,
   *  given up at one point in the order below. */
  showModeNote: boolean;
  showKeyHints: boolean;
  agentRows: number;
}

/**
 * Fit the dialog into `height`, giving up rows in a fixed order.
 *
 * Order matters and is the whole design: the blank rows between the fields
 * go first (pure air, and all at once — per-gap dropping would read as a
 * layout bug), then the button row (a duplicate of enter/esc), then the
 * agent field's error shrinks back towards one row,
 * then the key hints (the picker repeats them in its footer anyway), then
 * the move note, then the blank row under the title, then the directory.
 * Nothing a user has to ACT on is dropped while anything decorative is
 * still on screen. The option fields never enter this order at all: each is
 * a one-row pill whose list opens in an overlay OUTSIDE the budget.
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
      showFieldSpacers: false,
      showButtons: false,
      showDirectory: false,
      showModeNote: false,
      showKeyHints: false,
      agentRows: 0,
    };
  }

  const plan: DialogRowPlan = {
    tooShort: false,
    height: 0,
    showTitleSpacer: true,
    showFieldSpacers: true,
    showButtons: true,
    showDirectory: true,
    showModeNote: shape.moveChanges || shape.fork || shape.existingWorktree,
    showKeyHints: shape.keyHints,
    // A fork has no agent row at all, so it asks for none rather than for the
    // one row `Math.max` would floor an empty list at.
    agentRows: shape.fork ? 0 : Math.max(1, shape.agentRows),
  };

  /** What the fields currently want, as the plan gives their rows away. The
   *  floor's presence rules, with the magnitude the plan has settled on. */
  const fieldRows = (): FieldRows => ({
    ...floorFieldRows(shape),
    agent: plan.agentRows,
  });

  /** Gaps in the field stack: one between each adjacent pair of BLOCKS (a
   *  multi-row agent error is one block), the directory row included. */
  const fieldGaps = (): number => {
    if (!plan.showFieldSpacers) return 0;
    const blocks =
      Object.values(floorFieldRows(shape)).filter((rows) => rows > 0).length +
      (plan.showDirectory ? 1 : 0);
    return Math.max(0, blocks - 1);
  };

  const total = (): number =>
    3 + // border and title
    (plan.showTitleSpacer ? 1 : 0) +
    (plan.showDirectory ? 1 : 0) +
    (plan.showModeNote ? 1 : 0) +
    (plan.showKeyHints ? KEY_HINT_ROWS : 0) +
    (plan.showButtons ? BUTTON_ROWS : 0) +
    fieldGaps() +
    sumFieldRows(fieldRows());

  if (total() > height) plan.showFieldSpacers = false;
  // The buttons next: they duplicate enter/esc exactly — keys that always
  // work, and that the hint row both teaches and (clickably) provides — so
  // they are the cheapest functional loss after pure air.
  if (total() > height && plan.showButtons) plan.showButtons = false;
  // The agent error next, since its tail is already summarised by an
  // ellipsis and shrinks without losing anything actionable.
  const over = total() - height;
  if (over > 0 && plan.agentRows > 1) {
    plan.agentRows -= Math.min(over, plan.agentRows - 1);
  }
  if (total() > height && plan.showKeyHints) plan.showKeyHints = false;
  if (total() > height && plan.showModeNote) plan.showModeNote = false;
  if (total() > height && plan.showTitleSpacer) plan.showTitleSpacer = false;
  // Last, because in move-changes mode this row names the checkout being
  // emptied, which is the one fact the title does not carry.
  if (total() > height && plan.showDirectory) plan.showDirectory = false;

  plan.height = Math.min(height, total());
  return plan;
}

interface NewSessionDialogProps {
  draft: NewSessionDraft;
  /** Spawnable agents, or null while `GET /agents` is still in flight. */
  agents: SpawnableAgent[] | null;
  agentsError?: string | null;
  onFocusField: (field: NewSessionField) => void;
  /** Open `field`'s dropdown with this option highlighted. */
  onOpenDropdown: (field: NewSessionField, index: number) => void;
  onCloseDropdown: () => void;
  /** Commit `field`'s option at `index` and close its dropdown — the one
   *  write path (`commitDropdown` in App.tsx) every click site funnels to. */
  onSelectOption: (field: NewSessionField, index: number) => void;
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
  const contentWidth = () =>
    Math.max(1, width() - LABEL_WIDTH - CONTROL_GAP - 4);
  const compact = () => contentWidth() < COMPACT_CONTENT_WIDTH;
  const narrow = () => contentWidth() < NARROW_CONTENT_WIDTH;

  /**
   * The label an option shows, in the pills and in the overlay rows alike.
   *
   * A narrow surface cannot truncate its way out: at the sidebar's real
   * 30-column rail, cutting `Split right` / `Split down` to the columns
   * available renders two rows both starting `Split` — indistinguishable,
   * with number keys that still work. The full label is therefore used only
   * when it actually fits, and the short label (which exists for exactly
   * this) is the fallback.
   */
  const optionLabel = (option: {
    label: string;
    compactLabel: string;
  }): string => {
    // What a row spends beside the label: the marker and number cells.
    const room = contentWidth() - 4;
    if (!narrow()) return compact() ? option.compactLabel : option.label;
    return option.label.length <= room ? option.label : option.compactLabel;
  };

  const showKeyHints = () => props.showKeyHints !== false;

  /** Relocating this checkout's uncommitted work, rather than starting fresh
   *  in it. Changes the title, locks the destination, and adds the
   *  untracked-files choice. */
  const moveChanges = () => props.draft.moveChanges;

  /** Continuing an existing session rather than starting a new one: no agent
   *  and no prompt to choose, and a destination that says where it continues. */
  const forking = () => props.draft.fork;

  /** Starting in a worktree that is already on disk (issue #102): an ordinary
   *  spawn whose directory was chosen in the Worktrees panel, so every row
   *  about creating a worktree is gone. */
  const existingWorktree = () => props.draft.existingWorktree;

  /** Whether the Where row exists at all. The same condition
   *  `newSessionFields` filters on and the budget counts zero rows for: a row
   *  drawn past the budget lands on its neighbour rather than clipping. */
  const showDestination = () => existingWorktree() === null;

  /**
   * What to call the worktree a session is being started in: the last segment
   * of its path, which is the name it was created under. The full path is the
   * Directory row's job.
   */
  const existingWorktreeName = () => {
    const path = existingWorktree();
    if (!path) return "";
    return path.replace(/\/+$/, "").split("/").pop() || path;
  };

  /** Whether the Where row is a statement rather than a choice: a move has
   *  nowhere to go but a new worktree, and a fork whose source is outside a
   *  repository has nowhere to put one. Both are drawn like Directory, since a
   *  row that looks selectable but refuses every key reads as broken. */
  const destinationLocked = () =>
    moveChanges() || (forking() !== null && !forking()!.canWorktree);

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
        return narrow() ? "Type a name" : "Type a name for the worktree";
      }
      // No branch to preview, but the name is coming either way (the daemon
      // reads the checkout's HEAD), so the row says where it comes from
      // rather than offering a way out that would be a fiction — there is no
      // prompt here to derive one from instead.
      return narrow() ? "Source branch" : "Named after the source branch";
    }
    // Nothing to derive from yet. Both ways out are named, because the second
    // one is new (issue #83) and the row is where it is discoverable.
    return narrow() ? "Prompt or name" : "Type a prompt, or a name here";
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
    // The name spends its own columns plus the input shell's padding.
    const taken = displayWidth(namePlaceholderText()) + INPUT_SHELL_PADDING;
    const spare = contentWidth() - (taken + 1);
    if (spare >= displayWidth(NAME_HINT)) return NAME_HINT;
    if (spare >= displayWidth(NAME_HINT_SHORT)) return NAME_HINT_SHORT;
    return "";
  };

  /** Columns the name itself gets, once the hint and the input shell's
   *  padding have taken theirs. */
  const nameRoom = () => {
    const hint = nameHint();
    return Math.max(
      1,
      contentWidth() -
        INPUT_SHELL_PADDING -
        (hint ? displayWidth(hint) + 1 : 0),
    );
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

  /** The drafted agent's record, for the prompt placeholder's
   *  `supportsPrompt`; null until the list carries it. */
  const selectedAgent = createMemo(
    () => agents().find((agent) => agent.name === props.draft.agent) ?? null,
  );

  /** The agent field carries an error instead of a list: the daemon answered
   *  with one, or answered with nothing to spawn. */
  const showAgentError = () => props.agents !== null && agents().length === 0;

  /** `||`, not `??`: the daemon's own error text is passed straight through
   *  (App.tsx takes `body?.error` at its word), and a `{"error": ""}` body
   *  would otherwise render an empty red row that says nothing at all. */
  const agentErrorText = () => props.agentsError || "No agents found on PATH";

  /** The draft's mode, in the flat form the row budget takes. One memo,
   *  because the plan, the floor, and the anchor math below all read it. */
  const shape = createMemo(() => ({
    moveChanges: moveChanges(),
    fork: forking() !== null,
    namesAWorktree: namesAWorktree(),
    existingWorktree: existingWorktree() !== null,
  }));

  /**
   * How the dialog spends the rows the terminal has: which optional rows it
   * can afford, and how many each field gets. Every count below is read from
   * here rather than computed twice, because a row rendered that the budget
   * did not know about does not clip — it draws over its neighbour.
   */
  const plan = createMemo(() =>
    planDialogRows(
      {
        ...shape(),
        // One row: the field is a collapsed dropdown, and only its ERROR
        // still wraps to more. The list itself lives in an absolute overlay
        // outside the budget entirely.
        agentRows: showAgentError()
          ? wrapText(agentErrorText(), contentWidth()).length
          : 1,
        keyHints: showKeyHints(),
      },
      dims().height,
    ),
  );

  const dialogTop = () =>
    Math.max(0, Math.floor((dims().height - plan().height) / 2));

  /** `newSessionOptions` with this dialog's own context filled in: the same
   *  accessor the key routing in App.tsx reads, so the pills, the overlay,
   *  and the keys can never disagree about what a field offers. */
  const optionsFor = (field: NewSessionField) =>
    newSessionOptions(field, {
      draft: props.draft,
      agents: props.agents,
      tooShort: plan().tooShort,
    });

  /**
   * The open overlay's options, fitted to the width rules and decorated with
   * the agents' brand colours, or null while no dropdown is up. A memo so
   * the row objects keep their IDENTITY across highlight moves: the
   * overlay's `<For>` keys by reference, and fresh wrappers per j/k tear
   * down and rebuild every visible row.
   */
  const overlayOptions = createMemo(() => {
    const open = props.draft.dropdown;
    if (!open || plan().tooShort) return null;
    const resolved = optionsFor(open.field);
    if (!resolved || resolved.options.length === 0) return null;
    return {
      field: open.field,
      selectedIndex: resolved.selectedIndex,
      options: resolved.options.map((option) => ({
        label: optionLabel(option),
        color: open.field === "agent" ? agentColorFor(option.value) : undefined,
      })),
    };
  });

  /** The dropdown that is up, if a valid one is; the hint row and the
   *  overlay both key off this. */
  const dropdownOpen = () => overlayOptions() !== null;

  const overlayHighlight = () => {
    const open = props.draft.dropdown;
    const resolved = overlayOptions();
    if (!open || !resolved) return 0;
    return Math.min(open.index, resolved.options.length - 1);
  };

  /**
   * Content-box row `field`'s own row starts on: the title (row zero — the
   * border adds its own row when this becomes screen rows), the spacer, then
   * a prefix-sum of the same per-field counts the plan settled — each block
   * above carrying its trailing gap when the plan kept the field spacers.
   * The Where row is `destination`'s in every mode, locked or not.
   */
  const fieldRowTop = (field: NewSessionField): number => {
    const rows = { ...floorFieldRows(shape()), agent: plan().agentRows };
    const gap = plan().showFieldSpacers ? 1 : 0;
    let top = 1 + (plan().showTitleSpacer ? 1 : 0);
    for (const before of NEW_SESSION_FIELDS) {
      if (before === field) break;
      if (rows[before] > 0) top += rows[before] + gap;
    }
    return top;
  };

  /** Option rows the screen has room for under `field`: the overlay is
   *  outside the dialog's budget, so it clamps against the SCREEN. */
  const dropdownMaxRows = (field: NewSessionField): number => {
    const anchor = dialogTop() + 1 + fieldRowTop(field) + 1;
    return Math.max(1, dims().height - anchor - 2);
  };

  /** Commit the highlighted option, the hint row's click-side twin of the
   *  Enter/space key path in `App.tsx`. */
  const confirmDropdown = () => {
    const resolved = overlayOptions();
    if (resolved) props.onSelectOption(resolved.field, overlayHighlight());
  };

  /** The shared hint copy, for whichever key set is live right now. */
  const hintSegments = () =>
    newSessionHintSegments(
      dropdownOpen()
        ? "dropdown"
        : optionsFor(props.draft.field)
          ? "focused"
          : "text",
    );

  /** Everything between the two exits, as the one dim run a compact width
   *  gives up whole. */
  const middleHint = () =>
    hintSegments()
      .slice(1, -1)
      .map((segment) => `· ${segment.key} ${segment.gloss}`)
      .join(" ");

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
    const room = plan().agentRows;
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
   * A field's label cell, carrying a one-character focus marker.
   *
   * Colour alone is not enough here: the number keys are scoped to the
   * FOCUSED field, so a viewer who can't tell which label is highlighted
   * can press `2` believing they are on Agent, get "Split right", and spawn
   * with no confirmation step. The selections themselves already use
   * colour-safe markers (`▎` and the pills); this closes the last one.
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
          <text fg={theme.blue}>{focused() ? "▎" : ""}</text>
        </box>
        <box width={LABEL_WIDTH - 1}>
          <text fg={focused() ? theme.blue : theme.overlay}>
            {labelProps.text}
          </text>
        </box>
      </box>
    );
  };

  /** The blank row between adjacent field-stack rows, when the plan can
   *  afford them. Placed BEFORE every stack row except the first, so the
   *  rendered gaps always match the plan's `fieldGaps` count. */
  const FieldGap: Component = () => (
    <Show when={plan().showFieldSpacers}>
      <box height={1} />
    </Show>
  );

  /**
   * An option field's whole row: its label plus the pill holding its current
   * value, everything read through the shared accessor so the row can never
   * disagree with the keys about what is held. Clicking the pill focuses the
   * field and opens its dropdown at the held option.
   */
  const OptionRow: Component<{ field: NewSessionField; label: string }> = (
    rowProps,
  ) => {
    const resolved = () => optionsFor(rowProps.field);
    const held = () => {
      const field = resolved();
      return field ? field.options[field.selectedIndex] : undefined;
    };
    return (
      <box flexDirection="row" height={1}>
        <FieldLabel field={rowProps.field} text={rowProps.label} />
        <box width={CONTROL_GAP} />
        <DropdownTrigger
          value={optionLabel(held() ?? { label: "", compactLabel: "" })}
          color={
            rowProps.field === "agent"
              ? agentColorFor(held()?.value ?? props.draft.agent)
              : undefined
          }
          focused={props.draft.field === rowProps.field}
          maxWidth={contentWidth() - 4}
          onOpen={() => {
            props.onFocusField(rowProps.field);
            props.onOpenDropdown(
              rowProps.field,
              resolved()?.selectedIndex ?? 0,
            );
          }}
        />
      </box>
    );
  };

  const cwdLabel = () =>
    truncateText(shortenCwd(props.draft.cwd), contentWidth());

  /**
   * The locked destination row's text. Only where the session is going: the
   * name a worktree will go under is the Name row's, so that the one editable
   * field is in the same place wherever it is reached from.
   *
   * The two locks say opposite things — a move has to make a worktree, a fork
   * outside a repository cannot — and the words are the dropdown's own, so the
   * locked row and the choice it stands in for never read as different fields.
   */
  const lockedDestinationLabel = () => {
    const [here, worktree] = DESTINATION_OPTIONS;
    const option = moveChanges() ? worktree! : here!;
    return truncateText(
      narrow() ? option.compactLabel : option.label,
      contentWidth(),
    );
  };

  /** What the mode's footnote says, and what to label it. A move reports what
   *  it costs the directory named directly above; a fork names the session it
   *  continues, which is the one thing that row cannot say; a spawn into an
   *  existing worktree names the worktree, which the path above only spells
   *  out. */
  const modeNote = (): { label: string; text: string; color: string } => {
    if (existingWorktree()) {
      return {
        label: "Worktree",
        text: truncateText(existingWorktreeName(), contentWidth()),
        color: theme.green,
      };
    }
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
        narrow() ? "Moved out" : "Moved out of this checkout",
        contentWidth(),
      ),
      color: theme.peach,
    };
  };

  /** What the confirm button DOES, in the mode's own verb — the same word
   *  the title leads with. */
  const confirmVerb = () =>
    forking() ? "Fork" : moveChanges() ? "Move" : "Spawn";

  /** Says whether this agent can take a prompt at all, which is per-agent
   *  and not otherwise discoverable. Shortened on a narrow surface, where
   *  the full sentence would run past the border. */
  const promptPlaceholder = () => {
    const agent = selectedAgent();
    let text: string;
    if (agent && !agent.supportsPrompt) {
      text = narrow()
        ? "no prompt support"
        : `${agent.displayName} can't start with a prompt`;
    } else {
      text = narrow() ? "Optional prompt..." : "Optional first message...";
    }
    // The input draws its placeholder in full, past its own box, so the
    // fit has to be enforced here rather than left to the layout.
    return truncateText(
      text,
      Math.max(1, contentWidth() - INPUT_SHELL_PADDING),
    );
  };

  /** The whole dialog, when there is room for one row and it has to say why
   *  the rest is missing. */
  const tooShortLabel = () => {
    const needed = newSessionFloorRows(shape());
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
      top={dialogTop()}
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
                ? "Fork session"
                : moveChanges()
                  ? truncateText("Move changes to worktree", width() - 4)
                  : existingWorktree()
                    ? truncateText("New session in worktree", width() - 4)
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
          <Show
            when={props.agents !== null && agents().length > 0}
            fallback={
              <box flexDirection="row">
                <FieldLabel field="agent" text="Agent" />
                <box width={CONTROL_GAP} />
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
                    {/* One row per pre-wrapped line, which is the same count
                      the height was budgeted from. Left to the renderer
                      instead, a long message wrapped past its single budgeted
                      row and pushed the dialog's last rows outside the
                      border. */}
                    <For each={agentErrorLines()}>
                      {(line) => (
                        <box height={1}>
                          <text fg={theme.red}>{line}</text>
                        </box>
                      )}
                    </For>
                  </Show>
                </box>
              </box>
            }
          >
            <OptionRow field="agent" label="Agent" />
          </Show>
        </Show>

        <Show when={!forking()}>
          <FieldGap />
        </Show>
        <OptionRow field="placement" label="Placement" />

        {/* A fork continues a conversation; there is no first message to
          open it with. */}
        <Show when={!forking()}>
          <FieldGap />
          <box flexDirection="row" height={1}>
            <FieldLabel field="prompt" text="Prompt" />
            <box width={CONTROL_GAP} />
            {/* The same full-width run the pills paint, so every control
              shares one shape and one right edge; the input itself stays
              transparent over it (its own background prop does not paint). */}
            <box
              height={1}
              flexDirection="row"
              flexGrow={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                props.draft.field === "prompt" ? theme.border : theme.surface
              }
            >
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
          </box>
        </Show>

        {/* No Where row at all when the session is going into a worktree that
          already exists: the panel row it was opened from IS the destination,
          so both options would be a choice already made. Gated on the same
          condition `newSessionFields` filters on and the budget counts zero
          rows for. */}
        <Show when={showDestination()}>
          <Show when={destinationLocked()}>
            <FieldGap />
            {/* Locked, so it is drawn like Directory rather than as a field: no
              focus marker and no number keys, because a row that looks
              selectable but refuses every key reads as broken. The changes have
              nowhere to go but a new worktree, and a fork of a session outside a
              repository has nowhere to put one — either way there is no second
              choice to offer. */}
            <box flexDirection="row" height={1}>
              <box width={LABEL_WIDTH} paddingLeft={1}>
                <text fg={theme.overlay}>Where</text>
              </box>
              <box width={1 + CONTROL_GAP} />
              <text fg={theme.green}>{lockedDestinationLabel()}</text>
            </box>
          </Show>

          <Show when={!destinationLocked()}>
            <FieldGap />
            {/* Just the choice. The name the worktree option would create used
              to be appended here and truncated against what the row had left,
              which at this dialog's width meant committing to `fix-sidebar-…`
              (issue #83). Selecting it opens a row of its own below, where the
              name is both legible and editable. */}
            <OptionRow field="destination" label="Where" />
          </Show>
        </Show>

        <Show when={namesAWorktree()}>
          <FieldGap />
          {/* A row of its own, which is the point: the name was a suffix on the
            row above, truncated against whatever that row had left. Here it
            gets the width, and the keyboard. */}
          <box flexDirection="row" height={1}>
            <FieldLabel field="worktreeName" text="Name" />
            <box width={CONTROL_GAP} />
            {/* The pills' run; see the Prompt row. The hint stays OUTSIDE
              the control, an annotation rather than part of the value. */}
            <box
              height={1}
              flexDirection="row"
              flexGrow={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                props.draft.field === "worktreeName"
                  ? theme.border
                  : theme.surface
              }
            >
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
            </box>
            <Show when={nameHint()}>
              <box flexShrink={0} marginLeft={1}>
                <text fg={theme.overlay}>{nameHint()}</text>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={moveChanges()}>
          <FieldGap />
          <OptionRow field="untracked" label="Untracked" />
        </Show>

        <Show when={plan().showDirectory}>
          <FieldGap />
          <box flexDirection="row" height={1}>
            {/* Not a field: derived, never focused, so it only pads past the
              marker column to stay aligned with the labels above. */}
            <box width={LABEL_WIDTH} paddingLeft={1}>
              <text fg={theme.overlay}>Directory</text>
            </box>
            <box width={1 + CONTROL_GAP} />
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
            <box width={1 + CONTROL_GAP} />
            <text fg={modeNote().color}>{modeNote().text}</text>
          </box>
        </Show>

        <Show when={plan().showButtons}>
          <box height={1} />
          {/* Confirm and Cancel, aligned with the controls: pure duplicates
            of Enter and Escape (the same paths, all the same guards), so
            they are click affordances only and deliberately NOT Tab stops.
            While a dropdown is open they follow the hint row's click
            contract: confirm commits the highlight, Cancel closes the
            overlay. */}
          <box flexDirection="row" height={1}>
            {/* Right-aligned in the macOS order — quiet Cancel left, the
              primary rightmost, ending flush at the content edge the pills'
              carets end on. The growing spacer means no per-width indent
              cases; the rail simply has less room to breathe. */}
            <box flexGrow={1} />
            <box
              height={1}
              flexDirection="row"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.surface}
              onMouseDown={(event) => {
                if (event.button !== MouseButton.LEFT) return;
                if (dropdownOpen()) props.onCloseDropdown();
                else props.onCancel();
              }}
            >
              <text fg={theme.text}>Cancel</text>
            </box>
            <box width={2} />
            <box
              height={1}
              flexDirection="row"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.mauve}
              onMouseDown={(event) => {
                if (event.button !== MouseButton.LEFT) return;
                if (dropdownOpen()) confirmDropdown();
                else props.onSubmit();
              }}
            >
              <text fg={theme.base}>
                <strong>{confirmVerb()}</strong>
              </text>
            </box>
          </box>
          <box height={1} />
        </Show>

        <Show when={plan().showKeyHints}>
          <box height={1} />
          {/* The same segments the Footer joins into one line
            (`newSessionHintSegments`); here the first and last are the
            clickable exits and the middle is what a narrow surface gives
            up. */}
          <box flexDirection="row" height={1}>
            <box
              flexDirection="row"
              flexShrink={0}
              marginRight={1}
              onMouseDown={(event) => {
                if (event.button !== MouseButton.LEFT) return;
                if (dropdownOpen()) confirmDropdown();
                else props.onSubmit();
              }}
            >
              <text fg={theme.green}>
                <strong>{hintSegments()[0]!.key}</strong>
              </text>
              {/* The overlay's longer key text eats the gloss's columns at
                the rail, the same trade the esc segment already makes. */}
              <Show when={!dropdownOpen() || !narrow()}>
                <box width={1} />
                <text fg={theme.overlay}>{hintSegments()[0]!.gloss}</text>
              </Show>
            </box>
            {/* The middle hint is the one that goes when there is no room
              for it: the two it sits between are the dialog's only exits. */}
            <Show when={!compact()}>
              <box flexDirection="row" marginRight={1}>
                <text fg={theme.overlay}>{middleHint()}</text>
              </box>
            </Show>
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={(event) => {
                if (event.button !== MouseButton.LEFT) return;
                if (dropdownOpen()) props.onCloseDropdown();
                else props.onCancel();
              }}
            >
              <text fg={theme.overlay}>·</text>
              <box width={1} />
              <text fg={theme.red}>
                <strong>esc</strong>
              </text>
              {/* At the real 30-column rail even this two-hint line overruns
                the border; Esc needs no gloss, so its word is what goes. */}
              <Show when={!narrow()}>
                <box width={1} />
                <text fg={theme.overlay}>cancel</text>
              </Show>
            </box>
          </box>
        </Show>

        {/* The one open dropdown, anchored under whichever field it belongs
          to — a single late child of the dialog box, for the sibling
          z-sorting reason `DropdownField.tsx` explains. */}
        <Show when={overlayOptions()}>
          {(resolved: () => NonNullable<ReturnType<typeof overlayOptions>>) => (
            <DropdownOverlay
              options={resolved().options}
              highlight={overlayHighlight()}
              selected={resolved().selectedIndex}
              top={fieldRowTop(resolved().field) + 1}
              /* Absolute children measure from inside the BORDER, not the
                padding box, so the dialog's own paddingLeft is part of the
                offset to the control's left edge. */
              left={1 + LABEL_WIDTH + CONTROL_GAP}
              maxRows={dropdownMaxRows(resolved().field)}
              maxWidth={width() - LABEL_WIDTH - CONTROL_GAP - 2}
              onSelect={(index) =>
                props.onSelectOption(resolved().field, index)
              }
            />
          )}
        </Show>
      </Show>
    </box>
  );
};
