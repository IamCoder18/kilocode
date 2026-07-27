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
import { WorldRuntime } from "@/kilocode/world-runtime"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "kilocode-tool-world" })

const DESCRIPTION = `Drive a real Chromium browser to interact with web pages. Use this tool for anything that needs a rendered DOM, JavaScript execution, or visual state — web scraping, form filling, taking screenshots, clicking through UI flows, scraping data behind JavaScript, etc.

Each call runs a "script": a ;-separated list of browser actions. Every script runs inside a long-lived per-session browser daemon (auto-started on the first call for that session). The daemon persists across multiple world() calls in the same session, so page state carries over. To explicitly stop the daemon, call \`world({ script: "daemon.stop" })\`.

How to write the script (quote-aware; ; inside '…' or "…" is preserved):

  • Use 'single quotes' or "double quotes" around any value that contains spaces, ;
    or special characters. The tool strips the outer quotes from the value it passes
    to the verb.
  • Use --js-file /path/to/file.js instead of --js for long JavaScript — no quoting
    headaches, no length limits.
  • Prefer CSS selectors (\`#full-name\`, \`input#email\`) over role selectors — they
    are stable across snapshots, do not need Playwright's accessible-name matching,
    and pierce shadow DOM automatically.
  • Shadow DOM: Playwright pierces open shadow roots for plain CSS selectors.
    \`fill --selector "input#shadow-pin"\` finds the input even though it lives in
    a shadow root. The tool redaction strips names that match password/secret/pin
    patterns from the snapshot text but keeps the ref and selector.

Verb grammar (the script is parsed as a shell-like argv):

  status                                    capability, sessions, chromium download state
  navigate --url <url> [--wait <sel>] [--timeout <ms>]   goto URL; optional selector wait
  snapshot                                  DOM walk with stable [ref=eN] ids and CSS selectors
  click --ref <id> | --selector <sel>       click by ref (preferred) or selector
  type --text <s> [--ref <id> | --selector <sel>]   type into element or focused page
  fill --value <s> [--ref <id> | --selector <sel>] [--force]  replace input value (--force bypasses actionability checks for hidden elements)
  press-key --chord <spec>                  key press or chord (e.g. "Control+a")
  hover --ref <id> | --selector <sel>       hover
  drag --from <ref|sel> --to <ref|sel>       drag between two targets
  scroll --ref <id> --dx 0 --dy 400         scroll element or page
  screenshot --out <file> [--full] [--wait <ms>] [--type png|jpeg] [--quality 50-100]   write the screenshot (default: jpeg q=80); the tool returns it as an inline image attachment
  evaluate --js <code> | --js-file <path>   run JS in the page, return JSON value
  wait-for --selector <sel> | --text <t> | --url <u> [--timeout <ms>]   wait for a condition
  tabs list | open --url <u> | select --index <n> | close   tab management
  cookies get | set --name N --value V --domain D | clear
  shutdown                                  close the browser (daemon stays alive; next call re-attaches)
  daemon.status                             report the daemon's pid, uptime, and idle timeout
  daemon.start --idle <ms>                  start (or re-configure) the per-session browser daemon (0 = never time out)
  daemon.stop                               shut down the per-session browser daemon

Computer use is NOT implemented in v1. Do not ask this tool to drive the desktop.

Examples:

  # Find capability, then navigate and snapshot in one script
  world({ script: "status ; navigate --url https://example.com ; snapshot" })

  # Fill a form with chained actions. Set the <select> first (or via evaluate) so
  # conditional fields are visible before fill. Shadow DOM inputs work via id selectors.
  world({ script: [
    "navigate --url https://example.com/form --wait '#full-name'",
    "snapshot",
    'fill --ref e2 --value "Aarav Agent"',
    'fill --ref e3 --value "aarav@example.com"',
    'evaluate --js "var s=document.getElementById(\'role\'); s.value=\'business\'; s.dispatchEvent(new Event(\'change\',{bubbles:true}))"',
    'fill --ref e5 --value "Kilo Corp"',
    'click --ref e6',
    'fill --ref e7 --value "1234"',
    'screenshot --out /tmp/form.png --wait 1500',
  ].join(' ; ') })

  # Long JS via file (no quoting needed)
  echo 'document.querySelectorAll("a").length' > /tmp/count.js
  world({ script: "navigate --url https://example.com ; evaluate --js-file /tmp/count.js" })

  # Manually start the daemon with no idle timeout (it stays alive until you stop it)
  world({ script: "daemon.start --idle 0" })

  # Update the idle timeout on an already-running daemon (preserves browser state)
  world({ script: "daemon.start --idle 0" })

  # Stop the per-session browser daemon when done
  world({ script: "daemon.stop" })

Always prefer snapshot over screenshot. Refs become stale across UI changes — re-snapshot before clicking if the page may have changed. Add --wait <selector> to navigate when the page has async rendering. The first invocation may trigger a ~150 MB Chromium download; check the status verb's output before retrying.
`

