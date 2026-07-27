import { Runner } from "../../core/browser/runner"
import { Launch } from "../../core/browser/launch"

export namespace Navigate {
  export type Input = {
    session?: string
    url: string
    wait?: string
    antiDetect?: boolean
    timeoutMs?: number
  }

  export async function run(input: Input): Promise<{ url: string; finalUrl: string; status: number | null }> {
    const session = input.session ?? "default"
    const live = await Runner.attach(session)
    const page = Runner.activePage(live)
    const timeout = input.timeoutMs ?? Launch.TIMEOUT_MS_DEFAULT
    if (input.wait) {
      await page.goto(input.url, { waitUntil: "load", timeout })
      await page.waitForSelector(input.wait, { timeout })
    } else {
      await page.goto(input.url, { waitUntil: "load", timeout })
    }
    return { url: input.url, finalUrl: page.url(), status: null }
  }
}
