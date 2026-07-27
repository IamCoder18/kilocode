import type { Action, ActionResult, RunOptions } from "../types"
import { existsSync, readFileSync } from "node:fs"
import { DaemonServer } from "./server"

// Commands and the Runner namespace are lazy-imported so that consumers of the
// barrel (notably the opencode CLI binary, which only uses DaemonClient for
// IPC) don't pull `playwright` + `chromium-bidi` into their bundle graph.
// Bun's bundler follows dynamic `import()` calls when tracing the module
// graph, so even though each `cmd()` call is a runtime dynamic import, the
// *string* it imports is constructed at call time and isn't statically
// resolved by the bundler.
const cmdCache = new Map<string, Promise<unknown>>()
const cmd = <T>(specifier: string, key: string): Promise<T> => {
  const k = `${specifier}#${key}`
  let p = cmdCache.get(k)
  if (!p) {
    p = import(/* @vite-ignore */ specifier) as Promise<unknown>
    cmdCache.set(k, p)
  }
  return p as Promise<T>
}

export async function dispatch(action: Action, _opts: RunOptions = {}): Promise<ActionResult> {
  const startedAt = Date.now()
  try {
    const verb = action.verb
    if (verb === "status") {
      const { Status } = await cmd<typeof import("../commands/browser/status")>("../commands/browser/status", "Status")
      return ok(action, startedAt, await Status.run())
    }
    if (verb === "daemon.status") {
      return {
        ok: true,
        verb,
        args: action.args,
        data: {
          running: true,
          pid: process.pid,
          sessionID: process.env["KILO_WORLD_DAEMON_SESSION"] ?? null,
          uptimeMs: process.uptime() * 1000,
        },
        durationMs: Date.now() - startedAt,
      }
    }
    if (verb === "daemon.stop") {
      const resp = ok(action, startedAt, { stopping: true })
      setImmediate(() => process.exit(0))
      return resp
    }
    if (verb === "daemon.list") {
      const { ensureHome, getConfig } = await import("../config")
      const home = ensureHome(getConfig().home)
      const { readdirSync } = await import("node:fs")
      const files = readdirSync(home).filter((f) => f.startsWith("daemon-") && f.endsWith(".pid"))
      const sessions: Array<{ sessionID: string; pid: number; startedAt: number }> = []
      for (const f of files) {
        const id = f.slice("daemon-".length, -".pid".length)
        const hs = DaemonServer.handshake(id)
        if (hs) sessions.push({ sessionID: id, ...hs })
      }
      return ok(action, startedAt, { sessions })
    }
    if (verb === "navigate") {
      const url = required(action, "--url")
      const { Navigate } = await cmd<typeof import("../commands/browser/navigate")>(
        "../commands/browser/navigate",
        "Navigate",
      )
      return ok(
        action,
        startedAt,
        await Navigate.run({
          url,
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(flagString(action, "--wait") ? { wait: flagString(action, "--wait") } : {}),
          ...(hasFlag(action, "--anti-detect") ? { antiDetect: true } : {}),
          ...(flagString(action, "--timeout") ? { timeoutMs: Number(flagString(action, "--timeout")) } : {}),
        }),
      )
    }
    if (verb === "snapshot") {
      const { Snapshot } = await cmd<typeof import("../commands/browser/snapshot")>(
        "../commands/browser/snapshot",
        "Snapshot",
      )
      return ok(action, startedAt, await Snapshot.run(flagString(action, "--session")))
    }
    if (verb === "click") {
      const { Click } = await cmd<typeof import("../commands/browser/click")>("../commands/browser/click", "Click")
      return ok(
        action,
        startedAt,
        await Click.run({
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(flagString(action, "--timeout") ? { timeoutMs: Number(flagString(action, "--timeout")) } : {}),
        }),
      )
    }
    if (verb === "type") {
      const text = required(action, "--text")
      const { Type } = await cmd<typeof import("../commands/browser/type")>("../commands/browser/type", "Type")
      return ok(
        action,
        startedAt,
        await Type.run({
          text,
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(flagString(action, "--delay") ? { delay: Number(flagString(action, "--delay")) } : {}),
        }),
      )
    }
    if (verb === "fill") {
      const value = required(action, "--value")
      const { Fill } = await cmd<typeof import("../commands/browser/fill")>("../commands/browser/fill", "Fill")
      return ok(
        action,
        startedAt,
        await Fill.run({
          value,
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(hasFlag(action, "--force") ? { force: true } : {}),
        }),
      )
    }
    if (verb === "press-key") {
      const { PressKey } = await cmd<typeof import("../commands/browser/press-key")>(
        "../commands/browser/press-key",
        "PressKey",
      )
      return ok(
        action,
        startedAt,
        await PressKey.run({
          chord: required(action, "--chord"),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "hover") {
      const { Hover } = await cmd<typeof import("../commands/browser/hover")>(
        "../commands/browser/hover",
        "Hover",
      )
      return ok(
        action,
        startedAt,
        await Hover.run({
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "drag") {
      const { Drag } = await cmd<typeof import("../commands/browser/drag")>("../commands/browser/drag", "Drag")
      return ok(
        action,
        startedAt,
        await Drag.run({
          from: required(action, "--from"),
          to: required(action, "--to"),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "scroll") {
      const { Scroll } = await cmd<typeof import("../commands/browser/scroll")>(
        "../commands/browser/scroll",
        "Scroll",
      )
      return ok(
        action,
        startedAt,
        await Scroll.run({
          dx: Number(flagString(action, "--dx") ?? "0"),
          dy: Number(flagString(action, "--dy") ?? "0"),
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "screenshot") {
      const typeRaw = flagString(action, "--type")
      const { Screenshot } = await cmd<typeof import("../commands/browser/screenshot")>(
        "../commands/browser/screenshot",
        "Screenshot",
      )
      const data = await Screenshot.run({
        out: required(action, "--out"),
        ...(hasFlag(action, "--full") ? { full: true } : {}),
        ...(flagString(action, "--wait") ? { waitMs: Number(flagString(action, "--wait")) } : {}),
        ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        ...(typeRaw === "png" || typeRaw === "jpeg" ? { type: typeRaw } : {}),
        ...(flagString(action, "--quality") ? { quality: Number(flagString(action, "--quality")) } : {}),
      })
      return {
        ok: true,
        verb: action.verb,
        args: action.args,
        data,
        durationMs: Date.now() - startedAt,
        screenshot: { path: data.out, bytes: data.bytes, mime: data.mime },
      }
    }
    if (verb === "evaluate") {
      const js = await resolveEvaluateJs(action)
      const { Evaluate } = await cmd<typeof import("../commands/browser/evaluate")>(
        "../commands/browser/evaluate",
        "Evaluate",
      )
      return ok(
        action,
        startedAt,
        await Evaluate.run({
          js,
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "wait-for") {
      const { WaitFor } = await cmd<typeof import("../commands/browser/wait-for")>(
        "../commands/browser/wait-for",
        "WaitFor",
      )
      return ok(
        action,
        startedAt,
        await WaitFor.run({
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--text") ? { text: flagString(action, "--text") } : {}),
          ...(flagString(action, "--url") ? { url: flagString(action, "--url") } : {}),
          ...(flagString(action, "--timeout") ? { timeoutMs: Number(flagString(action, "--timeout")) } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "tabs") return ok(action, startedAt, await dispatchTabs(action))
    if (verb === "cookies") return ok(action, startedAt, await dispatchCookies(action))
    if (verb === "close") {
      const { Close } = await cmd<typeof import("../commands/browser/close")>("../commands/browser/close", "Close")
      return ok(action, startedAt, await Close.run(flagString(action, "--session")))
    }
    if (verb === "shutdown") {
      const { Runner } = await cmd<typeof import("../core/browser/runner")>(
        "../core/browser/runner",
        "Runner",
      )
      await Runner.shutdown()
      return ok(action, startedAt, { shutdown: "browser" })
    }
    throw new Error(`unknown verb: ${verb}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      verb: action.verb,
      args: action.args,
      error: message,
      durationMs: Date.now() - startedAt,
    }
  }
}

async function dispatchTabs(action: Action): Promise<unknown> {
  const sub = action.args[0] ?? "list"
  const { Tabs } = await cmd<typeof import("../commands/browser/tabs")>("../commands/browser/tabs", "Tabs")
  if (sub === "list") return Tabs.list(flagString(action, "--session"))
  if (sub === "open") {
    return Tabs.open({
      url: required(action, "--url"),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "select") {
    return Tabs.select({
      index: Number(required(action, "--index")),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "close") {
    const idx = flagString(action, "--index")
    return Tabs.close({
      ...(idx ? { index: Number(idx) } : {}),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  throw new Error(`unknown tabs subcommand: ${sub}`)
}

async function dispatchCookies(action: Action): Promise<unknown> {
  const sub = action.args[0] ?? "get"
  const { Cookies } = await cmd<typeof import("../commands/browser/cookies")>(
    "../commands/browser/cookies",
    "Cookies",
  )
  if (sub === "get") {
    return Cookies.get({
      ...(flagString(action, "--domain") ? { domain: flagString(action, "--domain") } : {}),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "set") {
    return Cookies.set({
      name: required(action, "--name"),
      value: required(action, "--value"),
      domain: required(action, "--domain"),
      ...(flagString(action, "--path") ? { path: flagString(action, "--path") } : {}),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "clear") {
    return Cookies.clear({
      ...(flagString(action, "--domain") ? { domain: flagString(action, "--domain") } : {}),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  throw new Error(`unknown cookies subcommand: ${sub}`)
}

function ok(action: Action, startedAt: number, data: unknown): ActionResult {
  return {
    ok: true,
    verb: action.verb,
    args: action.args,
    data,
    durationMs: Date.now() - startedAt,
  }
}

async function resolveEvaluateJs(action: Action): Promise<string> {
  const inline = flagString(action, "--js")
  if (inline !== undefined) return inline
  const file = flagString(action, "--js-file")
  if (file === undefined) throw new Error("evaluate requires --js <code> or --js-file <path>")
  if (!existsSync(file)) throw new Error(`--js-file not found: ${file}`)
  return readFileSync(file, "utf8")
}

function flagString(action: Action, name: string): string | undefined {
  for (let i = 0; i < action.args.length; i++) {
    const t = action.args[i]
    if (t === name) return action.args[i + 1]
    if (t?.startsWith(`${name}=`)) return t.slice(name.length + 1)
  }
  return undefined
}

function hasFlag(action: Action, name: string): boolean {
  return action.args.includes(name)
}

function required(action: Action, name: string): string {
  const v = flagString(action, name)
  if (v === undefined) throw new Error(`missing required flag: ${name}`)
  return v
}