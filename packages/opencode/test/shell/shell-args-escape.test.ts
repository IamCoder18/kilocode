import { test, expect, describe } from "bun:test"
import { Shell } from "@/shell/shell"

describe("Shell.args (bash/zsh)", () => {
  test("escapes $ so outer bash does not expand variables before eval", () => {
    const command = 'for i in {1..3}; do echo -ne "$i\\r"; sleep 0.1; done; echo done'
    const args = Shell.args("/bin/bash", command, "/tmp")
    const script = args[2]
    // The script must contain \$$i (escaped) so the outer bash leaves $i alone
    // and eval receives the unescaped $i to expand inside the loop.
    expect(script).toContain("\\$i")
    expect(script).toMatch(/eval/)
  })

  test("preserves embedded single-dollar commands literally", () => {
    const command = "echo $HOME"
    const args = Shell.args("/bin/bash", command, "/tmp")
    const script = args[2]
    expect(script).toContain("\\$HOME")
  })

  test("zsh path also escapes $", () => {
    const command = 'echo "$VAR"'
    const args = Shell.args("/bin/zsh", command, "/tmp")
    const script = args[2]
    expect(script).toContain("\\$VAR")
  })
})
