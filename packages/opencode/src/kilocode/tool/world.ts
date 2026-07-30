// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as path from "path"
import { readFileSync } from "node:fs"
import { Tool } from "../../tool/tool"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "../../tool/external-directory"
import { World, DaemonClient } from "@kilocode/world"
import type { ActionResult, RunResult } from "@kilocode/world/types"
import * as Log from "@opencode-ai/core/util/log"
import { inspect } from "./world-script"
import type { WorldConfig } from "@kilocode/world/types"

const log = Log.create({ service: "kilocode-tool-world" })

const DESCRIPTION = `Drive a Chromium browser to render pages, run JavaScript, click through UI, and capture screenshots. State persists across calls in a per-session daemon.

Proactively use this to verify UI changes (component, layout, style) without being asked by navigating to the page and confirming the result.

Scripts are ;-separated verb calls. Prefer CSS selectors (\`#foo\`, \`input#bar\`) over role selectors — they pierce shadow DOM and survive across snapshots.

Verb grammar:
  Common: \`--ref <eN>\` from snapshot (preferred) or \`--selector <css>\`. Values with spaces or \`;\` need quotes.
  status - capability, sessions, Chromium installation state
  navigate --url <url> [--wait <sel>] [--timeout <ms>]
  snapshot - DOM walk with stable [ref=eN] ids and CSS selectors; prefer over screenshot
  click | type --text | fill --value [--force] | hover | scroll --dx N --dy N - each takes --ref or --selector
  press-key --chord "<spec>" (e.g. "Control+a")
  drag --from <ref|sel> --to <ref|sel>
  wait-for --selector | --text | --url [--timeout <ms>]
  screenshot --out <file> [--full] [--wait <ms>] [--type png|jpeg] [--quality 50-100]
  evaluate --js <code> | --js-file <path>
  tabs list | open --url | select --index | close
  cookies get | set --name N --value V --domain D | clear
  shutdown - close browser; daemon stays alive
  daemon.start --idle <ms> | daemon.status | daemon.stop

Example:
  world({ script: "navigate --url http://localhost:3000/settings ; snapshot ; screenshot --out /tmp/check.png" })
`

