import type { Component } from "solid-js";
import { theme } from "../theme";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export const SearchInput: Component<SearchInputProps> = (props) => {
  return (
    <box
      width="100%"
      height={2}
      paddingLeft={1}
      paddingRight={1}
      border={["bottom"]}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="row"
    >
      <text fg={theme.overlay} width={2}>
        /{" "}
      </text>
      <input
        value={props.value}
        onInput={props.onChange}
        onSubmit={props.onSubmit}
        focused
        placeholder="Search sessions..."
        placeholderColor={theme.overlay}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.blue}
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        width="100%"
      />
    </box>
  );
};
