import { Runner } from "../../core/browser/runner"

export namespace PressKey {
  export type Input = {
    session?: string
    chord: string
  }

  export async function run(input: Input): Promise<{ chord: string; keys: number }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    const keys = input.chord.split("+").map((s) => s.trim()).filter(Boolean)
    if (keys.length === 0) throw new Error("chord cannot be empty")
    const names = keys.map((k) => (k.length === 1 ? k.toLowerCase() : k))
    await page.keyboard.press(names.join("+"))
    return { chord: input.chord, keys: names.length }
  }
}
