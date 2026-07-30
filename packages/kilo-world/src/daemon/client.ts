import { closeSync, existsSync, openSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { getConfig } from "../config"
import type { Action, RunOptions, RunResult } from "../types"
import { parseScript as parseScriptFn } from "../script-parser"
import { DaemonServer } from "./server"
import { isHandshake, isResponse, type DaemonRequest, type DaemonResponse } from "./protocol"

const SCRIPT_HEAD_TIMEOUT_MS = 30_000
const starts = new Map<string, Promise<void>>()

function findSourceEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "entry.ts")
}

function compiled(): boolean {
  if (typeof Bun === "undefined") return false
  return Bun.main.startsWith("/$bunfs/") || /^[a-z]:\/~bun\//i.test(Bun.main)
}

export namespace DaemonClient {
  export type CallOptions = {
    timeoutMs?: number
    silent?: boolean
    signal?: AbortSignal
  }

  export function isRunning(sessionID: string): boolean {
    return DaemonServer.isRunning(sessionID)
  }

  export function handshake(sessionID: string): {
    pid: number
    startedAt: number
    url: string
    token: string
  } | null {
    const path = DaemonServer.handshakePath(sessionID)
    if (!existsSync(path)) return null
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isHandshake(data)) return null
      return { pid: data.pid, startedAt: data.startedAt ?? 0, url: data.url, token: data.token }
    } catch {
      return null
    }
  }

  export async function ensureRunning(sessionID: string, opts: CallOptions & { idleMs?: number } = {}): Promise<void> {
    if (await ping(sessionID)) return
    const current = starts.get(sessionID)
    if (current) return current
    const pending = launch(sessionID, opts).finally(() => {
      if (starts.get(sessionID) === pending) starts.delete(sessionID)
    })
    starts.set(sessionID, pending)
    return pending
  }

  async function launch(sessionID: string, opts: CallOptions & { idleMs?: number }): Promise<void> {
    const embedded = compiled()
    const bun = typeof Bun !== "undefined" ? Bun.which("bun") : null
    const logFd = openSync(DaemonServer.logPath(sessionID), "a")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KILO_WORLD_DAEMON: "1",
      KILO_WORLD_DAEMON_SESSION: sessionID,
      KILO_WORLD_DAEMON_SILENT: "1",
      KILO_WORLD_PARENT_PID: String(process.pid),
      KILO_WORLD_HOME: getConfig().home,
      ...(opts.idleMs !== undefined ? { KILO_WORLD_DAEMON_IDLE_MS: String(opts.idleMs) } : {}),
    }
    if (!embedded && !bun) {
      closeSync(logFd)
      throw new Error(
        "cannot start the world daemon outside the compiled Kilo CLI because Bun is unavailable; install Bun for development.",
      )
    }
    const bin = embedded ? process.execPath : bun!
    const args = [
      ...(!embedded ? [findSourceEntry()] : []),
      `--session=${sessionID}`,
      ...(opts.idleMs !== undefined ? [`--idle=${opts.idleMs}`] : []),
    ]
    const state: { err?: Error } = {}
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
      windowsHide: true,
    })
    child.once("error", (err) => {
      state.err = err
    })
    child.unref()
    closeSync(logFd)
    const start = Date.now()
    while (Date.now() - start < SCRIPT_HEAD_TIMEOUT_MS) {
      if (opts.signal?.aborted) throw new Error("daemon startup aborted")
      if (state.err) throw new Error(`failed to start kilo-world daemon: ${state.err.message}`)
      if (await ping(sessionID)) return
      await new Promise((r) => setTimeout(r, 50))
    }
    // Surface the daemon log path so the user can read why startup failed.
    // The log is appended (openSync with "a") so any stderr/stdout from the
    // dying daemon process is captured there even when windowsHide is on.
    throw new Error(
      `kilo-world daemon for session ${sessionID} failed to start within ${SCRIPT_HEAD_TIMEOUT_MS}ms. ` +
        `Inspect the daemon log for the failure cause: ${DaemonServer.logPath(sessionID)}`,
    )
  }

  async function ping(sessionID: string): Promise<boolean> {
    if (!isRunning(sessionID)) return false
    const hs = handshake(sessionID)
    if (!hs) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    return fetch(`${hs.url}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: randomId(), verb: "__ping__", args: [], auth: hs.token }),
      signal: controller.signal,
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => clearTimeout(timer))
  }

  export async function call(sessionID: string, req: DaemonRequest, opts: CallOptions = {}): Promise<DaemonResponse> {
    await ensureRunning(sessionID, opts)
    return send(sessionID, req, opts)
  }

  export async function callScript(
    sessionID: string,
    script: string,
    opts: CallOptions = {},
  ): Promise<DaemonResponse[]> {
    const segments = parseScript(script)
    const out: DaemonResponse[] = []
    for (const seg of segments) {
      out.push(await call(sessionID, { id: randomId(), verb: seg.verb, args: seg.args }, opts))
      if (!out.at(-1)?.ok) break
    }
    return out
  }

  export async function stop(sessionID: string, opts: CallOptions = {}): Promise<boolean> {
    if (!isRunning(sessionID)) return false
    try {
      const resp = await call(
        sessionID,
        { id: randomId(), verb: "__shutdown__", args: [] },
        { ...opts, timeoutMs: opts.timeoutMs ?? 5000, silent: true },
      )
      return resp.ok
    } catch {
      return false
    }
  }

  export function parseScript(text: string): Action[] {
    return parseScriptFn(text)
  }

  function randomId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  function send(sessionID: string, req: DaemonRequest, opts: CallOptions): Promise<DaemonResponse> {
    const hs = DaemonServer.handshake(sessionID)
    if (!hs) throw new Error(`daemon handshake missing for session ${sessionID}`)
    // Tag every request with the daemon's auth token. The server returns 401
    // on mismatch so an unauthorized peer can't drive the browser.
    const authed: DaemonRequest = { ...req, auth: hs.token }
    const controller = new AbortController()
    const timeout = opts.timeoutMs ?? 60_000
    const state = { timeout: false }
    const abort = () => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    opts.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => {
      state.timeout = true
      controller.abort()
    }, timeout)
    return fetch(`${hs.url}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authed),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401) throw new Error(`daemon rejected request: unauthorized`)
          const text = await res.text().catch(() => "")
          throw new Error(`daemon HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        const data: unknown = await res.json()
        if (!isResponse(data)) throw new Error("daemon returned an invalid response")
        return data
      })
      .finally(() => {
        clearTimeout(timer)
        opts.signal?.removeEventListener("abort", abort)
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          if (state.timeout) throw new Error(`daemon call timed out after ${timeout}ms`)
          throw new Error("daemon call aborted")
        }
        throw err
      })
  }

  export type StartResult = {
    started: boolean
    idleMs: number
    idleMsRemaining: number
    pid?: number
  }

  /**
   * Manually start (or re-configure) the per-session browser daemon.
   * `idleMs` of 0 means "never time out" — the daemon stays alive until
   * explicitly stopped via `stop()` or a `daemon.stop` verb.
   */
  export async function startDaemon(sessionID: string, opts: { idleMs?: number } = {}): Promise<StartResult> {
    const idleMs = normalizeIdleMs(opts.idleMs)
    const wasRunning = isRunning(sessionID)
    if (wasRunning) {
      const resp = await call(
        sessionID,
        { id: randomId(), verb: "__set_idle__", args: [String(idleMs)] },
        { silent: true, timeoutMs: 5000 },
      )
      const data = (resp.envelope ?? {}) as {
        idleTimeoutMs?: number
        idleTimeoutRemainingMs?: number
      }
      const hs = handshake(sessionID)
      return {
        started: false,
        idleMs: data.idleTimeoutMs ?? idleMs,
        idleMsRemaining: data.idleTimeoutRemainingMs ?? idleMs,
        ...(hs ? { pid: hs.pid } : {}),
      }
    }
    await ensureRunning(sessionID, { idleMs, silent: true })
    const status = await statusOf(sessionID)
    return {
      started: true,
      idleMs: status.idleMs,
      idleMsRemaining: status.idleMsRemaining,
      ...(status.pid !== undefined ? { pid: status.pid } : {}),
    }
  }

  export type Status = {
    running: boolean
    pid?: number
    sessionID?: string
    idleMs: number
    idleMsRemaining: number
  }

  export async function statusOf(sessionID: string): Promise<Status> {
    if (!isRunning(sessionID)) {
      return { running: false, idleMs: 0, idleMsRemaining: 0 }
    }
    try {
      const resp = await call(
        sessionID,
        { id: randomId(), verb: "__status__", args: [] },
        { silent: true, timeoutMs: 5000 },
      )
      const data = (resp.envelope ?? {}) as {
        pid?: number
        sessionID?: string
        idleTimeoutMs?: number
        idleTimeoutRemainingMs?: number
      }
      return {
        running: true,
        ...(data.pid !== undefined ? { pid: data.pid } : {}),
        ...(data.sessionID ? { sessionID: data.sessionID } : {}),
        idleMs: data.idleTimeoutMs ?? 0,
        idleMsRemaining: data.idleTimeoutRemainingMs ?? 0,
      }
    } catch {
      return {
        running: false,
        idleMs: 0,
        idleMsRemaining: 0,
      }
    }
  }

  function normalizeIdleMs(value: number | undefined): number {
    if (value === undefined) return 5 * 60_000
    const n = Math.floor(value)
    if (!Number.isFinite(n)) throw new Error("idle timeout must be a finite number")
    if (n <= 0) return 0
    return n
  }

  export async function setIdle(sessionID: string, idleMs: number): Promise<StartResult> {
    return startDaemon(sessionID, { idleMs: normalizeIdleMs(idleMs) })
  }

  export async function runViaSession(sessionID: string, script: string, opts: RunOptions = {}): Promise<RunResult> {
    const segments = parseScript(script)
    const startedAt = Date.now()
    const results: RunResult["results"] = []

    for (const seg of segments) {
      if (opts.signal?.aborted) throw new Error("world script aborted")
      if (seg.verb === "daemon.start") {
        const idle = flagString(seg, "--idle")
        const data = await startDaemon(sessionID, { idleMs: idle === undefined ? 5 * 60_000 : Number(idle) })
        results.push({ ok: true, verb: seg.verb, args: seg.args, data, durationMs: 0 })
        continue
      }
      const response = await call(
        sessionID,
        {
          id: randomId(),
          verb: seg.verb,
          args: seg.args,
          ...(opts.directory ? { directory: opts.directory } : {}),
          ...(opts.config ? { config: opts.config } : {}),
        },
        { silent: true, timeoutMs: opts.timeoutMs, signal: opts.signal },
      )
      const result = responseResult(response, seg)
      results.push(result)
      if (!result.ok) break
    }

    return { ok: results.every((r) => r.ok), durationMs: Date.now() - startedAt, results }
  }
}

function responseResult(response: DaemonResponse, action: Action): RunResult["results"][number] {
  const env = response.envelope
  const ok = response.ok && env.ok !== false
  const data = record(env.data) ? env.data : undefined
  const errors = Array.isArray(env.errors) ? env.errors.filter((item): item is string => typeof item === "string") : []
  const shot = screenshot(env.screenshot)
  const refs = Array.isArray(data?.refs) ? data.refs.filter(isRef) : []
  return {
    ok,
    verb: typeof env.verb === "string" ? env.verb : action.verb,
    args: action.args,
    data: env.data,
    ...(!ok ? { error: errors[0] ?? (typeof env.error === "string" ? env.error : response.message) ?? "unknown" } : {}),
    durationMs: typeof env.durationMs === "number" ? env.durationMs : 0,
    ...(shot
      ? {
          screenshot: {
            path: shot.path,
            bytes: shot.bytes,
            mime: shot.mime ?? "image/png",
          },
        }
      : {}),
    ...(env.verb === "snapshot" && refs.length > 0 ? { refs } : {}),
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function screenshot(value: unknown): { path: string; bytes: number; mime?: string } | undefined {
  if (!record(value) || typeof value.path !== "string" || typeof value.bytes !== "number") return undefined
  if (value.mime !== undefined && typeof value.mime !== "string") return undefined
  return { path: value.path, bytes: value.bytes, ...(value.mime ? { mime: value.mime } : {}) }
}

function isRef(value: unknown): value is { ref: string; role: string; name: string; selector?: string } {
  if (!record(value)) return false
  if (typeof value.ref !== "string" || typeof value.role !== "string" || typeof value.name !== "string") return false
  return value.selector === undefined || typeof value.selector === "string"
}

function flagString(action: { verb: string; args: string[] }, name: string): string | undefined {
  for (let i = 0; i < action.args.length; i++) {
    const t = action.args[i]
    if (t === name) return action.args[i + 1]
    if (t?.startsWith(`${name}=`)) return t.slice(name.length + 1)
  }
  return undefined
}
