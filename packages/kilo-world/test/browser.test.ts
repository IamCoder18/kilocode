import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chromium } from "playwright"
import { World } from "../src"
import { Runner } from "../src/core/browser/runner"

const available = existsSync(chromium.executablePath())

afterAll(() => Runner.shutdown())

describe.skipIf(!available)("browser commands", () => {
  test("assigns distinct refs to elements with the same accessible name", async () => {
    const result = await World.run(
      'navigate --url "data:text/html,<button id=one>Same</button><button id=two>Same</button>" ; snapshot ; click --ref e2 ; evaluate --js "document.activeElement.id"',
    )
    expect(result.ok).toBe(true)
    expect(result.results[1]?.refs?.map((entry) => entry.ref)).toEqual(["e1", "e2"])
    expect(result.results[3]?.data).toEqual({ result: "two" })
  })

  test("tracks the active page while opening and closing tabs", async () => {
    const result = await World.run(
      'tabs open --url "data:text/html,<title>Second</title>" ; tabs list ; tabs close ; tabs list',
    )
    expect(result.ok).toBe(true)
    expect(result.results[1]?.data).toEqual([
      expect.objectContaining({ index: 0, active: false }),
      expect.objectContaining({ index: 1, title: "Second", active: true }),
    ])
    expect(result.results[3]?.data).toEqual([expect.objectContaining({ index: 0, active: true })])
  })

  test("invalidates refs after navigation", async () => {
    await World.run('navigate --url "data:text/html,<button>First</button>" ; snapshot')
    const result = await World.run('navigate --url "data:text/html,<button>Second</button>" ; click --ref e1')
    expect(result.ok).toBe(false)
    expect(result.results[1]?.error).toContain("run snapshot first")
  })

  test("cancels an action already running in Chromium", async () => {
    await World.run('navigate --url "data:text/html,<title>Cancel</title>"')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    const error = await World.run('evaluate --js "new Promise(() => {})"', { signal: controller.signal }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty("message", expect.stringMatching(/aborted/))
    clearTimeout(timer)
  })
})
