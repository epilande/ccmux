import type { Component } from "solid-js";
import type {
  SessionStatus,
  AttentionType,
  AttentionState,
  Session,
} from "../../types";
import { getEffectiveStatus } from "../../daemon/status-machine";
import type { IconStyle } from "../../lib/icons";
import type { StatusMode } from "../../lib/preferences";
import { useStatusIcon } from "../utils/useStatusIcon";
import { theme } from "../theme";

interface StatusBadgeProps {
  status: SessionStatus;
  attentionType?: AttentionType;
  attentionState?: AttentionState;
  session?: Session;
  iconStyle?: IconStyle;
  mode?: StatusMode;
  dimmed?: boolean;
}

export function getStatusColor(
  status: SessionStatus,
  attentionType: AttentionType,
  attentionState?: AttentionState,
): string {
  // Attention only decorates idle sessions
  if (status === "idle" && attentionState) {
    return theme.green;
  }
  switch (status) {
    case "working":
      return theme.peach;
    case "waiting":
      // Plan approval keeps its own teal + "Plan" label; every other waiting
      // reason (permission, question, or a generic turn-end) is red so the
      // attention signal reads uniformly instead of splitting red vs mauve.
      if (attentionType === "plan_approval") return theme.teal;
      return theme.red;
    case "idle":
      return theme.overlay;
    default:
      return theme.text;
  }
}

export const StatusBadge: Component<StatusBadgeProps> = (props) => {
  const effective = () => {
    if (props.session) {
      return getEffectiveStatus(props.session);
    }
    return {
      status: props.status,
      attentionType: props.attentionType ?? null,
      fromSubagent: false,
    };
  };

  const color = () => {
    const eff = effective();
    return getStatusColor(eff.status, eff.attentionType, props.attentionState);
  };

  const icon = useStatusIcon(
    () => effective().status,
    () => effective().attentionType,
    () => props.iconStyle,
    () => props.attentionState,
  );

  const label = () => {
    const mode = props.mode ?? "full";
    if (mode === "icon") return icon();
    const attn = props.attentionState;
    const eff = effective();
    // Lifted state: the lead is idle at its prompt while its subagents run.
    // Same spinner and color as working (it IS activity), but the label
    // says whose activity it is.
    let labelText: string =
      eff.status === "working" && eff.fromSubagent ? "agents" : eff.status;
    // Both unread and read display as "done"
    if (eff.status === "idle" && attn) labelText = "done";
    return `${icon()} ${mode === "short" ? labelText.slice(0, 4) : labelText.padEnd(7)}`;
  };

  return <text fg={props.dimmed ? theme.border : color()}>{label()}</text>;
};
