import type { ElementHandle, Page } from "playwright"
import type { RefEntry, Snapshot } from "../../types"
import { SnapshotEngine } from "./snapshot"

const PASSWORD_PATTERN = /password|passcode|secret|pin|otp|token|api[-_ ]?key/i
const REDACTED = "[REDACTED]"

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

type WalkedNode = {
  el: Element
  role: string | null
  name: string
  inShadow: boolean
  hostSelector?: string
  tag?: string
  id?: string
}

type WalkResult = {
  nodes: WalkedNode[]
  counter: { value: number }
}

const WALK_SCRIPT = `
(() => {
  const out = { nodes: [], counter: { value: 1 } };
  const visited = new WeakSet();

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'button') return 'button';
    if (t === 'a') return 'link';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(t)) return 'heading';
    return null;
  }

  function nameOf(el) {
    // Compute the accessible name the way Playwright does for role=name=.
    // Priority: aria-labelledby > aria-label > label[for=id] > placeholder > name > text.
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/);
      const parts = ids.map((id) => { const ref = document.getElementById(id); return ref ? (ref.textContent || '').trim() : ''; }).filter(Boolean);
      if (parts.length > 0) return parts.join(' ').slice(0, 100);
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const lbl = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
      if (lbl) {
        const txt = (lbl.textContent || '').replace(/\\*+/g, '').replace(/\\s+/g, ' ').trim();
        if (txt) return txt.slice(0, 100);
      }
    }
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('name')) return el.getAttribute('name');
    const inner = (el.innerText || el.textContent || '').trim();
    return inner.slice(0, 100);
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['input', 'button', 'select', 'textarea', 'a'].includes(tag)) return true;
    if (el.getAttribute('role')) return true;
    if (el.getAttribute('onclick')) return true;
    if (el.getAttribute('tabindex')) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function hostSelector(el) {
    if (!el.id) return undefined;
    return '#' + el.id;
  }

  function walk(root, inShadow, hostSel) {
    const kids = inShadow ? Array.from(root.children) : Array.from(root.children);
    for (const el of kids) {
      if (visited.has(el)) continue;
      visited.add(el);
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'meta', 'link', 'head', 'title'].includes(tag)) continue;
      if (isInteractive(el) || (el.textContent || '').trim().length > 0) {
        const role = roleOf(el);
        const name = (nameOf(el) || '').trim();
        if (role || (el.tagName.toLowerCase() === 'a' && name)) {
          out.nodes.push({
            role,
            name,
            inShadow,
            hostSelector: hostSel,
            tag: el.tagName.toLowerCase(),
            ...(el.id ? { id: el.id } : {}),
          });
        }
      }
      const sr = el.shadowRoot;
      if (sr) {
        walk(sr, true, hostSelector(el));
      }
      walk(el, inShadow, hostSel);
    }
  }

  walk(document.body, false, undefined);
  return out;
})();
`

export namespace Refs {
  export function stash(session: string, snapshot: Snapshot): void {
    CACHE.set(session, snapshot)
  }

  export function lookup(session: string): Snapshot | undefined {
    return CACHE.get(session)
  }

  export function reset(session: string): void {
    CACHE.delete(session)
  }

  export function resolve(session: string, ref: string): { selector: string; entry: RefEntry } {
    const snap = CACHE.get(session)
    if (!snap) throw new Error(`no snapshot cached for session "${session}" — run snapshot first`)
    const entry = snap.refs.find((r) => r.ref === ref)
    if (!entry) throw new Error(`ref "${ref}" not in current snapshot`)
    if (!entry.selector) throw new Error(`ref "${ref}" has no resolvable selector`)
    return { selector: entry.selector, entry }
  }

  /**
   * Resolve a ref or selector to a Playwright ElementHandle.
   * Selectors may include the `>>` shadow-piercing operator
   * (e.g. `#shadow-host >> #shadow-pin`); refs always use the
   * selector captured at snapshot time, which is also a `>>` chain
   * when the element lives in a shadow root.
   */
  export async function refOrSelector(
    page: Page,
    session: string,
    ref: string | undefined,
    selector: string | undefined,
  ): Promise<ElementHandle | null> {
    if (ref) {
      const resolved = resolve(session, ref)
      return resolveLocator(page, resolved.selector)
    }
    if (selector) return resolveLocator(page, selector)
    throw new Error("must provide either --ref or --selector")
  }

  export async function capture(session: string, page: Page): Promise<Snapshot> {
    const result = (await page.evaluate(WALK_SCRIPT)) as WalkResult
    const refs: RefEntry[] = []
    for (const node of result.nodes) {
      const ref = "e" + result.counter.value++
      const redacted = redact(node.name, node.role ?? undefined)
      const entry: RefEntry = {
        ref,
        role: node.role ?? "",
        name: redacted,
        depth: 0,
      }
      const sel = buildSelector(node, redacted)
      if (sel) entry.selector = sel
      refs.push(entry)
    }
    const snapshot = renderTextTree(refs)
    const out: Snapshot = { snapshot, refs }
    stash(session, out)
    return out
  }
}

function buildSelector(node: WalkedNode & { tag?: string; id?: string }, redactedName: string): string | undefined {
  const roleSel = selectorForRole(node.role ?? undefined, redactedName)
  // For shadow DOM elements, prefer plain CSS — Playwright's locator
  // pierces open shadow roots automatically.
  if (node.inShadow) {
    if (node.id) return `#${node.id}`
    if (node.tag) return node.tag
    return roleSel
  }
  // For regular elements, prefer a stable id-based CSS selector when
  // available — it sidesteps the divergence between the snapshot's
  // computed "name" (we clean label `*` markers) and Playwright's
  // accessible-name calculation (which keeps them).
  if (node.id) return `#${node.id}`
  return roleSel
}

function renderTextTree(refs: RefEntry[]): string {
  return refs
    .map((r: RefEntry) => `- [ref=${r.ref}] [${r.role}] ${JSON.stringify(r.name)}`)
    .join("\n")
}

function resolveLocator(page: Page, selector: string): Promise<ElementHandle | null> {
  // page.$() only supports CSS selectors; role selectors require locator().
  // We always go through locator() to support both.
  if (selector.includes(">>")) {
    const parts = selector.split(">>").map((s) => s.trim())
    let loc = page.locator(parts[0]!).first()
    for (let i = 1; i < parts.length; i++) {
      loc = loc.locator(parts[i]!)
    }
    return loc.elementHandle()
  }
  return page.locator(selector).first().elementHandle()
}

const CACHE = new Map<string, Snapshot>()
void SnapshotEngine
