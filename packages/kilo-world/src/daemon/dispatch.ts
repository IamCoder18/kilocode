import type { Action, ActionResult, RunOptions } from "../types"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { DaemonServer } from "./server"
import { setConfig } from "../config"
import { Status } from "../commands/browser/status"
import { Navigate } from "../commands/browser/navigate"
import { Snapshot } from "../commands/browser/snapshot"
import { Click } from "../commands/browser/click"
import { Type } from "../commands/browser/type"
import { Fill } from "../commands/browser/fill"
import { PressKey } from "../commands/browser/press-key"
import { Hover } from "../commands/browser/hover"
import { Drag } from "../commands/browser/drag"
import { Scroll } from "../commands/browser/scroll"
import { Screenshot } from "../commands/browser/screenshot"
import { Evaluate } from "../commands/browser/evaluate"
import { WaitFor } from "../commands/browser/wait-for"
import { Tabs } from "../commands/browser/tabs"
import { Cookies } from "../commands/browser/cookies"
import { Close } from "../commands/browser/close"
import { Runner } from "../core/browser/runner"

// Keep the command graph explicit so Bun includes Playwright and every command
// in the Kilo executable that is reused for daemon mode.
export async function dispatch(action: Action, opts: RunOptions = {}): Promise<ActionResult> {
  opts.signal?.throwIfAborted()
  const task = execute(action).then((result) => {
    opts.signal?.throwIfAborted()
    return result
  })
  if (!opts.signal) return task
  const signal = opts.signal
  const state: { reject?: (err: Error) => void } = {}
  const stop = () => {
    void Runner.shutdown().finally(() => state.reject?.(new Error("world action aborted")))
  }
  const abort = new Promise<never>((_, reject) => {
    state.reject = reject
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) stop()
  })
  return Promise.race([task, abort]).finally(() => signal.removeEventListener("abort", stop))
}

async function execute(action: Action): Promise<ActionResult> {
  const startedAt = Date.now()
  try {
    if (action.config) setConfig(action.config)
    const verb = action.verb
    if (verb === "status") {
      return ok(action, startedAt, await Status.run())
    }
    if (verb === "daemon.status") {
      return {
        ok: true,
        verb,
        args: action.args,
        data: DaemonServer.status(),
        durationMs: Date.now() - startedAt,
      }
    }
    if (verb === "daemon.stop") {
      return ok(action, startedAt, { stopping: true })
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
        if (hs) sessions.push({ sessionID: hs.sessionID ?? id, pid: hs.pid, startedAt: hs.startedAt })
      }
      return ok(action, startedAt, { sessions })
    }
    if (verb === "navigate") {
      const url = required(action, "--url")
      const timeout = numberFlag(action, "--timeout")
      return ok(
        action,
        startedAt,
        await Navigate.run({
          url,
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(flagString(action, "--wait") ? { wait: flagString(action, "--wait") } : {}),
          ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        }),
      )
    }
    if (verb === "snapshot") {
      const data = await Snapshot.run(flagString(action, "--session"))
      return { ...ok(action, startedAt, data), refs: data.refs }
    }
    if (verb === "click") {
      const timeout = numberFlag(action, "--timeout")
      return ok(
        action,
        startedAt,
        await Click.run({
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        }),
      )
    }
    if (verb === "type") {
      const text = required(action, "--text")
      const delay = numberFlag(action, "--delay")
      return ok(
        action,
        startedAt,
        await Type.run({
          text,
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
          ...(delay !== undefined ? { delay } : {}),
        }),
      )
    }
    if (verb === "fill") {
      const value = required(action, "--value")
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
      return ok(
        action,
        startedAt,
        await Scroll.run({
          dx: numberFlag(action, "--dx") ?? 0,
          dy: numberFlag(action, "--dy") ?? 0,
          ...(flagString(action, "--ref") ? { ref: flagString(action, "--ref") } : {}),
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "screenshot") {
      const typeRaw = flagString(action, "--type")
      const wait = numberFlag(action, "--wait")
      const quality = numberFlag(action, "--quality")
      const data = await Screenshot.run({
        out: resolvePath(action, required(action, "--out")),
        ...(hasFlag(action, "--full") ? { full: true } : {}),
        ...(wait !== undefined ? { waitMs: wait } : {}),
        ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        ...(typeRaw === "png" || typeRaw === "jpeg" ? { type: typeRaw } : {}),
        ...(quality !== undefined ? { quality } : {}),
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
      const timeout = numberFlag(action, "--timeout")
      return ok(
        action,
        startedAt,
        await WaitFor.run({
          ...(flagString(action, "--selector") ? { selector: flagString(action, "--selector") } : {}),
          ...(flagString(action, "--text") ? { text: flagString(action, "--text") } : {}),
          ...(flagString(action, "--url") ? { url: flagString(action, "--url") } : {}),
          ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
          ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
        }),
      )
    }
    if (verb === "tabs") return ok(action, startedAt, await dispatchTabs(action))
    if (verb === "cookies") return ok(action, startedAt, await dispatchCookies(action))
    if (verb === "close") {
      return ok(action, startedAt, await Close.run(flagString(action, "--session")))
    }
    if (verb === "shutdown") {
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
  if (sub === "list") return Tabs.list(flagString(action, "--session"))
  if (sub === "open") {
    return Tabs.open({
      url: required(action, "--url"),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "select") {
    return Tabs.select({
      index: requiredNumber(action, "--index"),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  if (sub === "close") {
    const idx = flagString(action, "--index")
    return Tabs.close({
      ...(idx !== undefined ? { index: requiredNumber(action, "--index") } : {}),
      ...(flagString(action, "--session") ? { session: flagString(action, "--session") } : {}),
    })
  }
  throw new Error(`unknown tabs subcommand: ${sub}`)
}

async function dispatchCookies(action: Action): Promise<unknown> {
  const sub = action.args[0] ?? "get"
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
  const target = resolvePath(action, file)
  if (!existsSync(target)) throw new Error(`--js-file not found: ${target}`)
  return readFileSync(target, "utf8")
}

function resolvePath(action: Action, file: string): string {
  if (path.isAbsolute(file)) return file
  if (!action.directory) return file
  return path.resolve(action.directory, file)
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

function numberFlag(action: Action, name: string): number | undefined {
  const value = flagString(action, name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`)
  return number
}

function requiredNumber(action: Action, name: string): number {
  const value = numberFlag(action, name)
  if (value === undefined) throw new Error(`missing required flag: ${name}`)
  return value
}
