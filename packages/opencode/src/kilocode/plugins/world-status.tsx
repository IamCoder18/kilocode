import type { TuiPlugin } from "@kilocode/plugin/tui"
import type { InternalTuiPlugin } from "@/plugin/tui/internal"
import { WorldSidebar } from "@/kilocode/cli/cmd/tui/component/world-status"

const id = "internal:kilo-sidebar-world"

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 1010,
    slots: {
      sidebar_content(_ctx, props) {
        return <WorldSidebar api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
