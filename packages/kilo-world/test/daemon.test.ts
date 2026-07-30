import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient, World } from "../src"
import { DaemonServer } from "../src/daemon/server"

const session = `test-${process.pid}`
const home = mkdtempSync(join(tmpdir(), "kilo-world-test-"))
const config = World.currentConfig()

beforeAll(() => {
  World.configure({ home })
})

afterAll(async () => {
  await DaemonClient.stop(session)
  await waitFor(() => !DaemonServer.isRunning(session))
  World.configure(config)
  rmSync(home, { recursive: true, force: true })
})

describe("world daemon", () => {
  test("deduplicates concurrent startup and serves authenticated requests", async () => {
    await Promise.all([
      DaemonClient.ensureRunning(session, { idleMs: 0 }),
      DaemonClient.ensureRunning(session, { idleMs: 0 }),
      DaemonClient.ensureRunning(session, { idleMs: 0 }),
    ])
    const handshake = DaemonClient.handshake(session)
    expect(handshake).not.toBeNull()
    expect(DaemonServer.isRunning(session)).toBe(true)

    const denied = await fetch(`${handshake!.url}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "denied", verb: "__status__", args: [], auth: "wrong" }),
    })
    expect(denied.status).toBe(401)

    if (process.platform !== "win32") {
      expect(statSync(DaemonServer.pidPath(session)).mode & 0o777).toBe(0o600)
      expect(statSync(DaemonServer.handshakePath(session)).mode & 0o777).toBe(0o600)
    }
  })

  test("reports runtime status without launching Chromium", async () => {
    const result = await World.runForSession(session, "daemon.status ; status", {
      config: World.currentConfig(),
    })
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results[0]?.data).toMatchObject({
      running: true,
      idleTimeoutMs: 0,
      idleTimeoutRemainingMs: 0,
    })
    expect(result.results[1]?.data).toMatchObject({ chromiumPid: null })
  })

  test("stops cleanly and removes private state files", async () => {
    expect(await DaemonClient.stop(session)).toBe(true)
    await waitFor(() => !DaemonServer.isRunning(session))
    expect(Bun.file(DaemonServer.pidPath(session)).exists()).resolves.toBe(false)
    expect(Bun.file(DaemonServer.handshakePath(session)).exists()).resolves.toBe(false)
  })
})

async function waitFor(check: () => boolean) {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    if (check()) return
    await Bun.sleep(25)
  }
  const pid = readFileSync(DaemonServer.pidPath(session), "utf8")
  throw new Error(`daemon did not stop (pid ${pid})`)
}
