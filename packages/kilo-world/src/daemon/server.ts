import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { ensureHome, getConfig } from "../config"
import type { DaemonHandshake, DaemonRequest, DaemonResponse } from "./protocol"

export type DispatchFn = (req: DaemonRequest) => Promise<Record<string, unknown>>

let installedDispatch: DispatchFn | null = null

export function setDispatch(fn: DispatchFn): void {
  installedDispatch = fn
}

const IDLE_TIMEOUT_MS_DEFAULT = 5 * 60_000

const NEVER_TIMEOUT = 0

export namespace DaemonServer {
  export type Options = {
    sessionID: string
    idleTimeoutMs?: number
    silent?: boolean
  }

  function safeSession(id: string): string {
    return id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96) || "default"
  }

  export function pidPath(sessionID: string): string {
    return join(ensureHome(getConfig().home), `daemon-${safeSession(sessionID)}.pid`)
  }

  export function handshakePath(sessionID: string): string {
    return join(ensureHome(getConfig().home), `daemon-${safeSession(sessionID)}.json`)
  }

  export function logPath(sessionID: string): string {
    return join(ensureHome(getConfig().home), `daemon-${safeSession(sessionID)}.log`)
  }

  export function handshake(sessionID: string): {
    pid: number
    startedAt: number
    url: string
    token: string
  } | null {
    const path = handshakePath(sessionID)
    if (!existsSync(path)) return null
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonHandshake>
      if (
        typeof data.pid !== "number" ||
        typeof data.url !== "string" ||
        typeof data.token !== "string"
      ) {
        return null
      }
      return { pid: data.pid, startedAt: data.startedAt ?? 0, url: data.url, token: data.token }
    } catch {
      return null
    }
  }

  function log(line: string, silent: boolean): void {
    if (!silent) process.stderr.write(`[kilo-world daemon] ${line}\n`)
  }

  export function isRunning(sessionID: string): boolean {
    const pidFile = pidPath(sessionID)
    if (!existsSync(pidFile)) return false
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    if (!Number.isFinite(pid)) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Remove pid/handshake files plus any leftover `.sock` file from the
  // pre-HTTP transport. Without the unlink a stale `.sock` from an older
  // daemon would just sit on disk forever.
  function cleanup(sessionID: string): void {
    const home = ensureHome(getConfig().home)
    for (const path of [
      pidPath(sessionID),
      handshakePath(sessionID),
      join(home, `daemon-${safeSession(sessionID)}.sock`),
    ]) {
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
    }
  }

  // Best-effort sweep of any orphan `.sock` files left behind by previous
  // daemons that ran on the pre-HTTP transport. Called once at start().
  function sweepLegacySocks(): void {
    const home = ensureHome(getConfig().home)
    let entries: string[]
    try {
      entries = readdirSync(home)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.startsWith("daemon-") || !name.endsWith(".sock")) continue
      try {
        unlinkSync(join(home, name))
      } catch {
        // already gone
      }
    }
  }

  let shutdownTimer: NodeJS.Timeout | null = null
  let lastActivityAt = Date.now()
  let currentIdleTimeoutMs = IDLE_TIMEOUT_MS_DEFAULT

  function currentRemainingMs(): number {
    if (currentIdleTimeoutMs === NEVER_TIMEOUT) return Number.POSITIVE_INFINITY
    return Math.max(0, currentIdleTimeoutMs - (Date.now() - lastActivityAt))
  }

  function scheduleShutdown(sessionID: string, delayMs: number, silent: boolean): void {
    if (shutdownTimer) clearTimeout(shutdownTimer)
    if (delayMs === NEVER_TIMEOUT) {
      log(`idle timer disabled for session ${sessionID} (never times out)`, silent)
      return
    }
    log(`idle timer reset for session ${sessionID}: ${delayMs}ms`, silent)
    lastActivityAt = Date.now()
    shutdownTimer = setTimeout(() => {
      log(`idle timeout for session ${sessionID}, shutting down`, silent)
      cleanup(sessionID)
      process.exit(0)
    }, delayMs)
  }

  function resetActivity(): void {
    if (currentIdleTimeoutMs === NEVER_TIMEOUT) return
    lastActivityAt = Date.now()
    if (shutdownTimer) clearTimeout(shutdownTimer)
    shutdownTimer = setTimeout(() => {
      cleanup(currentSessionIDForActivity)
      process.exit(0)
    }, currentIdleTimeoutMs)
  }

  let currentSessionIDForActivity = "default"

  function applyIdleMs(sessionID: string, idleMs: number, silent: boolean): { idleTimeoutMs: number; idleTimeoutRemainingMs: number } {
    const normalized = Math.max(0, Math.floor(idleMs))
    if (normalized === NEVER_TIMEOUT) {
      currentIdleTimeoutMs = NEVER_TIMEOUT
      if (shutdownTimer) clearTimeout(shutdownTimer)
      log(`idle timeout for session ${sessionID} set to never`, silent)
    } else {
      currentIdleTimeoutMs = normalized
      scheduleShutdown(sessionID, normalized, silent)
    }
    return { idleTimeoutMs: currentIdleTimeoutMs, idleTimeoutRemainingMs: currentRemainingMs() }
  }

  // Per-daemon auth token. Generated at `start()` and written to the handshake
  // file. Every inbound request must include it; otherwise the daemon returns
  // 401. This stops any other local process on a multi-user machine (or any
  // process running as the same user) from driving the browser by POSTing to
  // the daemon's HTTP endpoint.
  let currentAuthToken: string | null = null

  function readJsonBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const limit = 16 * 1024 * 1024
      req.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > limit) {
          reject(new Error(`request body exceeds ${limit} bytes`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", reject)
    })
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  async function handleCall(req: IncomingMessage, res: ServerResponse, sessionID: string): Promise<void> {
    let raw: string
    try {
      raw = await readJsonBody(req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const resp: DaemonResponse = { id: "parse", ok: false, envelope: {}, message: `bad body: ${message}` }
      writeJson(res, 400, resp)
      return
    }
    let action: DaemonRequest
    try {
      action = JSON.parse(raw) as DaemonRequest
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const resp: DaemonResponse = { id: "parse", ok: false, envelope: {}, message: `bad json: ${message}` }
      writeJson(res, 400, resp)
      return
    }
    if (!currentAuthToken || !action.auth || action.auth !== currentAuthToken) {
      writeJson(res, 401, { id: action.id ?? "auth", ok: false, envelope: {}, message: "unauthorized" })
      return
    }

    resetActivity()

    if (action.verb === "__ping__") {
      writeJson(res, 200, { id: action.id, ok: true, envelope: {}, message: "pong" })
      return
    }
    if (action.verb === "__shutdown__") {
      const resp: DaemonResponse = { id: action.id, ok: true, envelope: {}, message: "shutting down" }
      writeJson(res, 200, resp)
      setImmediate(() => {
        cleanup(sessionID)
        process.exit(0)
      })
      return
    }
    if (action.verb === "__status__") {
      const resp: DaemonResponse = {
        id: action.id,
        ok: true,
        envelope: {
          ok: true,
          running: true,
          pid: process.pid,
          sessionID: process.env["KILO_WORLD_DAEMON_SESSION"] ?? sessionID,
          uptimeMs: process.uptime() * 1000,
          idleTimeoutMs: currentIdleTimeoutMs,
          idleTimeoutRemainingMs: currentRemainingMs(),
        },
      }
      writeJson(res, 200, resp)
      return
    }
    if (action.verb === "__set_idle__") {
      const idleMs = Number(action.args[0] ?? IDLE_TIMEOUT_MS_DEFAULT)
      const out = applyIdleMs(sessionID, idleMs, true)
      writeJson(res, 200, { id: action.id, ok: true, envelope: { ok: true, ...out } })
      return
    }
    try {
      if (!installedDispatch) throw new Error("kilo-world daemon: dispatch not installed (entry.ts forgot to call setDispatch)")
      const envelope = await installedDispatch(action)
      const resp: DaemonResponse = {
        id: action.id,
        ok: envelope.ok !== false,
        envelope: envelope as Record<string, unknown>,
      }
      writeJson(res, 200, resp)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const resp: DaemonResponse = {
        id: action.id,
        ok: false,
        envelope: {
          ok: false,
          tool: "browser",
          verb: action.verb,
          duration_ms: 0,
          warnings: [],
          errors: [message],
          reason: message.length > 80 ? message.slice(0, 77) + "..." : message,
        },
      }
      writeJson(res, 200, resp)
    }
  }

  export async function start(opts: Options): Promise<Server> {
    const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS_DEFAULT
    const silent = opts.silent ?? false
    const sessionID = opts.sessionID
    currentSessionIDForActivity = sessionID
    currentIdleTimeoutMs = idleTimeoutMs
    lastActivityAt = Date.now()
    mkdirSync(ensureHome(getConfig().home), { recursive: true })
    sweepLegacySocks()
    if (isRunning(sessionID)) {
      throw new Error(`kilo-world daemon for session ${sessionID} is already running`)
    }
    cleanup(sessionID)
    currentAuthToken = randomBytes(32).toString("hex")
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/call") {
        void handleCall(req, res, sessionID).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          try {
            writeJson(res, 500, { id: "internal", ok: false, envelope: {}, message })
          } catch {
            // socket already closed
          }
        })
        return
      }
      writeJson(res, 404, { id: "not-found", ok: false, envelope: {}, message: `no route for ${req.method} ${req.url}` })
    })
    const host = "127.0.0.1"
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ host, port: 0, exclusive: false }, () => {
        server.off("error", reject)
        const addr = server.address()
        if (addr && typeof addr === "object") resolve(addr.port)
        else reject(new Error("server bound but no address returned"))
      })
    })
    const url = `http://${host}:${port}`
    writeFileSync(pidPath(sessionID), String(process.pid))
    const handshake: DaemonHandshake = {
      pid: process.pid,
      version: "0.1.0",
      startedAt: Date.now(),
      idleTimeoutMs,
      sessionID,
      url,
      token: currentAuthToken,
    }
    writeFileSync(handshakePath(sessionID), JSON.stringify(handshake, null, 2))
    log(
      `listening for session ${sessionID} at ${url} (pid=${process.pid}, idle=${
        idleTimeoutMs === NEVER_TIMEOUT ? "never" : `${idleTimeoutMs}ms`
      })`,
      silent,
    )
    if (idleTimeoutMs !== NEVER_TIMEOUT) {
      scheduleShutdown(sessionID, idleTimeoutMs, silent)
    }
    process.on("SIGTERM", () => {
      log("SIGTERM, shutting down", silent)
      cleanup(sessionID)
      process.exit(0)
    })
    process.on("SIGINT", () => {
      log("SIGINT, shutting down", silent)
      cleanup(sessionID)
      process.exit(0)
    })
    process.on("exit", () => cleanup(sessionID))
    return server
  }
}
