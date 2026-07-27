import { Runner } from "../../core/browser/runner"
import { Launch } from "../../core/browser/launch"
import { Refs } from "../../core/browser/refs"

export namespace Click {
  export type Input = {
    session?: string
    ref?: string
    selector?: string
    timeoutMs?: number
  }

  export async function run(input: Input): Promise<{ ref?: string; selector?: string }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    const target = await Refs.refOrSelector(page, session, input.ref, input.selector)
    if (!target) throw new Error(`no element found for ${input.ref ?? input.selector}`)
    await target.click({ timeout: input.timeoutMs ?? Launch.TIMEOUT_MS_DEFAULT })
    await target.dispose().catch(() => {})
    return {
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
    }
  }
}
