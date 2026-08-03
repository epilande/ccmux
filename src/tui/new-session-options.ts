import type { SpawnableAgent } from "../lib/spawnable-agents";
import type { UntrackedMode } from "../daemon/worktree-move-changes";
import type {
  NewSessionDestination,
  NewSessionDraft,
  NewSessionField,
  NewSessionPlacement,
} from "./store";

/**
 * The option truth for the new-session dialog's dropdown fields: which
 * options each field offers a given draft, and which one the draft holds.
 * One place, because three consumers have to agree on it — the key routing
 * in `App.tsx`, the pills and overlay in `NewSessionDialog.tsx`, and the
 * store's value dispatch — and a disagreement is a number key that commits
 * an option the screen never showed.
 *
 * Deliberately free of component imports (colour is presentation, added by
 * the dialog): the store imports the tables below, and a component import
 * here would close a require cycle through `SessionItem` → store.
 */

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

/** One choice a dropdown field offers. `value` is what travels (an agent
 *  name, a placement); the labels are what the pill and overlay draw. */
export interface NewSessionOption {
  value: string;
  label: string;
  /** The narrow-width fallback; the label itself where none is shorter. */
  compactLabel: string;
}

export interface NewSessionOptionField {
  options: readonly NewSessionOption[];
  /** Index of the option the draft currently holds. */
  selectedIndex: number;
}

/**
 * The options `field` offers `draft`, or null for a field the draft cannot
 * act on: a text field, a mode that lacks it (fork's agent, a locked
 * destination, untracked outside a move), an agent list that has not
 * arrived, or a dialog too short to have drawn the row (`tooShort`, judged
 * by the caller against its own height source). Null here is what keeps
 * every consumer honest at once — keys, pills, and overlay all refuse
 * together.
 */
export function newSessionOptions(
  field: NewSessionField,
  ctx: {
    draft: NewSessionDraft;
    agents: SpawnableAgent[] | null;
    tooShort: boolean;
  },
): NewSessionOptionField | null {
  const { draft, agents } = ctx;
  if (ctx.tooShort) return null;

  const resolve = (
    options: readonly { value: string; label: string; compactLabel: string }[],
    value: string,
  ): NewSessionOptionField | null =>
    options.length === 0
      ? null
      : {
          options,
          selectedIndex: Math.max(
            0,
            options.findIndex((option) => option.value === value),
          ),
        };

  switch (field) {
    case "agent":
      // A fork continues the source's agent; the field does not exist there.
      if (draft.fork) return null;
      return resolve(
        (agents ?? []).map((agent) => ({
          value: agent.name,
          label: agent.displayName,
          compactLabel: agent.displayName,
        })),
        draft.agent,
      );
    case "placement":
      return resolve(PLACEMENT_OPTIONS, draft.placement);
    case "destination":
      // Locked in move-changes and fork mode; the store refuses the write
      // regardless, but a locked field must not offer a list either.
      if (draft.moveChanges || draft.fork) return null;
      return resolve(DESTINATION_OPTIONS, draft.destination);
    case "untracked":
      if (!draft.moveChanges) return null;
      return resolve(UNTRACKED_OPTIONS, draft.untracked);
    default:
      return null;
  }
}
