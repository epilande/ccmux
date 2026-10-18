import type { ScrollBoxRenderable } from "@opentui/core";

/**
 * Keep a scrollbox's vertical thumb sized to viewport / content.
 *
 * OpenTUI 0.1.97's `SliderRenderable` clamps `viewPortSize` to its scroll
 * range at the moment it is set, and `ScrollBarRenderable` only sets it when
 * the viewport height changes, BEFORE it raises the range. A viewport
 * measured while the content still fit therefore pins the thumb at the
 * slider's 0.01 floor (one virtual cell) once rows arrive, and only a
 * terminal resize unpins it. Even unpinned, the clamp draws exactly half a
 * track whenever the content is under twice the viewport.
 *
 * The core emits `resize` right after the `onSizeChange` that recalculates
 * the bar, so these listeners run with the range already current. The public
 * setter goes first so a future slider that tracks the value elsewhere still
 * hears it; the field write only lifts the clamp the setter applies.
 */
export function syncScrollbarThumb(box: ScrollBoxRenderable): void {
  const sync = () => {
    const bar = box.verticalScrollBar;
    const size = Math.max(1, bar.viewportSize);
    bar.slider.viewPortSize = size;
    if (bar.slider.viewPortSize >= size) return;
    (bar.slider as unknown as { _viewPortSize: number })._viewPortSize = size;
    bar.slider.requestRender();
  };
  box.viewport.on("resize", sync);
  box.content.on("resize", sync);
  sync();
}
