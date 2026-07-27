export type Action = {
  verb: string
  args: string[]
}

/**
 * Parse a ;-separated script of browser actions.
 *
 * The parser is quote-aware: `;` inside `'…'`, `"…"`, or `` `…` `` is preserved
 * as a regular character. Backslash escapes are honored inside quoted
 * strings. Unquoted whitespace separates tokens.
 *
 * The `evaluate --js <code>` verb reads the rest of its segment (or anything
 * after `--js-file <path>`) as a single token — `;` inside the JS is fine
 * when the JS is wrapped in quotes.
 */
export function parseScript(text: string): Action[] {
  const actions: Action[] = []
  let verb: string | null = null
  let args: string[] = []
  let current = ""
  let quote: '"' | "'" | "`" | null = null
  let escape = false

  const flushToken = () => {
    if (current.length === 0) return
    if (verb === null) {
      verb = current
    } else {
      args.push(current)
    }
    current = ""
  }
  const flushVerb = () => {
    flushToken()
    if (verb !== null) {
      actions.push({ verb, args })
      verb = null
      args = []
    }
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (escape) {
      current += ch
      escape = false
      continue
    }
    if (quote) {
      if (ch === "\\") {
        current += ch
        escape = true
        continue
      }
      if (ch === quote) {
        // closing quote — do not include it in the token
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // opening quote — do not include the quote char in the token
      quote = ch
      continue
    }
    if (ch === ";") {
      flushToken()
      flushVerb()
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flushToken()
      continue
    }
    current += ch
  }
  flushToken()
  flushVerb()
  if (quote !== null) throw new Error("unterminated quote in script")
  return actions
}
