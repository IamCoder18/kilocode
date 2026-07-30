import { Runner } from "../../core/browser/runner"
import { Refs } from "../../core/browser/refs"

export namespace Scroll {
  export type Input = {
    session?: string
    ref?: string
    selector?: string
    dx: number
    dy: number
  }

  export async function run(input: Input): Promise<{ dx: number; dy: number }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    if (input.ref || input.selector) {
      const target = await Refs.refOrSelector(page, session, input.ref, input.selector)
      if (target) {
        await target.scrollIntoViewIfNeeded()
        await target.dispose()
      }
    }
    await page.mouse.wheel(input.dx, input.dy)
    return { dx: input.dx, dy: input.dy }
  }
}
