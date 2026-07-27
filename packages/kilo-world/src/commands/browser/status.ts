import { Runner } from "../../core/browser/runner"
import type { BrowserStatus } from "../../types"
import { getConfig } from "../../config"

export namespace Status {
  export async function run(): Promise<BrowserStatus> {
    const cfg = getConfig()
    const probe = await Runner.probeChromium()
    return {
      sessions: Runner.listSessions(),
      capability: {
        headless: cfg.browser.headless,
        ...(process.env["DISPLAY"] !== undefined ? { display: process.env["DISPLAY"] } : {}),
        chromiumReady: probe.state === "available",
        chromiumVersion: probe.message,
        download: probe,
      },
      chromiumPid: null,
    }
  }
}
