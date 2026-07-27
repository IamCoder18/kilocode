// kilocode_change - new file
import path from "path"
import { Npm } from "@opencode-ai/core/npm"
import { LanceDBRuntime } from "./lancedb"

export namespace WorldRuntime {
  export const nodePathEnv = "KILO_WORLD_NODE_PATH"
  export const playwrightPkg = "playwright"
  export const playwrightVersion = "1.61.1"
  export const chromiumBidiPkg = "chromium-bidi"
  export const chromiumBidiVersion = "^12.0.0"

  export const external = [
    playwrightPkg,
    "playwright-core",
    chromiumBidiPkg,
    ...LanceDBRuntime.external,
  ] as const

  const box: { ready: Promise<string> | undefined } = { ready: undefined }

  export function clear() {
    delete process.env[nodePathEnv]
    box.ready = undefined
  }

  /**
   * Install `playwright` and `chromium-bidi` into the global npm cache
   * (~$/.cache/opencode/packages/...) on first use and return the
   * `node_modules` directory the daemon should resolve bare specifiers from.
   * Subsequent calls return the cached promise immediately.
   *
   * The actual Chromium browser binary (~150 MB) is downloaded lazily by
   * `chromium.launch()` via the `playwright install` postinstall — see the
   * daemon's `status` verb for download state.
   */
  export async function ensure(): Promise<string> {
    if (box.ready) return box.ready

    box.ready = (async () => {
      const playwright = await Npm.add(`${playwrightPkg}@${playwrightVersion}`)
      await Npm.add(`${chromiumBidiPkg}@${chromiumBidiVersion}`)
      const nodeModules = path.join(playwright.directory, "node_modules")
      process.env[nodePathEnv] = nodeModules
      return nodeModules
    })().catch((err) => {
      box.ready = undefined
      throw err
    })

    return box.ready
  }
}