const Params = Schema.Struct({
  script: Schema.String.annotate({
    description: "A ;-separated sequence of browser actions. Example: `navigate --url https://example.com ; snapshot`.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Overall timeout in milliseconds. Defaults to 60_000.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

type Meta = {
  ok: boolean
  durationMs: number
  actions: number
  failedAt?: number
  daemonStarted?: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function summarize(r: ActionResult): string {
  if (!r.ok) return ` → error: ${r.error ?? "unknown"} (${r.durationMs}ms)`
  const data = record(r.data) ? r.data : undefined
  if (!data) return ` → ok (${r.durationMs}ms)`
  if (r.verb === "navigate") {
    const u = typeof data["finalUrl"] === "string" ? data["finalUrl"] : ""
    return ` → ${u} (${r.durationMs}ms)`
  }
  if (r.verb === "snapshot") {
    return ` → ${renderRefList(r.refs, 8)}`
  }
  if (r.verb === "screenshot") {
    return ` → ${r.screenshot?.bytes ?? 0} bytes (${r.durationMs}ms)`
  }
  if (r.verb === "evaluate") {
    return ` → ${JSON.stringify(data["result"])} (${r.durationMs}ms)`
  }
  return ` → ${JSON.stringify(data).slice(0, 200)} (${r.durationMs}ms)`
}

function renderRefList(
  refs: Array<{ ref: string; role: string; name: string; selector?: string }> | undefined,
  limit: number,
): string {
  if (!refs || refs.length === 0) return "0 refs"
  const lines: string[] = [`${refs.length} refs:`]
  for (const r of refs.slice(0, limit)) {
    const name = (r.name ?? "").slice(0, 60).replace(/\s+/g, " ").trim()
    const sel = r.selector ?? ""
    lines.push(`  ${r.ref} [${r.role}] sel=${sel}${name ? ` name=${JSON.stringify(name)}` : ""}`)
  }
  if (refs.length > limit) lines.push(`  … (${refs.length - limit} more)`)
  return lines.join("\n")
}

function attachmentForResult(
  r: ActionResult,
  directory: string,
): { type: "file"; mime: string; url: string; filename: string } | undefined {
  if (!r.screenshot) return undefined
  const abs = path.isAbsolute(r.screenshot.path) ? r.screenshot.path : path.join(directory, r.screenshot.path)
  const mime = r.screenshot.mime ?? "image/png"
  const data = readInlineData(abs, mime)
  if (data) return { type: "file", mime, url: data, filename: path.basename(abs) }
  return { type: "file", mime, url: `file://${abs}`, filename: path.basename(abs) }
}

function formatResult(
  result: RunResult,
  directory: string,
): {
  output: string
  attachments: Array<{ type: "file"; mime: string; url: string; filename: string }>
} {
  const lines: string[] = []
  const attachments: Array<{ type: "file"; mime: string; url: string; filename: string }> = []
  result.results.forEach((r, i) => {
    const summary = summarize(r)
    lines.push(`[${i + 1}/${result.results.length}] ${r.verb}${summary.includes("\n") ? "\n" + summary : summary}`)
    const att = attachmentForResult(r, directory)
    if (att) attachments.push(att)
  })
  return { output: lines.join("\n"), attachments }
}

function readInlineData(absPath: string, mime: string = "image/png"): string | null {
  try {
    const buf = readFileSync(absPath)
    if (buf.byteLength > 5_000_000) return null
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

function configure(cfg: {
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
}): WorldConfig {
  const current = World.currentConfig()
  const world = cfg.world
  if (!world) return current
  const browser = world.browser ?? {}
  return World.configure({
    browser: {
      ...current.browser,
      ...(browser.headless !== undefined ? { headless: browser.headless } : {}),
      ...(browser.anti_detect !== undefined ? { antiDetect: browser.anti_detect } : {}),
      ...(browser.timeout_ms !== undefined ? { timeoutMs: browser.timeout_ms } : {}),
      ...(browser.viewport ? { viewport: browser.viewport } : {}),
      ...(browser.args ? { args: [...browser.args] } : {}),
      ...(browser.executable_path ? { executablePath: browser.executable_path } : {}),
      ...(browser.use_system_chrome !== undefined ? { useSystemChrome: browser.use_system_chrome } : {}),
    },
    home: current.home,
  })
}

function screenshotPath(config: WorldConfig, session: string, call: string | undefined): string {
  const name = `${session}-${call ?? Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, "_")
  return path.join(config.home, "screenshots", `${name}.jpg`)
}

export const WorldTool = Tool.define(
  "world",
  Effect.gen(function* () {
    const configs = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const inst = yield* InstanceState.context
          const config = configure(yield* configs.get())
          const script = inspect(params.script, inst.directory)

          yield* ctx.ask({
            permission: "world",
            patterns: ["browser"],
            always: ["browser"],
            metadata: { script: params.script },
          })
          for (const url of script.urls) {
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              throw new Error(`URL must start with http:// or https://: ${url}`)
            }
            yield* ctx.ask({
              permission: "webfetch",
              patterns: [url],
              always: ["*"],
              metadata: { script: params.script },
            })
          }
          for (const file of script.reads) {
            yield* assertExternalDirectoryEffect(ctx, file)
            yield* ctx.ask({
              permission: "read",
              patterns: [path.relative(inst.worktree, file)],
              always: ["*"],
              metadata: { filepath: file },
            })
          }
          for (const file of script.writes) {
            yield* assertExternalDirectoryEffect(ctx, file)
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(inst.worktree, file)],
              always: ["*"],
              metadata: { filepath: file },
            })
          }

          const wasRunning = DaemonClient.isRunning(ctx.sessionID)
          const timeout = params.timeout ?? 60_000
          if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout must be a positive finite number")
          const controller = new AbortController()
          const onAbort = () => controller.abort()
          ctx.abort.addEventListener("abort", onAbort, { once: true })
          const timer = setTimeout(() => controller.abort(), timeout)
          const run = yield* Effect.promise(() =>
            World.runForSession(ctx.sessionID, params.script, {
              signal: controller.signal,
              timeoutMs: timeout,
              directory: inst.directory,
              config,
            }).finally(() => {
              clearTimeout(timer)
              ctx.abort.removeEventListener("abort", onAbort)
            }),
          )

          const failedIdx = run.results.findIndex((r) => !r.ok)
          const meta: Meta = {
            ok: run.ok,
            durationMs: run.durationMs,
            actions: run.results.length,
            daemonStarted: !wasRunning,
            ...(failedIdx >= 0 ? { failedAt: failedIdx } : {}),
          }

          const formatted = formatResult(run, inst.directory)
          const failed = failedIdx >= 0 ? run.results[failedIdx] : undefined

          const lastResult = run.results[run.results.length - 1]
          const visual =
            lastResult &&
            !["status", "close", "shutdown", "daemon.start", "daemon.status", "daemon.stop"].includes(lastResult.verb)
          if (run.ok && visual && !lastResult.screenshot) {
            try {
              const out = screenshotPath(config, ctx.sessionID, ctx.callID)
              const auto = yield* Effect.promise(() =>
                World.runForSession(ctx.sessionID, `screenshot --out ${JSON.stringify(out)} --type jpeg --quality 80`, {
                  signal: ctx.abort,
                  timeoutMs: 15_000,
                  directory: inst.directory,
                  config,
                }),
              )
              const shot = auto.results[0]
              if (shot?.screenshot) {
                const att = attachmentForResult(shot, inst.directory)
                if (att) formatted.attachments.push(att)
                formatted.output += `\n[auto-screenshot] ${shot.screenshot.bytes} bytes`
              }
            } catch (err) {
              log.warn("auto-screenshot failed", { error: String(err) })
            }
          }

          return {
            title: failed
              ? `world ${failed.verb} failed`
              : run.results.length === 1
                ? `world ${run.results[0].verb}`
                : `world ${run.results.length} actions`,
            output: run.ok
              ? formatted.output
              : `${formatted.output}\n\nScript failed at action ${failedIdx + 1}: ${failed?.error ?? "unknown"}`,
            metadata: meta,
            ...(formatted.attachments.length > 0 ? { attachments: formatted.attachments } : {}),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
