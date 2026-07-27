import type { Page } from "playwright"
import type { RefEntry, Snapshot } from "../../types"

const PASSWORD_PATTERN = /password|passcode|secret|pin|otp|token|api[-_ ]?key/i
const REDACTED = "[REDACTED]"

const REF_LINE = /^\s*(?:-|\*)?\s*\[ref=([^\]]+)\](?:\s*\[([^\]]+)\])?(?:\s*"([^"]*)")?/
const REF_LINE_NAMED = /^\s*(?:-|\*)?\s*\[ref=([^\]]+)\](?:\s+(.*))?$/

function redact(name: string, role: string | undefined): string {
  if (!name) return name
  if (role !== "textbox" && role !== "searchbox" && role !== "combobox") return name
  return PASSWORD_PATTERN.test(name) ? REDACTED : name
}

function selectorForRole(role: string | undefined, name: string): string | undefined {
  if (!role || !name || name === REDACTED) return undefined
  const safe = name.replace(/"/g, '\\"').slice(0, 120)
  return `role=${role}[name="${safe}"]`
}

export namespace SnapshotEngine {
  export async function capture(page: Page): Promise<Snapshot> {
    let snapshot = ""
    try {
      snapshot = await page.locator(":root").ariaSnapshot({ mode: "ai" })
    } catch {
      try {
        snapshot = await page.locator(":root").ariaSnapshot()
      } catch {
        snapshot = ""
      }
    }
    const refs = parseSnapshot(snapshot)
    return { snapshot, refs }
  }

  export function parseSnapshot(snapshot: string): RefEntry[] {
    const refs: RefEntry[] = []
    for (const [depth, raw] of lines(snapshot).entries()) {
      const line = raw.trim()
      const m = line.match(REF_LINE)
      if (m) {
        const ref = m[1] ?? ""
        const role = m[2]
        const name = m[3] ?? ""
        const redacted = redact(name, role)
        const entry: RefEntry = { ref, role: role ?? "", name: redacted, depth }
        const sel = selectorForRole(role, redacted)
        if (sel) entry.selector = sel
        refs.push(entry)
        continue
      }
      const m2 = line.match(REF_LINE_NAMED)
      if (m2 && m2[2]) {
        const ref = m2[1] ?? ""
        const rest = m2[2].trim()
        const quoted = rest.match(/^"([^"]*)"(?:\s+\[([^\]]+)\])?/)
        if (quoted) {
          const name = quoted[1] ?? ""
          const role = quoted[2]
          const redacted = redact(name, role)
          const entry: RefEntry = { ref, role: role ?? "", name: redacted, depth }
          const sel = selectorForRole(role, redacted)
          if (sel) entry.selector = sel
          refs.push(entry)
          continue
        }
        const bare = rest.match(/\[([^\]]+)\]\s*(?:"([^"]*)")?/)
        if (bare) {
          const role = bare[1]
          const name = bare[2] ?? ""
          const redacted = redact(name, role)
          const entry: RefEntry = { ref, role: role ?? "", name: redacted, depth }
          const sel = selectorForRole(role, redacted)
          if (sel) entry.selector = sel
          refs.push(entry)
        }
      }
    }
    return refs
  }

  function lines(s: string): string[] {
    return s.split(/\r?\n/)
  }

  export const PASSWORD_REDACTION = {
    pattern: PASSWORD_PATTERN,
    value: REDACTED,
  }
}
