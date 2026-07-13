import type { Component } from "solid-js";
import { createMemo } from "solid-js";
import { MouseButton } from "@opentui/core";
import type { Session } from "../../types";
import type { ConfirmAction } from "../store";
import { theme } from "../theme";

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

  return (
    <box
      position="absolute"
      top="50%"
      left="50%"
      width={50}
      height={7}
      marginTop={-3}
      marginLeft={-25}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.text}>
        <strong>{title()}</strong>
      </text>
      <box height={1} />
      <text fg={theme.subtext}>{subtitle()}</text>
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
