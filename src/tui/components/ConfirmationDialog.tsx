import type { Component } from "solid-js";
import { createMemo } from "solid-js";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { MouseButton } from "@opentui/core";
import type { Session } from "../../types";
import type { ConfirmAction } from "../store";
import { truncateText } from "../utils/format";
import { theme } from "../theme";

const MAX_WIDTH = 50;
const MIN_WIDTH = 24;
const HEIGHT = 7;

interface ConfirmationDialogProps {
  session: Session | null;
  action: ConfirmAction | null;
  sessionCount?: number;
  groupLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export const ConfirmationDialog: Component<ConfirmationDialogProps> = (
  props,
) => {
  const title = createMemo(() => {
    switch (props.action) {
      case "kill-all":
        return "Kill All Sessions?";
      case "kill-group":
        return "Kill Group?";
      case "restart":
        return "Restart Session?";
      case "send-review":
        return "Send review comments";
      default:
        return "Kill Session?";
    }
  });

  const subtitle = createMemo(() => {
    if (props.action === "send-review") {
      const n = props.sessionCount ?? 0;
      const agent = props.session?.agentType ?? "agent";
      return `Send ${n} comment${n === 1 ? "" : "s"} to ${agent}?`;
    }
    if (props.action === "kill-group") {
      const n = props.sessionCount ?? 0;
      const label = props.groupLabel || "group";
      return `${label} (${n} session${n !== 1 ? "s" : ""})`;
    }
    if (props.action === "kill-all") {
      const n = props.sessionCount ?? 0;
      return `(${n} session${n !== 1 ? "s" : ""})`;
    }
    if (!props.session) return "Unknown session";
    return props.session.project || props.session.cwd || props.session.id;
  });

  const dims = useSharedTerminalDimensions();
  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const height = () => Math.min(Math.max(1, dims().height), HEIGHT);

  return (
    <box
      position="absolute"
      /* Centered by arithmetic rather than a 50% offset and a negative
         margin, which disagree by a row when dialog and terminal are both
         odd-height (see `NoticeDialog`). The width clamp is what keeps this
         box inside a 30-column sidebar. */
      top={Math.max(0, Math.floor((dims().height - height()) / 2))}
      left={Math.max(0, Math.floor((dims().width - width()) / 2))}
      width={width()}
      height={height()}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.text}>
        <strong>{truncateText(title(), Math.max(1, width() - 4))}</strong>
      </text>
      <box height={1} />
      <text fg={theme.subtext}>
        {truncateText(subtitle(), Math.max(1, width() - 4))}
      </text>
      <box height={1} />
      <box flexDirection="row">
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onConfirm?.();
          }}
        >
          <text fg={theme.green}>
            <strong>Y</strong>
          </text>
          <text fg={theme.overlay}> confirm </text>
        </box>
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onCancel?.();
          }}
        >
          <text fg={theme.red}>
            <strong>N</strong>
          </text>
          <text fg={theme.overlay}> cancel</text>
        </box>
      </box>
    </box>
  );
};
