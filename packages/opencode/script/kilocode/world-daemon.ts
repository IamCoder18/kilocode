import path from "node:path"

type BuildArtifact = Blob & { path?: string; kind?: string }

export namespace WorldDaemon {
  export const filename = "world-daemon.js"

  export type BundleResult = { entry: BuildArtifact; all: BuildArtifact[] }

  export async function bundle(): Promise<BundleResult> {
    // Bundle playwright + chromium-bidi INTO the daemon so it's self-contained.
    // Node's ESM resolver doesn't honor NODE_PATH or cwd, so leaving them as
    // external imports fails with "Cannot find package 'playwright'" at the
    // daemon's first launch. Bundling them in costs a few MB but the daemon
    // runs anywhere without any runtime dependency setup.
    const result = await Bun.build({
      entrypoints: ["../kilo-world/src/daemon/entry.ts"],
      target: "node",
      format: "esm",
      minify: true,
    })
    if (!result.success) {
      const details = result.logs.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")
      throw new Error(`Could not bundle kilo-world daemon:\n${details}`)
    }
    const outputs = result.outputs as BuildArtifact[]
    // The entry script is the one with `kind: "entry-point"` (or its path ends
    // with /entry.js). Additional outputs (native bindings like
    // fsevents-hj42pnne.node on darwin) sit alongside it.
    const entry =
      outputs.find((o) => o.kind === "entry-point") ??
      outputs.find((o) => o.path?.endsWith("/entry.js") || o.path?.endsWith("\\entry.js")) ??
      outputs[0]
    if (!entry) throw new Error("kilo-world daemon bundle produced no outputs")
    return { entry, all: outputs }
  }

  export async function copy(result: BundleResult, dir: string) {
    const target = path.join(dir, filename)
    await Bun.write(target, result.entry)
    for (const o of result.all) {
      const name = o.path ? path.basename(o.path) : null
      if (!name || name === filename) continue
      await Bun.write(path.join(dir, name), o)
    }
    console.log(`copied kilo-world daemon to ${target}`)
  }
}