const Params = Schema.Struct({
  script: Schema.String.annotate({
    description:
      'A ;-separated sequence of browser actions. Example: `navigate --url https://example.com ; snapshot`.',
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

function summarize(r: ActionResult): string {
  if (!r.ok) return ` → error: ${r.error ?? "unknown"} (${r.durationMs}ms)`
  const data = r.data as Record<string, unknown> | undefined
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

function renderRefList(refs: Array<{ ref: string; role: string; name: string; selector?: string }> | undefined, limit: number): string {
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
  if (!r.screenshot) return
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

function detectUrls(script: string): string | undefined {
  const matches = script.match(/--url\s+["']?([^\s"']+)/g) ?? []
  if (matches.length === 0) return undefined
  const urls = matches
    .map((m) => m.replace(/^--url\s+["']?/, ""))
    .filter((u) => u.startsWith("http://") || u.startsWith("https://"))
  return urls[0]
}

function applyConfigFromKilo(): void {
  const cfg = (Config as { get?: () => unknown }).get?.()
  if (!cfg) return
  const worldCfg = (cfg as { world?: { enabled?: boolean; browser?: Record<string, unknown> } }).world
  if (!worldCfg || worldCfg.enabled === false) return
  const b = worldCfg.browser ?? {}
  World.configure({
    browser: {
      headless: typeof b["headless"] === "boolean" ? (b["headless"] as boolean) : true,
      antiDetect: typeof b["antiDetect"] === "boolean" ? (b["antiDetect"] as boolean) : false,
      timeoutMs: typeof b["timeoutMs"] === "number" ? (b["timeoutMs"] as number) : 30_000,
      viewport:
        typeof b["viewport"] === "object" && b["viewport"]
          ? (b["viewport"] as { width: number; height: number })
          : { width: 1280, height: 720 },
      args: Array.isArray(b["args"]) ? (b["args"] as string[]) : [],
      ...(typeof b["executablePath"] === "string"
        ? { executablePath: b["executablePath"] as string }
        : {}),
    },
    home: typeof b["home"] === "string" ? (b["home"] as string) : World.currentConfig().home,
  })
}

function assertExternalWrites(script: string, directory: string): Effect.Effect<void, never, never> {
  const out = script.match(/--out\s+["']?([^\s"']+)/g) ?? []
  if (out.length === 0) return Effect.void
  return Effect.gen(function* () {
    for (const m of out) {
      const raw = m.replace(/^--out\s+["']?/, "").replace(/["']$/, "")
      const abs = path.isAbsolute(raw) ? raw : path.join(directory, raw)
      yield* assertExternalDirectoryEffect(abs as never)
    }
  })
}

export const WorldTool = Tool.define<typeof Params, Meta, never, "world">(
  "world",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Params,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const inst = yield* InstanceState.context
        applyConfigFromKilo()

        yield* Effect.promise(() => WorldRuntime.ensure())

        const urlPattern = detectUrls(params.script)
        if (urlPattern) {
          yield* ctx.ask({
            permission: "webfetch",
            patterns: [urlPattern],
            always: ["*"],
            metadata: { script: params.script },
          })
        }
        yield* assertExternalWrites(params.script, inst.directory)

        const wasRunning = DaemonClient.isRunning(ctx.sessionID)
        const timeout = params.timeout ?? 60_000
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        ctx.abort.addEventListener("abort", onAbort, { once: true })
        const timer = setTimeout(() => controller.abort(), timeout)
        const run = yield* Effect.promise(() =>
          World.runForSession(ctx.sessionID, params.script, {
            signal: controller.signal,
            // Per-segment timeout for each daemon call. Without this the
            // daemon client hardcodes 15s, which trips on first cold-start
            // navigation. The overall abort above still caps the whole run.
            timeoutMs: timeout,
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
        if (run.ok && lastResult && !lastResult.screenshot) {
          try {
            const auto = yield* Effect.promise(() =>
              World.runForSession(ctx.sessionID, "screenshot --type jpeg --quality 80", {
                signal: controller.signal,
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
              ? `world ${run.results[0]!.verb}`
              : `world ${run.results.length} actions`,
          output: run.ok
            ? formatted.output
            : `${formatted.output}\n\nScript failed at action ${failedIdx + 1}: ${failed?.error ?? "unknown"}`,
          metadata: meta,
          ...(formatted.attachments.length > 0 ? { attachments: formatted.attachments } : {}),
        }
      }).pipe(Effect.orDie),
  }),
)
