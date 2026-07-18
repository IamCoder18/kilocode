import { test, expect, describe } from "bun:test"
import { processCarriageReturns } from "@/kilocode/cli/cmd/tui/util/process-carriage-returns"

describe("processCarriageReturns", () => {
  test("keeps plain text unchanged", () => {
    expect(processCarriageReturns("hello world\n")).toBe("hello world\n")
  })

  test("converts \\r progress frames into newlines so each frame renders", () => {
    expect(processCarriageReturns("1\r2\r3\r4\r5\rhello world\n")).toBe("1\n2\n3\n4\n5\nhello world\n")
  })

  test("preserves \\r\\n line endings as single newlines", () => {
    expect(processCarriageReturns("line1\r\nline2\r\n")).toBe("line1\nline2\n")
  })

  test("handles progress bar that ends with \\r and no newline", () => {
    expect(processCarriageReturns("downloading 10%\rdownloading 20%\r")).toBe("downloading 10%\ndownloading 20%\n")
  })

  test("handles empty input", () => {
    expect(processCarriageReturns("")).toBe("")
  })

  test("preserves empty frames from consecutive \\r", () => {
    expect(processCarriageReturns("hello\r\r")).toBe("hello\n\n")
  })
})
