// Streaming command output uses \r for in-place overwrites (e.g. progress
// counters, download bars). Convert each \r into a \n so each frame renders
// on its own line instead of being collapsed into a single terminal cursor
// return that overwrites prior visible content. \r\n is normalized first.
export function processCarriageReturns(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}
