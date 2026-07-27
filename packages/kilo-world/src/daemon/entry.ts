#!/usr/bin/env node
import { DaemonServer, setDispatch } from "./server"
import { dispatch } from "./dispatch"

async function main(): Promise<void> {
  const sessionArg = process.argv.find((a) => a.startsWith("--session="))
  const idleArg = process.argv.find((a) => a.startsWith("--idle="))
  const sessionID = sessionArg ? sessionArg.slice("--session=".length) : "default"
  if (!sessionID) throw new Error("--session=<id> is required")
  const envIdle = process.env["KILO_WORLD_DAEMON_IDLE_MS"]
  const idleRaw = idleArg ? idleArg.slice("--idle=".length) : envIdle
  const idleMs = idleRaw === undefined ? undefined : Number(idleRaw)
  setDispatch(dispatch)
  await DaemonServer.start({
    sessionID,
    silent: process.env["KILO_WORLD_DAEMON_SILENT"] === "1",
    ...(Number.isFinite(idleMs) ? { idleTimeoutMs: idleMs } : {}),
  })
  await new Promise(() => {
    // daemon stays alive until idle timeout or SIGTERM
  })
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`daemon fatal: ${message}\n`)
  process.exit(1)
})
