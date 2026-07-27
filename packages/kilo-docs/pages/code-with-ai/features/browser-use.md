---
title: "Browser Use"
description: "Using Kilo Code to interact with web browsers"
---

# Browser Use

Kilo Code provides browser automation as a first-class agent tool called `world`. The agent invokes it directly (no shell wrapping) with a `script` parameter — a `;`-separated sequence of browser actions that run in a shared Playwright session.

{% callout type="info" title="Model Support Required" %}
Browser Use requires an advanced agentic model. It is typically most reliable with recent high-capability models (for example Claude Sonnet 4 class models).
{% /callout %}

## How Browser Use Works

The `world` tool is implemented by the `@kilocode/world` package inside the Kilo CLI process. It launches a headless Chromium (via Playwright) and reuses one browser across actions in the same call. Computer use (driving the desktop) is **not implemented** in v1 — see `/home/aarav/apps/orca` for the future work.

The tool surfaces screenshots as image attachments, and a11y snapshots as plain text. The agent can ask the model to "navigate, snapshot, click, screenshot" in a single tool call.

## Quick start

Ask Kilo to drive a real browser. For example:

- `Browse https://kilocode.ai and report what services are listed.`
- `Open http://localhost:3000, scroll to the footer, and tell me if any links are broken.`
- `Visit the glow repo and capture a screenshot of its PR list.`

The agent will compose a `world` tool call like:

```json
{
  "script": "navigate --url https://github.com/charmbracelet/glow/pulls --wait '#repository-content' ; snapshot ; click --ref e5 ; screenshot --out /tmp/glow.png"
}
```

## Verb grammar

The `script` is parsed as a shell-like argv. Multiple actions share one browser session, so `navigate ; snapshot` re-uses the page from the navigate.

| Verb | Purpose |
|---|---|
| `status` | capability, sessions, chromium download state |
| `navigate --url <u> [--wait <sel>]` | goto URL; optional selector wait |
| `snapshot` | a11y tree with stable `[ref=eN]` ids |
| `click --ref <id> \| --selector <sel>` | click by ref (preferred) or selector |
| `type --text <s> [--ref <id> \| --selector <sel>]` | type into element or focused page |
| `fill --value <s> [--ref <id> \| --selector <sel>]` | replace input value |
| `press-key --chord <spec>` | key press or chord (e.g. `Control+a`) |
| `hover --ref <id> \| --selector <sel>` | hover |
| `drag --from <ref\|sel> --to <ref\|sel>` | drag between two targets |
| `scroll --ref <id> --dx 0 --dy 400` | scroll element or page |
| `screenshot --out <file> [--full] [--wait <ms>]` | write PNG; the tool returns it as an attachment |
| `evaluate --js <code>` | run JS in the page, return JSON value |
| `wait-for --selector <sel> \| --text <t> \| --url <u>` | wait for a condition |
| `tabs list / open / select / close` | tab management |
| `cookies get / set / clear` | cookie management |
| `close` | tear down the session |

Always prefer `snapshot` over `screenshot` — snapshots return stable `ref=eN` ids you can reuse. Use `screenshot` only when you need vision, and the tool will return the PNG as an image attachment you can look at directly.

## Settings

Browser-automation settings are available under the `kilo-code.new.world` namespace. These are read by the `world` tool at startup:

| Key | Default | Purpose |
|---|---|---|
| `kilo-code.new.world.enabled` | `true` | Master toggle. Off hides the tool from the model. |
| `kilo-code.new.world.browser.enabled` | `true` | Sub-toggle for browser verbs. |
| `kilo-code.new.world.browser.headless` | `true` | Run Chromium without a visible window. |
| `kilo-code.new.world.browser.antiDetect` | `false` | Inject the Playwright anti-detection init script. |

You can also set `executablePath` via the `browser.executablePath` key to use a system Chrome instead of the bundled Chromium.

{% callout type="warning" title="First run" %}
The first invocation may trigger a ~150 MB Chromium download. The `status` verb reports the download state — if Chromium is missing, run `npx playwright install chromium`.
{% /callout %}

## Permissions

The `world` tool requests `webfetch` permission for each URL it navigates to, and `external_directory` permission for any `--out <file>` paths the script writes. Most users will want to add a rule like `{"permission": "world", "action": "allow"}` to their agent config so the tool runs without prompting for every call.

