import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright"
import { ensureHome, getConfig } from "../../config"
import { Launch } from "./launch"
import type { BrowserCapability, SessionInfo } from "../../types"

type Live = {
  name: string
  context: BrowserContext
  browser: Browser
  pages: Page[]
  activeIndex: number
  home: string
}

let activeBrowser: Browser | null = null
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
    return out
  }
  // On Windows, Playwright's default executable is `chrome-headless-shell.exe`,
  // which is built with the CONSOLE subsystem — so spawning it briefly
  // allocates a console window and flashes it at the user, even with
  // `--headless`. The full `chrome.exe` is GUI-subsystem and does not.
  // Switching to `channel: "chromium"` makes Playwright pick the full
  // chromium binary while still honoring `headless: true`.
  if (process.platform === "win32") {
    ;(out as LaunchOptions & { channel?: string }).channel = "chromium"
  }
  return out
}

export namespace Runner {
  export function listSessions(): SessionInfo[] {
    return Array.from(sessions.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  export async function ensureBrowser(): Promise<Browser> {
    if (activeBrowser && activeBrowser.isConnected()) return activeBrowser
    const b = await chromium.launch(buildLaunchOptions())
    activeBrowser = b
    activeContexts.clear()
    b.on("disconnected", () => {
      if (activeBrowser === b) {
        activeBrowser = null
        activeContexts.clear()
      }
    })
    return b
  }

  export async function attach(name: string): Promise<Live> {
    const existing = activeContexts.get(name)
    if (existing && existing.context.browser()) return existing
    const browser = await ensureBrowser()
    const opts = Launch.fromConfig(getConfig())
    const ctx = await browser.newContext(Launch.contextOptions(opts))
    const page = await ctx.newPage()
    const live: Live = {
      name,
      context: ctx,
      browser,
      pages: [page],
      activeIndex: 0,
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
    await live.context.close().catch(() => {})
    rmSync(join(live.home, "contexts", name), { recursive: true, force: true })
    return true
  }

  export async function shutdown(): Promise<void> {
    for (const live of activeContexts.values()) {
      await live.context.close().catch(() => {})
    }
    activeContexts.clear()
    sessions.clear()
    if (activeBrowser) {
      await activeBrowser.close().catch(() => {})
      activeBrowser = null
    }
  }

  export function probeChromium(): Promise<BrowserCapability["download"]> {
    return chromium
      .launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      .then(async (b) => {
        const v = b.version()
        await b.close().catch(() => {})
        return { state: "available" as const, ...(v ? { message: v } : {}) }
      })
      .catch((err: Error) => ({ state: "missing" as const, message: err.message }))
  }

  export function activePage(live: Live): Page {
    const page = live.pages[live.activeIndex]
    if (!page) throw new Error(`session ${live.name} has no active page`)
    return page
  }
}
