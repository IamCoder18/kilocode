import { existsSync, openSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { ensureHome, getConfig } from "../config"
import type { Action, RunOptions, RunResult } from "../types"
import { parseScript as parseScriptFn } from "../script-parser"
import { DaemonServer } from "./server"
import type { DaemonHandshake, DaemonRequest, DaemonResponse } from "./protocol"

const SCRIPT_HEAD_TIMEOUT_MS = 30_000

function packageRoot(): string {
  // daemon/client.ts → ../../ → packages/kilo-world/
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..")
}

// Lookup chain for the compiled daemon entry:
//   1. $KILO_WORLD_DAEMON_PATH — explicit override
//   2. world-daemon.js next to process.execPath — shipped alongside the kilo binary in both the
//      VS Code extension's bin/ directory and the @kilocode/cli-<platform> npm package
//   3. world-daemon.js next to argv[1] — covers the VS Code extension spawning `node dist/extension.js`
//      and a few other wrappers that pass a different process.execPath
//   4. <workspace>/packages/kilo-world/dist/entry.js — local dev after `bun run build`
function findCompiledEntry(): string | null {
  const override = process.env.KILO_WORLD_DAEMON_PATH
  if (override && existsSync(override)) return override

  const tried: string[] = []

  const sibling = join(dirname(process.execPath), "world-daemon.js")
  tried.push(sibling)
  if (existsSync(sibling)) return sibling

  // argv[1] is the script that was executed (often the same as execPath, but
  // different when process.execPath is a launcher like `node` or `bun` and
  // argv[1] is the actual JS file).
  const argv1 = process.argv[1]
  if (argv1) {
    const argvSibling = join(dirname(argv1), "world-daemon.js")
    if (!tried.includes(argvSibling)) tried.push(argvSibling)
    if (existsSync(argvSibling)) return argvSibling
  }

  const root = packageRoot()
  const candidate = join(root, "dist", "entry.js")
  tried.push(candidate)
  return existsSync(candidate) ? candidate : null
}

// Surfaces every path we tried so a missing-daemon error tells the user
// exactly where to drop `world-daemon.js` or how to set KILO_WORLD_DAEMON_PATH.
export function _debugTriedPaths(): string[] {
  const override = process.env.KILO_WORLD_DAEMON_PATH
  const sibling = join(dirname(process.execPath), "world-daemon.js")
  const argv1 = process.argv[1]
  const argvSibling = argv1 ? join(dirname(argv1), "world-daemon.js") : undefined
  const candidate = join(packageRoot(), "dist", "entry.js")
  return [override, sibling, argvSibling, candidate].filter((p): p is string => typeof p === "string")
}

function findSourceEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "entry.ts")
}

