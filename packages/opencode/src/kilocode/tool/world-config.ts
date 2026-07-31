import { defaultConfig } from "@kilocode/world"
import type { WorldConfig } from "@kilocode/world/types"

export type Input = {
  world?: {
    browser?: {
      headless?: boolean
      anti_detect?: boolean
      timeout_ms?: number
      viewport?: { width: number; height: number }
      executable_path?: string
      use_system_chrome?: boolean
      args?: string[]
    }
  }
}

export function resolve(cfg: Input): WorldConfig {
  const base = defaultConfig()
  const browser = cfg.world?.browser
  if (!browser) return base
  return {
    browser: {
      ...base.browser,
      ...(browser.headless !== undefined ? { headless: browser.headless } : {}),
      ...(browser.anti_detect !== undefined ? { antiDetect: browser.anti_detect } : {}),
      ...(browser.timeout_ms !== undefined ? { timeoutMs: browser.timeout_ms } : {}),
      ...(browser.viewport ? { viewport: browser.viewport } : {}),
      ...(browser.args ? { args: [...browser.args] } : {}),
      ...(browser.executable_path ? { executablePath: browser.executable_path } : {}),
      ...(browser.use_system_chrome !== undefined ? { useSystemChrome: browser.use_system_chrome } : {}),
    },
    home: base.home,
  }
}
