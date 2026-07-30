import { describe, expect, test } from "bun:test"
import path from "node:path"
import { inspect } from "../../src/kilocode/tool/world-script"

describe("world script inspection", () => {
  test("finds every navigated URL and deduplicates it", () => {
    const script = inspect(
      "navigate --url=https://example.com ; tabs open --url https://kilo.ai ; navigate --url https://example.com",
      "/workspace",
    )
    expect(script.urls).toEqual(["https://example.com", "https://kilo.ai"])
  })

  test("resolves file reads and writes against the active directory", () => {
    const root = path.resolve("/workspace/project")
    const script = inspect(
      "evaluate --js-file scripts/check.js ; screenshot --out=artifacts/page.png ; screenshot --out /tmp/final.png",
      root,
    )
    expect(script.reads).toEqual([path.join(root, "scripts/check.js")])
    expect(script.writes).toEqual([path.join(root, "artifacts/page.png"), "/tmp/final.png"])
  })

  test("does not treat unrelated --url and --out flags as capabilities", () => {
    const script = inspect("wait-for --url https://example.com ; evaluate --out secret.txt --js 1", "/workspace")
    expect(script.urls).toEqual([])
    expect(script.writes).toEqual([])
  })
})
