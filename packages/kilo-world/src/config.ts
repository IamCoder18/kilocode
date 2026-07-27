import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { WorldConfig } from "./types"

const DEFAULT_HOME = join(
  process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
  "kilo-world",
)

let cached: WorldConfig | null = null

export function defaultConfig(): WorldConfig {
  const display = process.env["DISPLAY"]
  const wayland = process.env["WAYLAND_DISPLAY"]
  const hasDisplayServer = Boolean(display || wayland)
  const headless = !hasDisplayServer || process.env["KILO_WORLD_HEADED"] !== "1"
  return {
    browser: {
      headless,
      antiDetect: process.env["KILO_WORLD_ANTI_DETECT"] === "1",
      timeoutMs: 30_000,
      viewport: { width: 1280, height: 720 },
      args: [],
      ...(process.env["KILO_WORLD_CHROMIUM"]
        ? { executablePath: process.env["KILO_WORLD_CHROMIUM"] }
        : {}),
    },
    home: process.env["KILO_WORLD_HOME"] ?? DEFAULT_HOME,
  }
}

export function getConfig(): WorldConfig {
  if (!cached) cached = defaultConfig()
  return cached
}

export function setConfig(patch: Partial<WorldConfig>): WorldConfig {
  const next: WorldConfig = {
    ...getConfig(),
    ...patch,
    browser: { ...getConfig().browser, ...(patch.browser ?? {}) },
  }
  cached = next
  return next
}

export function ensureHome(home: string): string {
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  return home
}
