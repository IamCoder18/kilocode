import open from "open"
import type { Argv } from "yargs"
import { mkdir, rename, writeFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { cmd } from "@/cli/cmd/cmd"
import {
  explicitNetworkOptions,
  withNetworkOptions,
  resolveNetworkOptions,
  resolveNetworkOptionsNoConfig,
} from "@/cli/network"
import { serverUrls } from "@/kilocode/cli/server-urls"
import { AppRuntime } from "@/effect/app-runtime"
import { Daemon } from "@/kilocode/daemon/daemon"
import { warnPort } from "@/kilocode/cli/port-warning"
import { hasDisplay } from "@/kilocode/cli/cmd/tui/util/display"
import { StopCommand } from "@/kilocode/cli/cmd/daemon"
import { Process } from "@/util/process"
import { Systemd } from "@/kilocode/cli/systemd"

function browserUrl(state: Daemon.State) {
  const url = new URL("/console", state.url)
  url.username = state.username
  url.password = state.password
  return url.toString()
}

async function launch(url: string) {
  const child = await open(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500)
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("exit", (code) => {
      if (code === null || code === 0) {
        clearTimeout(timer)
        resolve()
        return
      }
      clearTimeout(timer)
      reject(new Error(`Browser open failed with exit code ${code}`))
    })
  })
}

const OpenCommand = cmd({
  command: "$0",
  describe: "open the local Kilo Console",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("foreground", {
      alias: "f",
      describe: "keep the command active until interrupted",
      type: "boolean",
    }),
  handler: async (args) => {
    const run = async (signal?: AbortSignal) => {
      const opts = await AppRuntime.runPromise(resolveNetworkOptions(args))
      warnPort(opts.port)
      const daemon = await Daemon.ensure(opts, explicitNetworkOptions())
      const state = daemon.result.state
      if (!state) throw new Error("Kilo daemon did not provide connection state")
      if (signal?.aborted) return state
      if (daemon.restarted) console.warn("Restarted the Kilo daemon to apply the requested network options")

      const urls = state.urls ?? serverUrls(state.hostname, state.port)
      const consoleLocal = `${urls.local}/console`
      const consoleNetwork = urls.network ? `${urls.network}/console` : undefined

      if (hasDisplay()) {
        await launch(browserUrl(state)).catch((err) => {
          console.warn(`Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`)
        })
      } else {
        console.warn("No display detected; open the Kilo Console URL manually")
      }
      console.log("Kilo Console:")
      console.log(`  Local:   ${consoleLocal}`)
      if (consoleNetwork) console.log(`  Network: ${consoleNetwork}`)
      return state
    }
    if (!args.foreground) {
      await run()
      return
    }
    await Daemon.foreground(async (signal) => {
      const state = await run(signal)
      if (!signal.aborted) console.log("Press Ctrl+C to stop the Kilo daemon.")
      return state
    })
  },
})

const SERVICE_NAME = "kilo-console.service"
const DESCRIPTION = "Kilo Console daemon"

export type SystemctlResult = { code: number; stdout: string; stderr: string }
export type SystemctlRunner = (
  args: string[],
  scope?: "user" | "system",
) => Promise<SystemctlResult>

export const systemctlRunner: { current: SystemctlRunner } = {
  current: async (args, scope: "user" | "system" = "user") => {
    const cmd = scope === "user" ? ["systemctl", "--user", ...args] : ["systemctl", ...args]
    const out = await Process.run(cmd, { nothrow: true })
    return { code: out.code, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
  },
}

export const runSystemctl: SystemctlRunner = (args, scope) => systemctlRunner.current(args, scope)

function requireSystemd(): boolean {
  if (Systemd.isAvailable()) return true
  console.error(
    "kilo console requires systemd. Support for other init systems is coming soon.",
  )
  process.exitCode = 1
  return false
}

function resolveExec(args: {
  binary: string[]
  hostname?: string
  port?: number
  mdns?: boolean
  "mdns-domain"?: string
  cors?: string[]
  extra?: string[]
}): string[] {
  const argv: string[] = [...args.binary, "console", "--foreground"]
  if (args.hostname !== undefined) argv.push("--hostname", args.hostname)
  if (args.port !== undefined) argv.push("--port", String(args.port))
  if (args.mdns) argv.push("--mdns")
  if (args["mdns-domain"]) argv.push("--mdns-domain", args["mdns-domain"])
  for (const origin of args.cors ?? []) argv.push("--cors", origin)
  if (args.extra) argv.push(...args.extra)
  return argv
}

function resolveBinary(): string[] {
  // When the current process is a node or bun interpreter wrapping the kilo
  // script (the normal production path for pnpm/npm installs and for `bun dev`),
  // invoke the interpreter with the real entry script directly. systemd does
  // not need a populated PATH to run an absolute path to node.
  const exec = process.execPath
  const entry = process.argv[1]
  if (entry && /node|bun/.test(exec ?? "")) return [exec, entry]
  if (exec) return [exec]
  const shim = Bun.which("kilo")
  return shim ? [shim] : ["kilo"]
}

const InstallCommand = cmd({
  command: "install",
  describe: "install Kilo Console as a systemd service",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("system", {
        describe: "install system-wide (/etc/systemd/system) instead of user scope",
        type: "boolean",
      })
      .option("unit-name", {
        describe: "override the systemd unit filename",
        type: "string",
        default: SERVICE_NAME,
      })
      .parserConfiguration({ "populate--": true }),
  handler: async (args) => {
    if (!requireSystemd()) return
    const scope = Systemd.unitScope(args)
    const unitPath = scope === "system"
      ? Systemd.systemUnitPath(args["unit-name"])
      : Systemd.userUnitPath(args["unit-name"])

    const network = resolveNetworkOptionsNoConfig(args)
    const binary = resolveBinary()
    const argv = resolveExec({
      binary,
      hostname: network.hostname,
      port: network.port,
      mdns: network.mdns,
      "mdns-domain": network.mdnsDomain,
      cors: network.cors,
      extra: args["--"],
    })

    const unit = Systemd.renderUnit({
      description: DESCRIPTION,
      execStart: argv,
      user: scope === "user",
    })

    const tmp = unitPath + ".tmp"
    await mkdir(path.dirname(unitPath), { recursive: true })
    await writeFile(tmp, unit, "utf8")
    await rename(tmp, unitPath)

    const reload = await systemctlRunner.current(["daemon-reload"], scope)
    if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`)

    const enable = await systemctlRunner.current(["enable", args["unit-name"]], scope)
    if (enable.code !== 0) throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`)

    const start = await systemctlRunner.current(["start", args["unit-name"]], scope)

    console.log(`Installed ${args["unit-name"]} (${scope})`)
    console.log(`  unit: ${unitPath}`)
    console.log(`  exec: ${binary.join(" ")} console …`)
    console.log(`  enabled: yes`)
    if (start.code === 0) {
      console.log(`  started: yes`)
    } else {
      console.warn(`  started: no (${start.stderr || start.stdout.trim()})`)
    }
    if (scope === "user") {
      console.log("View logs with: journalctl --user -u kilo-console -f")
      console.log("To enable persistence across logout, run: loginctl enable-linger $USER")
    } else {
      console.log("View logs with: journalctl -u kilo-console -f")
    }
  },
})

