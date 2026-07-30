# Browser use for Kilo Code

**Status:** Implementation complete. Linux automated and manual verification passed; the existing Windows and macOS CI matrix provides the remaining platform confirmation.

**V1 scope:** A built-in `world` agent tool that automates Chromium through Playwright. Computer use and additional browser engines are explicitly out of scope for V1.

**Primary constraint:** Preserve Playwright's native protocol and full feature fidelity. Do not use `connectOverCDP()` as the product transport.

## 1. Goal

Ship reliable browser automation in the Kilo CLI and all clients that use its server, including Windows, Linux, macOS, VS Code, and Agent Manager sessions.

The implementation must:

- Keep browser work isolated from the main Kilo process.
- Preserve one browser daemon per Kilo session and its authenticated loopback HTTP boundary.
- Use Playwright's native browser protocol.
- Work in headless mode by default and support the existing headed-mode setting.
- Preserve session state across separate `world` tool calls.
- Package the daemon artifact with release builds.
- Leave a clean path to Firefox and WebKit in V2 without implementing them now.

## 2. Confirmed Windows failure and root cause

The original implementation reused the compiled Kilo executable as the daemon runtime. Because Kilo is compiled with Bun, Playwright also ran under Bun.

Windows debugging produced the following controlled result with Playwright 1.61.1 and the same Chromium build:

| Runtime | Result |
|---|---|
| Bun 1.3.14 | Chromium starts, Playwright sends `Browser.getVersion`, no protocol response arrives, and launch times out. |
| Node 25.3.0 | The protocol response arrives in about 45 ms and launch succeeds. |
| Node 22 | Launch succeeds. |
| Chromium outside Playwright | Starts and exposes its debugging endpoint successfully. |

Windows Defender reported no matching detection, Windows recorded no application crash, reinstalling Chromium did not help, and both the headless shell and full Chromium worked under Node.

This isolates the failure to Bun's Windows child-process handling for Playwright's extra anonymous stdio pipes. It is not caused by the website, Chromium installation, Playwright version, Node version, Kilo's HTTP daemon, or the Windows `windowsHide` option.

### Why Node is required

Playwright supports Node as its JavaScript runtime. Running the browser daemon under Node fixes the Windows pipe failure while retaining Playwright's native transport. It also avoids building V1 around Chromium-only CDP behavior that would obstruct Firefox and WebKit later.

## 3. V1 architecture

```text
Kilo CLI / Kilo server (Bun)
        |
        | authenticated loopback HTTP
        v
Per-session world daemon (Node)
        |
        | Playwright native browser protocol
        v
Chromium (headless by default)
```

The main CLI remains a Bun executable. Only the isolated world daemon moves to Node.

### Why keep the HTTP daemon boundary

- Browser state survives separate tool calls.
- Each Kilo session receives an isolated daemon and browser process.
- Abort and idle-timeout behavior do not block the main Kilo process.
- The random authentication token prevents unauthenticated local requests.
- Agent Manager worktrees can share the Kilo backend without sharing browser state between sessions.
- A future browser-engine option remains internal to the daemon.

## 4. Runtime and artifact resolution

The daemon is bundled as a self-contained Node-targeted CommonJS artifact, `world-daemon.cjs`, containing Playwright and all world commands. The explicit extension works consistently beside both ESM package metadata in development and the generated release package metadata.

The client resolves the daemon artifact in this order:

1. `KILO_WORLD_DAEMON_PATH`, for development and diagnostics.
2. `world-daemon.cjs` beside the packaged Kilo executable.
3. `world-daemon.cjs` beside the invoking script.
4. `packages/kilo-world/dist/world-daemon.cjs`, for repository development.

The client resolves Node in this order:

1. `KILO_WORLD_NODE`, for an explicit runtime override.
2. A packaged `node-runtime` beside Kilo, when present.
3. A `node` executable beside Kilo, when present.
4. `node` on `PATH`.

V1 must fail with an actionable error that includes the daemon paths attempted when the artifact or Node runtime cannot be found. It must never silently fall back to Bun on Windows.

## 5. Build and packaging

`packages/kilo-world/script/daemon.ts` owns bundling the daemon for Node. Both local package builds and the CLI release build use this one implementation.

The CLI build must:

1. Build `world-daemon.cjs` once.
2. Copy it beside every generated `kilo` executable.
3. Keep shared `packages/opencode/script/build.ts` changes inside the existing narrow `kilocode_change` integration block.
4. Smoke-test the current-platform packaged daemon, not only the main Kilo executable.

Every VS Code CLI copy path must treat `world-daemon.cjs` as a required sidecar. Local binary reuse, watch rebuilds, and production VSIX assembly must copy it beside `kilo` or `kilo.exe`; a cached or prebuilt binary without the daemon is incomplete and must be refreshed.

The prior special branch in shared `packages/opencode/src/index.ts` that made the Bun executable enter daemon mode is removed. The Node daemon has its own entry point and does not bootstrap the full CLI.

## 6. Current V1 tool surface

The model invokes one built-in tool call containing a semicolon-separated script. This is not a separate agent-facing CLI or MCP server.

```ts
world({ script: "navigate --url https://example.com ; snapshot" })
```

| Verb | Purpose |
|---|---|
| `status` | Report sessions, headless mode, and Chromium installation state. |
| `navigate` | Navigate and optionally wait for a selector. |
| `snapshot` | Capture the interactive DOM with stable references. |
| `click`, `type`, `fill`, `press-key` | Interact with controls. |
| `hover`, `drag`, `scroll` | Pointer and viewport interaction. |
| `screenshot` | Save and return a PNG or JPEG attachment. |
| `evaluate` | Evaluate JavaScript in the active page. |
| `wait-for` | Wait for a selector, text, or URL. |
| `tabs` | List, open, select, and close pages. |
| `cookies` | Read, set, and clear cookies. |
| `close`, `shutdown` | Close a context or the browser while retaining the daemon. |
| `daemon.start`, `daemon.status`, `daemon.stop` | Control daemon lifetime and idle timeout. |

`world` remains permission-aware, validates writable screenshot paths, and is enabled through the existing experimental browser setting.
Quoted script arguments preserve ordinary Windows path separators, so `screenshot --out "C:\\Users\\..."` writes to the requested absolute path after the tool-call JSON is decoded.
Snapshots return accessible element names unchanged, including names containing password, secret, PIN, OTP, token, or API-key terms; the browser layer does not redact snapshot text or screenshots.

## 7. Session and lifecycle requirements

- Concurrent first calls for one session must deduplicate daemon startup.
- Different Kilo sessions must receive different daemon PIDs and browser state.
- The daemon must bind only to `127.0.0.1` on a random port.
- Every request must carry the daemon's random authentication token.
- The daemon must inherit the configured world state directory.
- An idle timeout of `0` means no automatic shutdown.
- Aborting an active tool request must stop the active browser work.
- `daemon.stop` must close contexts and the browser, remove handshake state, and exit.
- Browser crashes must clear cached browser/context state so the next call can relaunch.
- Windows process creation must not flash a console window.
- Logs must identify daemon startup failures and report the log path to the caller.

`daemon.status` reports `runtime` and `runtimeVersion` so support logs can prove whether the daemon is running under Node.

## 8. Browser protocol decision

V1 continues to call `chromium.launch()` through Playwright.

Explicitly rejected as the main transport:

- Manually launching Chromium and attaching through `connectOverCDP()`.
- Chromium's one-shot `--screenshot` mode.
- A Windows-only CDP fallback.

Those approaches would avoid the failing pipe but reduce Playwright fidelity and make future Firefox/WebKit support require another architectural rewrite.

Selecting Playwright's `channel: "chromium"` is not a fix: it changes the Chromium executable but still uses the same anonymous pipe transport. Windows tests proved that both Chromium variants work under Node.

## 9. Browser-engine scope

### V1

- Chromium only.
- No browser-selection configuration or UI.
- No Firefox/WebKit downloads or tests.
- Keep browser-specific names in the existing public tool output to avoid unnecessary V1 refactoring.

### V2

- Evaluate a browser-engine configuration inside the Node daemon.
- Add Firefox and WebKit only after their command compatibility and packaging are tested.
- Preserve the same authenticated daemon and Playwright-native protocol boundary.

## 10. Tests

### Unit and integration

- Build the actual Node daemon bundle during the daemon test setup.
- Start it from the Bun test client using an explicit Node runtime.
- Assert `daemon.status.runtime === "node"`.
- Deduplicate concurrent startup.
- Reject an invalid daemon authentication token.
- Preserve state across calls.
- Isolate state and PIDs between sessions.
- Navigate, evaluate, snapshot, interact, and take screenshots using real Playwright.
- Abort an action already running in Chromium.
- Stop cleanly and remove PID and handshake files.
- Validate missing daemon and invalid runtime errors.