export namespace DaemonClient {
  export type CallOptions = {
    timeoutMs?: number
    silent?: boolean
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

  export async function ensureRunning(
    sessionID: string,
    opts: CallOptions & { idleMs?: number } = {},
  ): Promise<void> {
    if (isRunning(sessionID)) return
    const compiled = findCompiledEntry()
    // For Bun-compiled binaries (where process.execPath ends with `kilo` or
    // the cli name, not `bun`), `Bun.which("bun")` is the reliable check for
    // "is the bun runtime reachable from this process". Inside a Bun-compiled
    // binary, `Bun.which` reads bunfs + PATH.
    const bunAvailable = typeof Bun !== "undefined" && Bun.which("bun") !== null
    const logFd = openSync(DaemonServer.logPath(sessionID), "a")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KILO_WORLD_DAEMON: "1",
      KILO_WORLD_DAEMON_SESSION: sessionID,
      KILO_WORLD_DAEMON_SILENT: "1",
      ...(opts.idleMs !== undefined ? { KILO_WORLD_DAEMON_IDLE_MS: String(opts.idleMs) } : {}),
    }
    if (compiled) {
      const nodeBin = typeof Bun !== "undefined" ? (Bun.which("node") ?? "node") : "node"
      const child = spawn(
        nodeBin,
        [compiled, `--session=${sessionID}`, ...(opts.idleMs !== undefined ? [`--idle=${opts.idleMs}`] : [])],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env,
          // Hide the console window on Windows. Without this, every world()
          // call flashes a cmd.exe window at the user for the lifetime of
          // the daemon. Process stdio is already redirected to the log file,
          // so the window serves no purpose.
          windowsHide: true,
        },
      )
      child.unref()
    } else if (bunAvailable) {
      const bunBin = (typeof Bun !== "undefined" && Bun.which("bun")) || "bun"
      const proc = Bun.spawn(
        [
          bunBin,
          findSourceEntry(),
          `--session=${sessionID}`,
          ...(opts.idleMs !== undefined ? [`--idle=${opts.idleMs}`] : []),
        ],
        {
          stdout: logFd,
          stderr: logFd,
          stdin: "ignore",
          env,
        },
      )
      proc.unref()
    } else {
      const tried = _debugTriedPaths()
      throw new Error(
        `no compiled daemon and bun is unavailable; tried:\n` +
          tried.map((p) => `  - ${p}`).join("\n") +
          `\nFix: rebuild the opencode CLI (bun run script/build.ts --single from packages/opencode) ` +
          `so world-daemon.js lands next to the kilo binary, or set KILO_WORLD_DAEMON_PATH to the daemon's entry.js.`,
      )
    }
    const start = Date.now()
    while (Date.now() - start < SCRIPT_HEAD_TIMEOUT_MS) {
      if (isRunning(sessionID)) return
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

  export async function call(
    sessionID: string,
    req: DaemonRequest,
    opts: CallOptions = {},
  ): Promise<DaemonResponse> {
    await ensureRunning(sessionID, opts)
    return send(sessionID, req, opts.timeoutMs ?? 60_000)
  }

  export async function callScript(
    sessionID: string,
    script: string,
    _opts: CallOptions = {},
  ): Promise<DaemonResponse[]> {
    const segments = parseScript(script)
    const out: DaemonResponse[] = []
    for (const seg of segments) {
      out.push(await call(sessionID, { id: randomId(), verb: seg.verb, args: seg.args }))
    }
    return out
  }

  export async function stop(sessionID: string, opts: CallOptions = {}): Promise<boolean> {
    if (!isRunning(sessionID)) return false
    try {
      const resp = await call(
        sessionID,
        { id: randomId(), verb: "__shutdown__", args: [] },
        { timeoutMs: 5000, silent: true },
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

  function send(sessionID: string, req: DaemonRequest, timeoutMs: number): Promise<DaemonResponse> {
    const hs = DaemonServer.handshake(sessionID)
    if (!hs) throw new Error(`daemon handshake missing for session ${sessionID}`)
    // Tag every request with the daemon's auth token. The server returns 401
    // on mismatch so an unauthorized peer can't drive the browser.
    const authed: DaemonRequest = { ...req, auth: hs.token }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
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
        return (await res.json()) as DaemonResponse
      })
      .finally(() => clearTimeout(timer))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`daemon call timed out after ${timeoutMs}ms`)
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
  export async function startDaemon(
    sessionID: string,
    opts: { idleMs?: number } = {},
  ): Promise<StartResult> {
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
    } catch (err) {
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
    if (n <= 0) return 0
    return n
  }

  export async function setIdle(sessionID: string, idleMs: number): Promise<StartResult> {
    return startDaemon(sessionID, { idleMs: normalizeIdleMs(idleMs) })
  }

  export async function runViaSession(
    sessionID: string,
    script: string,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    const segments = parseScript(script)
    const startedAt = Date.now()
    const results: RunResult["results"] = []

    const daemonStartIdx = segments.findIndex((s) => s.verb === "daemon.start")
    let remaining = segments
    if (daemonStartIdx >= 0) {
      const start = segments[daemonStartIdx]!
      const idleRaw = flagString(start, "--idle")
      const idleMs = idleRaw === undefined ? 5 * 60_000 : Number(idleRaw)
      const result = await startDaemon(sessionID, { idleMs })
      results.push({
        ok: true,
        verb: "daemon.start",
        args: start.args,
        data: result,
        durationMs: 0,
      })
      remaining = segments.filter((_, i) => i !== daemonStartIdx)
    }

    if (remaining.length > 0) {
      const responses: DaemonResponse[] = []
      // Per-segment timeout. The previous hardcoded 15_000 was the reason
      // first-time navigation timed out — page load + first browser launch
      // can easily exceed 15s. Default 60s; the world tool can pass a
      // tighter or looser value via `opts.timeoutMs` (forwarded from the
      // tool's `timeout` parameter).
      const perSegmentTimeoutMs = opts.timeoutMs ?? 60_000
      for (const seg of remaining) {
        const r = await call(
          sessionID,
          { id: randomId(), verb: seg.verb, args: seg.args },
          { silent: true, timeoutMs: perSegmentTimeoutMs },
        )
        responses.push(r)
      }
      for (const r of responses) {
        const env = r.envelope as {
          ok?: boolean
          verb?: string
          durationMs?: number
          data?: unknown
          error?: string
          errors?: string[]
          screenshot?: { path: string; bytes: number }
          refs?: Array<{ ref: string; role: string; name: string; selector?: string }>
        }
        const ok = r.ok && env.ok !== false
        const errors = env.errors ?? []
        const data = env.data as { refs?: Array<{ ref: string; role: string; name: string; selector?: string }> } | undefined
        const result: (typeof results)[number] = {
          ok,
          verb: env.verb ?? "(unknown)",
          args: [],
          data: env.data,
          error: ok ? undefined : errors[0] ?? env.error ?? "unknown",
          durationMs: typeof env.durationMs === "number" ? env.durationMs : 0,
        }
        if (env.screenshot) {
          const sm = env.screenshot as { path: string; bytes: number; mime?: string }
          result.screenshot = { path: sm.path, bytes: sm.bytes, mime: sm.mime ?? "image/png" }
        }
        if (env.verb === "snapshot" && data?.refs) result.refs = data.refs
        results.push(result)
      }
    }

    return { ok: results.every((r) => r.ok), durationMs: Date.now() - startedAt, results }
  }
}

function actionToScript(action: { verb: string; args: string[] }): string {
  if (action.args.length === 0) return action.verb
  return `${action.verb} ${action.args
    .map((a) => (/[\s"';]/.test(a) ? JSON.stringify(a) : a))
    .join(" ")}`
}

function flagString(action: { verb: string; args: string[] }, name: string): string | undefined {
  for (let i = 0; i < action.args.length; i++) {
    const t = action.args[i]
    if (t === name) return action.args[i + 1]
    if (t?.startsWith(`${name}=`)) return t.slice(name.length + 1)
  }
  return undefined
}

void getConfig
void ensureHome
