import path from "node:path"
import { parseScript } from "@kilocode/world"
import type { Action } from "@kilocode/world/types"

export type WorldScript = {
  actions: Action[]
  urls: string[]
  reads: string[]
  writes: string[]
}

export function inspect(script: string, dir: string): WorldScript {
  const actions = parseScript(script)
  const urls: string[] = []
  const reads: string[] = []
  const writes: string[] = []
  for (const action of actions) {
    const url = flag(action, "--url")
    if (url && (action.verb === "navigate" || (action.verb === "tabs" && action.args[0] === "open"))) {
      urls.push(url)
    }
    const input = action.verb === "evaluate" ? flag(action, "--js-file") : undefined
    if (input) reads.push(resolve(dir, input))
    const output = action.verb === "screenshot" ? flag(action, "--out") : undefined
    if (output) writes.push(resolve(dir, output))
  }
  return {
    actions,
    urls: [...new Set(urls)],
    reads: [...new Set(reads)],
    writes: [...new Set(writes)],
  }
}

function flag(action: Action, name: string): string | undefined {
  for (let i = 0; i < action.args.length; i++) {
    const value = action.args[i]
    if (value === name) return action.args[i + 1]
    if (value?.startsWith(`${name}=`)) return value.slice(name.length + 1)
  }
  return undefined
}

function resolve(dir: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(dir, file)
}
