import type { TuiPlugin } from "@kilocode/plugin/tui"
import type { InternalTuiPlugin } from "@/plugin/tui/internal"

const id = "internal:kilo-world-palette"

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "world.toggle",
        slashName: "world",
        category: "System",
        get title() {
          const enabled = api.state.config.experimental?.world_browser !== false
          return enabled ? "Disable World (Browser Use)" : "Enable World (Browser Use)"
        },
        async run() {
          const current = api.state.config.experimental?.world_browser !== false
          const next = !current
          try {
            const result = await api.client.config.update({
              config: { experimental: { world_browser: next } },
            })
            if (result.error) {
              api.ui.toast({
                message: `Failed to toggle World: ${String(result.error)}`,
                variant: "error",
                duration: 5000,
              })
              return
            }
            api.ui.toast({
              message: `World ${next ? "enabled" : "disabled"}`,
              variant: "success",
            })
            api.ui.dialog.clear()
          } catch (err) {
            api.ui.toast({
              message: `Failed to toggle World: ${String(err)}`,
              variant: "error",
              duration: 5000,
            })
          }
        },
      },
    ],
    bindings: [],
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
