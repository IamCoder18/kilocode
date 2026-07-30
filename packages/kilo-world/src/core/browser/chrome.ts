import { existsSync } from "node:fs"

const CANDIDATES: Record<NodeJS.Platform, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    `${process.env["HOME"]}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/google-chrome-beta",
    "/usr/bin/google-chrome-canary",
  ],
  aix: [],
  android: [],
  cygwin: [],
  freebsd: ["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/local/bin/google-chrome"],
  haiku: [],
  netbsd: [],
  openbsd: [],
  sunos: [],
}

export function findSystemChrome(): string | undefined {
  const os = process.platform
  const paths = CANDIDATES[os as NodeJS.Platform] ?? []
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return undefined
}
