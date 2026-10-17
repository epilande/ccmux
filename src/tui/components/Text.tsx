import type { Component } from "solid-js";
import type { TextProps } from "@opentui/solid";
import { theme } from "../theme";

/**
 * The only `<text>` in the TUI. A raw `<text>` with no `fg` (or an `fg` that
 * resolves to `undefined`) falls back to OpenTUI's opaque white, invisible on
 * a light theme; every sweep for those sites missed one (#141, #143, #211,
 * #212, #229). This defaults `fg` to `theme.text` instead, and
 * `Text.test.tsx` fails the suite on any raw `<text>` elsewhere.
 */
export const Text: Component<TextProps> = (props) => (
  // `fg` after the spread so an explicit `fg={undefined}` still gets the
  // default. `theme` is read here, not captured, because `applyTheme()`
  // mutates it in place before render.
  <text {...props} fg={props.fg ?? theme.text} />
);
