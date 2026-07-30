import { Runner } from "../../core/browser/runner"
import { Refs } from "../../core/browser/refs"

export namespace Type {
  export type Input = {
    session?: string
    text: string
    ref?: string
    selector?: string
    delay?: number
  }

  export async function run(input: Input): Promise<{ typed: number }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    if (input.ref || input.selector) {
      const target = await Refs.refOrSelector(page, session, input.ref, input.selector)
      if (!target) throw new Error(`no element found for ${input.ref ?? input.selector}`)
      await target.fill("")
      await target.type(input.text, input.delay ? { delay: input.delay } : undefined)
      await target.dispose()
    } else {
      await page.keyboard.type(input.text, input.delay ? { delay: input.delay } : undefined)
    }
    return { typed: input.text.length }
  }
}