const UninstallCommand = cmd({
  command: "uninstall",
  describe: "remove the Kilo Console systemd service",
  builder: (yargs) =>
    yargs
      .option("system", {
        describe: "remove a system-wide unit instead of the user unit",
        type: "boolean",
      })
      .option("unit-name", {
        describe: "override the systemd unit filename",
        type: "string",
        default: SERVICE_NAME,
      }),
  handler: async (args) => {
    if (!requireSystemd()) return
    const scope = Systemd.unitScope(args)
    const unitPath = scope === "system"
      ? Systemd.systemUnitPath(args["unit-name"])
      : Systemd.userUnitPath(args["unit-name"])

    if (!existsSync(unitPath)) {
      console.log(`not installed: ${unitPath}`)
      return
    }

    await systemctlRunner.current(["stop", args["unit-name"]], scope)
    await systemctlRunner.current(["disable", args["unit-name"]], scope)
    const { unlink } = await import("fs/promises")
    await unlink(unitPath)
    await systemctlRunner.current(["daemon-reload"], scope)

    console.log(`Removed ${args["unit-name"]} (${scope})`)
  },
})

const EnableCommand = cmd({
  command: "enable",
  describe: "enable Kilo Console systemd service to auto-start",
  builder: (yargs) =>
    yargs
      .option("system", { type: "boolean" })
      .option("unit-name", { type: "string", default: SERVICE_NAME }),
  handler: async (args) => {
    if (!requireSystemd()) return
    const scope = Systemd.unitScope(args)
    const out = await systemctlRunner.current(["enable", args["unit-name"]], scope)
    if (out.code !== 0) throw new Error(out.stderr || out.stdout)
    console.log(`Enabled ${args["unit-name"]} (${scope})`)
  },
})

const DisableCommand = cmd({
  command: "disable",
  describe: "disable Kilo Console systemd service auto-start",
  builder: (yargs) =>
    yargs
      .option("system", { type: "boolean" })
      .option("unit-name", { type: "string", default: SERVICE_NAME }),
  handler: async (args) => {
    if (!requireSystemd()) return
    const scope = Systemd.unitScope(args)
    const out = await systemctlRunner.current(["disable", args["unit-name"]], scope)
    if (out.code !== 0) throw new Error(out.stderr || out.stdout)
    console.log(`Disabled ${args["unit-name"]} (${scope})`)
  },
})

const IsEnabledCommand = cmd({
  command: "is-enabled",
  describe: "print whether the Kilo Console systemd service is enabled",
  builder: (yargs) =>
    yargs
      .option("system", { type: "boolean" })
      .option("unit-name", { type: "string", default: SERVICE_NAME }),
  handler: async (args) => {
    if (!requireSystemd()) return
    const scope = Systemd.unitScope(args)
    const out = await systemctlRunner.current(["is-enabled", args["unit-name"]], scope)
    const state = (out.stdout || out.stderr).trim() || "unknown"
    console.log(state)
    if (out.code !== 0) process.exitCode = out.code
  },
})

export const __test__ = {
  resolveExec,
  resolveBinary,
  requireSystemd,
  InstallCommand,
  UninstallCommand,
  EnableCommand,
  DisableCommand,
  IsEnabledCommand,
}

export const KiloConsoleCommand = cmd({
  command: "console",
  describe: "open or stop the local Kilo Console",
  builder: (yargs: Argv) =>
    yargs
      .command(OpenCommand)
      .command(StopCommand)
      .command(InstallCommand)
      .command(UninstallCommand)
      .command(EnableCommand)
      .command(DisableCommand)
      .command(IsEnabledCommand)
      .demandCommand(),
  handler: async () => {},
})