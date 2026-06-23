import { describe, expect, test } from "bun:test"
import path from "path"
import { Systemd } from "../../../src/kilocode/cli/systemd"

describe("Systemd.isAvailable", () => {
  test("returns false on non-linux platforms", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    try {
      expect(Systemd.isAvailable()).toBe(false)
    } finally {
      if (original) Object.defineProperty(process, "platform", original)
    }
  })

  test("reflects the underlying filesystem check on linux", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    const originalImpl = Object.getOwnPropertyDescriptor(Systemd, "isAvailable")
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      Object.defineProperty(Systemd, "isAvailable", {
        value: () => true,
        configurable: true,
      })
      expect(Systemd.isAvailable()).toBe(true)

      Object.defineProperty(Systemd, "isAvailable", {
        value: () => false,
        configurable: true,
      })
      expect(Systemd.isAvailable()).toBe(false)
    } finally {
      if (originalImpl) Object.defineProperty(Systemd, "isAvailable", originalImpl)
      if (original) Object.defineProperty(process, "platform", original)
    }
  })
})

describe("Systemd.unitScope", () => {
  test("defaults to user scope", () => {
    expect(Systemd.unitScope({})).toBe("user")
    expect(Systemd.unitScope({ system: false })).toBe("user")
  })

  test("returns system when --system is set", () => {
    expect(Systemd.unitScope({ system: true })).toBe("system")
  })
})

describe("Systemd paths", () => {
  test("userUnitPath honors $XDG_CONFIG_HOME", () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = "/custom/cfg"
    try {
      expect(Systemd.userUnitPath("kilo-console.service")).toBe(
        path.join("/custom/cfg", "systemd", "user", "kilo-console.service"),
      )
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })

  test("systemUnitPath lives under /etc/systemd/system", () => {
    expect(Systemd.systemUnitPath("kilo-console.service")).toBe(
      path.join("/etc/systemd/system", "kilo-console.service"),
    )
  })
})

describe("Systemd.renderUnit", () => {
  test("produces a deterministic user unit with ExecStart and WantedBy", () => {
    const unit = Systemd.renderUnit({
      description: "Kilo Console daemon",
      execStart: ["/usr/local/bin/kilo", "console", "--foreground"],
    })
    expect(unit).toContain("[Unit]")
    expect(unit).toContain("Description=Kilo Console daemon")
    expect(unit).toContain("[Service]")
    expect(unit).toContain("Type=simple")
    expect(unit).toContain("ExecStart=/usr/local/bin/kilo console --foreground")
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("RestartSec=5")
    expect(unit).toContain("Environment=NODE_ENV=production")
    expect(unit).toContain("[Install]")
    expect(unit).toContain("WantedBy=default.target")
  })

  test("uses multi-user.target for system scope", () => {
    const unit = Systemd.renderUnit({
      description: "Kilo Console daemon",
      execStart: ["/usr/bin/kilo"],
      user: false,
    })
    expect(unit).toContain("WantedBy=multi-user.target")
  })

  test("quotes ExecStart arguments containing whitespace", () => {
    const unit = Systemd.renderUnit({
      description: "test",
      execStart: ["/bin/kilo", "--hostname", "name with space"],
    })
    expect(unit).toContain("ExecStart=/bin/kilo --hostname 'name with space'")
  })
})

describe("Systemd.quoteArg", () => {
  test("leaves simple values untouched", () => {
    expect(Systemd.quoteArg("--port")).toBe("--port")
    expect(Systemd.quoteArg("4097")).toBe("4097")
  })

  test("wraps whitespace in single quotes", () => {
    expect(Systemd.quoteArg("hello world")).toBe("'hello world'")
  })

  test("escapes embedded single quotes", () => {
    expect(Systemd.quoteArg("it's")).toBe("'it'\\''s'")
  })

  test("quotes empty strings", () => {
    expect(Systemd.quoteArg("")).toBe("''")
  })
})