import { Runner } from "../../core/browser/runner"
import { Refs } from "../../core/browser/refs"

export namespace Fill {
  export type Input = {
    session?: string
    value: string
    ref?: string
    selector?: string
    force?: boolean
  }

  export async function run(input: Input): Promise<{ length: number }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    const target = await Refs.refOrSelector(page, session, input.ref, input.selector)
    if (!target) throw new Error(`no element found for ${input.ref ?? input.selector}`)
    await target.fill(input.value, input.force ? { force: true } : undefined)
    await target.dispose()
    return { length: input.value.length }
  }
}
