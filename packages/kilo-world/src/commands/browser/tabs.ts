import { Runner } from "../../core/browser/runner"
import type { TabInfo } from "../../types"

export namespace Tabs {
  export async function list(session?: string): Promise<TabInfo[]> {
    const name = session ?? "default"
    const live = await Runner.attach(name)
    const pages = live.context.pages()
    const out: TabInfo[] = []
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!
      const url = page.url()
      let title: string | undefined
      try {
        title = await page.title()
      } catch {
        title = undefined
      }
      out.push({ index, url, ...(title ? { title } : {}), active: index === live.activeIndex })
    }
    return out
  }

  export async function open(input: { session?: string; url: string }): Promise<{ index: number; url: string }> {
    const name = input.session ?? "default"
    const live = await Runner.attach(name)
    const page = await live.context.newPage()
    live.pages.push(page)
    live.activeIndex = live.pages.length - 1
    await page.goto(input.url, { waitUntil: "load" })
    return { index: live.activeIndex, url: input.url }
  }

  export async function select(input: { session?: string; index: number }): Promise<{ index: number; url: string }> {
    const name = input.session ?? "default"
    const live = await Runner.attach(name)
    if (input.index < 0 || input.index >= live.pages.length) {
      throw new Error(`tab index out of range: ${input.index}`)
    }
    live.activeIndex = input.index
    const page = live.pages[input.index]!
    return { index: input.index, url: page.url() }
  }

  export async function close(input: { session?: string; index?: number }): Promise<{ closed: number; remaining: number }> {
    const name = input.session ?? "default"
    const live = await Runner.attach(name)
    const target = input.index ?? live.activeIndex
    if (target < 0 || target >= live.pages.length) throw new Error(`tab index out of range: ${target}`)
    const page = live.pages[target]!
    await page.close().catch(() => {})
    live.pages.splice(target, 1)
    if (live.activeIndex >= live.pages.length) live.activeIndex = Math.max(0, live.pages.length - 1)
    return { closed: target, remaining: live.pages.length }
  }
}
