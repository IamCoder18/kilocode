import { existsSync, mkdirSync, rmSync } from "node:fs"
import childProcess, { type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process"
import { join } from "node:path"
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright"
import { ensureHome, getConfig } from "../../config"
import { Launch } from "./launch"
import type { BrowserCapability, SessionInfo } from "../../types"

type Live = {
  name: string
  context: BrowserContext
  browser: Browser
  active: Page
  home: string
}

let activeBrowser: Browser | null = null
let pending: Promise<Browser> | null = null
const activeContexts: Map<string, Live> = new Map()
const sessions: Map<string, SessionInfo> = new Map()

function home(): string {
  return ensureHome(getConfig().home)
}

function track(name: string, url?: string): void {
  const now = Date.now()
  const existing = sessions.get(name)
  sessions.set(name, {
    name,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    ...(url ? { lastUrl: url } : {}),
  })
}

function buildLaunchOptions(): LaunchOptions {
  const opts = Launch.fromConfig(getConfig())
  const out: LaunchOptions = {
    headless: opts.headless,
    timeout: opts.timeoutMs,
    args: Launch.launchArgs(opts),
  }
  if (opts.executablePath) {
    out.executablePath = opts.executablePath
  }
  return out
}

async function launch(timeout?: number): Promise<Browser> {
  const opts = buildLaunchOptions()
  if (timeout !== undefined) opts.timeout = timeout
  if (process.platform !== "win32") return chromium.launch(opts)

  // Playwright's browser process launcher omits windowsHide. Patch the shared
  // child_process binding only for the duration of launch so its supported
  // headless-shell executable does not flash a console window.
  type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  const api = childProcess as unknown as { spawn: Spawn; spawnSync: typeof childProcess.spawnSync }
  const spawn = api.spawn
  const sync = api.spawnSync
  api.spawn = (command, args, options) => spawn(command, args, { ...options, windowsHide: true })
  api.spawnSync = ((command: string, args?: readonly string[] | SpawnSyncOptions, options?: SpawnSyncOptions) => {
    if (Array.isArray(args)) return sync(command, args, { ...options, windowsHide: true })
    const opts = args as SpawnSyncOptions | undefined
    return sync(command, { ...opts, windowsHide: true })
  }) as typeof sync
  try {
    return await chromium.launch(opts)
  } finally {
    api.spawn = spawn
    api.spawnSync = sync
  }
}

export namespace Runner {
  export function version(): string | undefined {
    return activeBrowser?.isConnected() ? activeBrowser.version() : undefined
  }
  export function listSessions(): SessionInfo[] {
    return Array.from(sessions.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  export async function ensureBrowser(timeout?: number): Promise<Browser> {
    if (activeBrowser && activeBrowser.isConnected()) return activeBrowser
    if (pending) return pending
    const task = launch(timeout).then((browser) => {
      activeBrowser = browser
      activeContexts.clear()
      browser.on("disconnected", () => {
        if (activeBrowser === browser) {
          activeBrowser = null
          activeContexts.clear()
        }
      })
      return browser
    })
    const current = task.finally(() => {
      if (pending === current) pending = null
    })
    pending = current
    return current
  }

  export async function attach(name: string, timeout?: number): Promise<Live> {
    const existing = activeContexts.get(name)
    if (existing && existing.context.browser()) {
      if (existing.active.isClosed())
        existing.active = existing.context.pages()[0] ?? (await existing.context.newPage())
      track(name, existing.active.url())
      return existing
    }
    const browser = await ensureBrowser(timeout)
    const opts = Launch.fromConfig(getConfig())
    const ctx = await browser.newContext(Launch.contextOptions(opts))
    const page = await ctx.newPage()
    const live: Live = {
      name,
      context: ctx,
      browser,
      active: page,
      home: home(),
    }
    activeContexts.set(name, live)
    mkdirSync(join(live.home, "contexts", name), { recursive: true })
    track(name)
    return live
  }

  export async function close(name: string): Promise<boolean> {
    const live = activeContexts.get(name)
    if (!live) return false
    activeContexts.delete(name)
    sessions.delete(name)
    await live.context.close()
    rmSync(join(live.home, "contexts", name), { recursive: true, force: true })
    return true
  }

  export async function shutdown(): Promise<void> {
    await Promise.allSettled(Array.from(activeContexts.values(), (live) => live.context.close()))
    activeContexts.clear()
    sessions.clear()
    if (activeBrowser) {
      await activeBrowser.close()
      activeBrowser = null
    }
  }

  export function probeChromium(): Promise<BrowserCapability["installation"]> {
    const executable = getConfig().browser.executablePath ?? chromium.executablePath()
    if (existsSync(executable)) return Promise.resolve({ state: "available", message: executable })
    return Promise.resolve({
      state: "missing",
      message: `Chromium executable not found at ${executable}. Install with \`npx playwright install chromium\`.`,
    })
  }

  export function activePage(live: Live): Page {
    if (!live.active.isClosed()) return live.active
    const page = live.context.pages()[0]
    if (!page) throw new Error(`session ${live.name} has no active page`)
    live.active = page
    return page
  }

  export function touch(name: string, url?: string): void {
    track(name, url)
  }
}