### Build and packaging

- Build `@kilocode/world` and confirm `dist/world-daemon.cjs` exists.
- Build the current-platform Kilo artifact and confirm `world-daemon.cjs` is beside `kilo`.
- Run the packaged daemon through Node.
- Run a browser navigation and screenshot through the packaged Kilo/world path.
- Check the packaged Kilo binary size and record the daemon size separately.

### Windows regression

Windows CI or a Windows manual release check must verify that:

1. The daemon reports `runtime: "node"`.
2. Playwright receives its first protocol response.
3. Chromium launches without a visible console window.
4. Navigation and screenshot complete.
5. Daemon and Chromium processes exit after `daemon.stop`.

`@kilocode/world` provides a `test:ci` task that installs the pinned Playwright Chromium and runs the real daemon/browser integration suite. The repository's existing non-CLI test matrix executes that task on Linux, macOS, and Windows, so the browser cases cannot silently skip because a runner lacks Chromium.

## 11. Required verification

From `packages/kilo-world/`:

```sh
bun run build
bun run typecheck
bun test
```

From `packages/opencode/`:

```sh
bun run typecheck
bun test test/kilocode/world-script.test.ts
bun run script/build.ts --single --skip-install
du -h dist/*/*/bin/kilo
```

From the repository root:

```sh
bun run script/check-opencode-annotations.ts --worktree
bun run script/check-opencode-promise-facades.ts
bun run script/check-md-table-padding.ts
```

Manual browser exercise:

```text
status ; navigate --url https://example.com ; snapshot ; screenshot --out <temporary-file> --full
daemon.status
daemon.stop
```

The manual check must inspect the screenshot and confirm that the daemon is gone afterward.

## 12. Acceptance criteria

- The Windows reproduction no longer times out.
- `world` uses Playwright's native protocol, not CDP attachment.
- The world daemon runs under Node and reports that fact.
- Source development and packaged CLI builds both locate the daemon.
- Chromium state remains isolated per Kilo session.
- Windows launches do not flash a console window.
- Browser and daemon processes clean up after stop and cancellation.
- Relevant tests, typechecks, build smoke tests, and repository guards pass.
- The release changeset describes the Node/Playwright daemon accurately.
- No Firefox, WebKit, or computer-use implementation is introduced in V1.

## 13. Computer use

Computer use remains explicitly out of scope. If resumed later, the reference implementation is Orca at `/home/aarav/apps/orca`, especially its platform helpers, permission handling, and redaction behavior. It is a separate workstream from browser-engine expansion.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Node is unavailable | Resolve explicit and packaged runtimes before `PATH`; return an actionable error. Packaging verification must cover each distributed client. |
| Daemon bundle is omitted from a release | Use one shared bundle helper and assert the artifact in the CLI build smoke test. |
| Bun accidentally becomes the daemon runtime again | Assert `runtime: "node"` in integration tests and Windows verification. |
| Browser remains after daemon shutdown | Track shutdown through Playwright and verify process cleanup manually and in integration tests. |
| Node bundle cannot locate Playwright's installed Chromium | Exercise the real bundled daemon against Chromium during tests and packaged smoke checks. |
| A clean install cannot bundle Playwright's static BiDi imports | Declare and lock `chromium-bidi` explicitly; clean Windows installs do not inherit the stale transitive copy that masked this dependency locally. |
| Shared opencode changes increase merge conflicts | Keep build integration in the existing marker block and remove the no-longer-needed shared runtime branch. |
| Future browser support forces a rewrite | Keep Playwright's native protocol and browser selection inside the isolated Node daemon. |

## 15. Confirmed decisions

1. V1 is Chromium-only browser automation.
2. Computer use is not part of V1.
3. The model uses the built-in `world` tool, not a separate CLI or MCP server.
4. The daemon remains per-session and communicates with Kilo over authenticated loopback HTTP.
5. Playwright runs under Node because Bun 1.3.14 fails its Windows browser pipes.
6. Browser control uses Playwright's native protocol; CDP attachment is rejected for the product path.
7. Firefox and WebKit are deferred to V2, but the Node/Playwright boundary must remain compatible with them.
