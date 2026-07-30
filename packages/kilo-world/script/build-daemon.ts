#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { WorldDaemon } from "./daemon"

const dir = path.resolve(import.meta.dirname, "../dist")
await fs.mkdir(dir, { recursive: true })
await fs.rm(path.join(dir, "world-daemon.js"), { force: true })
const file = await WorldDaemon.copy(await WorldDaemon.bundle(), dir)
console.log(`built ${file}`)
