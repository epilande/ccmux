import { displayWidth, truncateText } from "./format";

/**
 * The toasts a group rename, merge or reset shows, each fitted to the
 * columns the toast has (36 inside its border at full width, less in a
 * narrow sidebar). They shorten in a fixed order rather than wrapping, so
 * the line that teaches the undo is never the part that falls off.
 */

/** The columns inside the toast's card at full width (`Toast.tsx`: a
 *  40-column card less its border and padding): what a toast's plain
 *  message is fitted to. A narrower terminal re-fits through the toast. */
export const TOAST_TEXT_WIDTH = 36;

/** The narrowest a name may be cut to before the toast stops naming it. */
const MIN_NAME = 6;

/**
 * After a merge: where the group went and how to take it back. The undo is
 * the point (a merge is silent otherwise), so it outlives the name: first
 * the undo shortens to `Reset to undo` (Reset is the only reset a group
 * has), then the name is cut, then dropped.
 */
export function mergedToast(name: string, width: number): string {
  const full = `Merged into ${name} · Reset name to undo`;
  if (displayWidth(full) <= width) return full;
  const room = width - displayWidth("Merged into  · Reset to undo");
  if (displayWidth(name) <= room) return `Merged into ${name} · Reset to undo`;
  if (room >= MIN_NAME)
    return `Merged into ${truncateText(name, room)} · Reset to undo`;
  return truncateText("Merged · Reset name to undo", width);
}

/** After a rename to a fresh name. */
export function renamedToast(name: string, width: number): string {
  return truncateText(`Renamed to ${name}`, width);
}

/**
 * After a reset: the groups that came back, as many as fit, then a count of
 * the rest (`Reset: px-api, px-web +3`). A first name too long to fit whole
 * is cut rather than leaving the list empty.
 */
export function resetToast(names: readonly string[], width: number): string {
  const prefix = "Reset: ";
  const line = (shown: number) => {
    const rest = names.length - shown;
    return `${prefix}${names.slice(0, shown).join(", ")}${rest ? ` +${rest}` : ""}`;
  };
  for (let shown = names.length; shown > 0; shown--)
    if (displayWidth(line(shown)) <= width) return line(shown);
  if (!names.length) return truncateText("Group name reset", width);
  const rest = names.length - 1;
  const tail = rest ? ` +${rest}` : "";
  const room = width - displayWidth(prefix) - displayWidth(tail);
  return room >= 1
    ? `${prefix}${truncateText(names[0]!, room)}${tail}`
    : truncateText(line(1), width);
}
