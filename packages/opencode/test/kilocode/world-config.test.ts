import { describe, expect, test } from "bun:test"
import { defaultConfig } from "@kilocode/world"
import { resolve } from "../../src/kilocode/tool/world-config"

describe("world tool config", () => {
  test("does not inherit browser settings from a previous project", () => {
    const base = defaultConfig()
    const first = resolve({
      world: {
        browser: {
          headless: !base.browser.headless,
          use_system_chrome: true,
          args: ["--disable-notifications"],
        },
      },
    })
    const second = resolve({})

    expect(first.browser).toMatchObject({
      headless: !base.browser.headless,
      useSystemChrome: true,
      args: ["--disable-notifications"],
    })
    expect(second).toEqual(base)
  })

  test("fills partial project settings from defaults", () => {
    const base = defaultConfig()
    const config = resolve({ world: { browser: { timeout_ms: 12_345 } } })

    expect(config.browser).toEqual({
      ...base.browser,
      timeoutMs: 12_345,
    })
  })
})
