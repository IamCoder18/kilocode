import { createMemo } from "solid-js"
import type { TuiPluginApi } from "@kilocode/plugin/tui"

export function WorldSidebar(props: { api: TuiPluginApi; sessionID?: string }) {
  const enabled = createMemo(() => props.api.state.config.experimental?.world_browser !== false)
  const tone = createMemo(() => (enabled() ? "success" : "muted"))
  const label = createMemo(() => (enabled() ? "Enabled" : "Disabled"))
  const fg = createMemo(() =>
    tone() === "success" ? props.api.theme.current.success : props.api.theme.current.textMuted,
  )

  return (
    <box flexDirection="row" gap={1}>
      <text fg={fg()}>•</text>
      <text fg={props.api.theme.current.text}>
        <b>World (Browser Use)</b>: {label()}
      </text>
    </box>
  )
}
