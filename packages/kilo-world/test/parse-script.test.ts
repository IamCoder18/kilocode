import { describe, expect, test } from "bun:test"
import { World, parseScript } from "../src/index"

describe("parseScript", () => {
  test("splits on ; and trims", () => {
    expect(parseScript("navigate --url a ; click --ref e1 ; screenshot --out /tmp/x.png")).toEqual([
      { verb: "navigate", args: ["--url", "a"] },
      { verb: "click", args: ["--ref", "e1"] },
      { verb: "screenshot", args: ["--out", "/tmp/x.png"] },
    ])
  })

  test("respects single and double quotes", () => {
    expect(parseScript(`navigate --url "https://example.com/path?q=1" ; type --text 'hello world'`)).toEqual([
      { verb: "navigate", args: ["--url", "https://example.com/path?q=1"] },
      { verb: "type", args: ["--text", "hello world"] },
    ])
  })

  test("skips empty segments", () => {
    expect(parseScript(" ;;navigate --url a;; ")).toEqual([{ verb: "navigate", args: ["--url", "a"] }])
  })

  test("rejects unterminated quote", () => {
    expect(() => parseScript(`navigate --url "https://example.com`)).toThrow(/unterminated quote/)
  })

  test("rejects an unterminated quote after a trailing literal backslash", () => {
    expect(() => parseScript(`type --text "value\\`)).toThrow(/unterminated quote/)
  })

  test("preserves empty quoted arguments", () => {
    expect(parseScript(`fill --ref e1 --value ""`)).toEqual([{ verb: "fill", args: ["--ref", "e1", "--value", ""] }])
  })

  test("decodes escaped quotes and backslashes", () => {
    expect(parseScript(`screenshot --out "C:\\\\screenshots\\\\page.png" ; type --text "say \\"hello\\""`)).toEqual([
      { verb: "screenshot", args: ["--out", "C:\\screenshots\\page.png"] },
      { verb: "type", args: ["--text", 'say "hello"'] },
    ])
  })

  test("preserves ordinary backslashes in quoted Windows paths", () => {
    const script = String.raw`screenshot --out "C:\Users\Aarav\Downloads\page.png"`
    expect(parseScript(script)).toEqual([
      { verb: "screenshot", args: ["--out", String.raw`C:\Users\Aarav\Downloads\page.png`] },
    ])
  })

  test("preserves ; inside single quotes", () => {
    const actions = parseScript(`evaluate --js 'var x = 1; return x; done'`)
    expect(actions).toEqual([{ verb: "evaluate", args: ["--js", "var x = 1; return x; done"] }])
  })

  test("preserves ; inside double quotes", () => {
    const actions = parseScript(`evaluate --js "var y = 2; return y; done"`)
    expect(actions).toEqual([{ verb: "evaluate", args: ["--js", "var y = 2; return y; done"] }])
  })

  test("preserves ; across multiple verbs when JS is quoted", () => {
    const actions = parseScript(`status ; evaluate --js 'a;b;c' ; navigate --url https://example.com`)
    expect(actions).toEqual([
      { verb: "status", args: [] },
      { verb: "evaluate", args: ["--js", "a;b;c"] },
      { verb: "navigate", args: ["--url", "https://example.com"] },
    ])
  })

  test("supports --js-file flag", () => {
    const actions = parseScript("evaluate --js-file /tmp/fill.js")
    expect(actions).toEqual([{ verb: "evaluate", args: ["--js-file", "/tmp/fill.js"] }])
  })

  test("supports backtick template literals with semicolons", () => {
    const actions = parseScript("evaluate --js `var z = 3; ; done`")
    expect(actions).toEqual([{ verb: "evaluate", args: ["--js", "var z = 3; ; done"] }])
  })
})

describe("World.parseScript alias", () => {
  test("World.parseScript produces the same output as the canonical parser", () => {
    const input = "status ; evaluate --js 'a;b;c' ; navigate --url https://example.com"
    expect(World.parseScript(input)).toEqual(parseScript(input))
  })
})

describe("World.configure", () => {
  test("returns the default config and accepts patches", () => {
    const before = World.currentConfig()
    expect(before.browser.timeoutMs).toBe(30_000)
    const next = World.configure({ browser: { ...before.browser, headless: false, timeoutMs: 12345 } })
    expect(next.browser.headless).toBe(false)
    expect(next.browser.timeoutMs).toBe(12345)
    expect(World.currentConfig()).toEqual(next)
    World.configure(before)
  })
})

describe("World.run", () => {
  test("stops after the first failed action", async () => {
    const result = await World.run("unknown ; status")
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.verb).toBe("unknown")
  })

  test("honors a signal aborted before execution", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(World.run("status", { signal: controller.signal })).rejects.toThrow()
  })
})
