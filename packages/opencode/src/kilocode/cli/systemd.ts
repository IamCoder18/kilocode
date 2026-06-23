import { existsSync } from "fs"
import path from "path"

export namespace Systemd {
  export function isAvailable(): boolean {
    if (process.platform !== "linux") return false
    return existsSync("/run/systemd/system")
  }

  export function userUnitPath(name: string): string {
    const root = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "~", ".config")
    return path.join(root, "systemd", "user", name)
  }

  export function systemUnitPath(name: string): string {
    return path.join("/etc/systemd/system", name)
  }

  export function unitScope(args: { system?: boolean }): "user" | "system" {
    return args.system ? "system" : "user"
  }

  export function quoteArg(value: string): string {
    if (value === "") return "''"
    if (/^[a-zA-Z0-9_\-./:=@]+$/.test(value)) return value
    return "'" + value.replace(/'/g, "'\\''") + "'"
  }

  export function renderUnit(opts: {
    description: string
    execStart: string[]
    user?: boolean
    wantedBy?: string
  }): string {
    const wantedBy =
      opts.wantedBy ?? (opts.user === false ? "multi-user.target" : "default.target")
    const exec = opts.execStart.map(quoteArg).join(" ")
    return [
      "[Unit]",
      `Description=${opts.description}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${exec}`,
      "Restart=on-failure",
      "RestartSec=5",
      "Environment=NODE_ENV=production",
      "",
      "[Install]",
      `WantedBy=${wantedBy}`,
      "",
    ].join("\n")
  }
}